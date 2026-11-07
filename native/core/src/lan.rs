//! The app's LAN web server (v9's "Smart TV Access" server, rebuilt in the core):
//!  - `/cast/...`  streams for DLNA / Chromecast receivers (and the TV page's player)
//!  - `/tv`        a light D-pad web app for TV browsers (Samsung Tizen, LG webOS, ...)
//!  - `/api/tv/*`  its JSON API, served from the catalog already in memory, so a weak TV
//!                 browser only ever downloads the rows it shows.
//! Recording from the TV runs here, on the PC.

use crate::recorder::Recorder;
use crate::stream::{dlna_profile, upstream_length, LiveReader, VodReader};
use crate::user::{UserStore, WatchProgress};
use crate::{ContentKind, Provider};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, RwLock};
use tiny_http::{Header, Method, Request, Response, Server};

#[derive(uniffi::Object)]
pub struct LanServer {
    port: u16,
    provider: RwLock<Option<Arc<Provider>>>,
    user: RwLock<Option<Arc<UserStore>>>,
    recorder: RwLock<Option<Arc<Recorder>>>,
    tmdb: RwLock<Option<Arc<crate::tmdb::Tmdb>>>,
    name: RwLock<String>,
}

#[uniffi::export]
impl LanServer {
    /// Listens on `port` (or the next free one up to +20) on all interfaces.
    #[uniffi::constructor]
    pub fn new(port: u16) -> Arc<Self> {
        // The public port is a tiny front that hangs up on TLS hellos: Chrome's "Always use
        // secure connections" tries https:// first and, against a plain HTTP server, waits
        // forever. A fast close makes it fall back (or show "Continue to site") at once.
        let server = Server::http("127.0.0.1:0").ok();
        let inner = server.as_ref().and_then(|s| s.server_addr().to_ip());
        let front = inner.and_then(|_| (port..port.saturating_add(20)).find_map(|p| TcpListener::bind(("0.0.0.0", p)).ok().map(|l| (l, p))));
        let port = front.as_ref().map_or(0, |f| f.1);
        let me = Arc::new(Self {
            port, provider: RwLock::new(None), user: RwLock::new(None), recorder: RwLock::new(None), tmdb: RwLock::new(None), name: RwLock::new(String::new()),
        });
        if let (Some(server), Some((front, _)), Some(inner)) = (server, front, inner) {
            std::thread::Builder::new().name("lan-front".into()).spawn(move || {
                for c in front.incoming().flatten() {
                    std::thread::spawn(move || splice(c, inner));
                }
            }).ok();
            let me2 = me.clone();
            std::thread::Builder::new().name("lan-server".into()).spawn(move || {
                for req in server.incoming_requests() {
                    let me = me2.clone();
                    std::thread::spawn(move || me.handle(req));
                }
            }).ok();
        }
        me
    }

    /// The active playlist: its catalog, the user's progress/favorites, its display name.
    pub fn set_provider(&self, provider: Option<Arc<Provider>>, user: Option<Arc<UserStore>>, name: String) {
        *self.provider.write().unwrap() = provider;
        *self.user.write().unwrap() = user;
        *self.name.write().unwrap() = name;
    }

    /// Recordings started from the TV page run on this recorder (the PC's).
    pub fn set_recorder(&self, recorder: Option<Arc<Recorder>>) {
        *self.recorder.write().unwrap() = recorder;
    }

    /// TMDB for the TV page's details (backdrop, plot, cast). Same cache as the app.
    pub fn set_tmdb(&self, tmdb: Option<Arc<crate::tmdb::Tmdb>>) {
        *self.tmdb.write().unwrap() = tmdb;
    }

    /// 0 = could not listen.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://<our LAN IP>:<port>` as seen from `peer` (a TV's IP), or from the LAN in general.
    pub fn base_url(&self, peer: Option<String>) -> String {
        format!("http://{}:{}", lan_ip_for(peer.as_deref()).unwrap_or(IpAddr::from([127, 0, 0, 1])), self.port)
    }

    /// The address to type into the TV's browser.
    pub fn tv_url(&self) -> Option<String> {
        (self.port != 0).then(|| format!("{}/tv", self.base_url(None)))
    }
}

/// Our address on the route to `peer`: the OS routing table picks the adapter the TV can
/// reach (v9 needed adapter-name filters for VPN/Hyper-V; routing does it for us).
/// ponytail: with no peer, the default route's address (a full-tunnel VPN would win there).
pub fn lan_ip_for(peer: Option<&str>) -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect((peer.unwrap_or("192.168.0.1"), 9)).or_else(|_| s.connect(("8.8.8.8", 9))).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

/// Pipes one LAN connection to the loopback HTTP server, unless it opens with a TLS hello.
fn splice(mut c: TcpStream, inner: SocketAddr) {
    let mut b = [0u8; 1];
    let _ = c.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    if c.peek(&mut b).ok() != Some(1) || b[0] == 0x16 { return; }
    let _ = c.set_read_timeout(None);
    let Ok(mut u) = TcpStream::connect(inner) else { return };
    let _ = (c.set_nodelay(true), u.set_nodelay(true));
    let (Ok(mut c2), Ok(mut u2)) = (c.try_clone(), u.try_clone()) else { return };
    std::thread::spawn(move || { let _ = std::io::copy(&mut c2, &mut u2); let _ = u2.shutdown(Shutdown::Write); });
    let _ = std::io::copy(&mut u, &mut c);
    let _ = c.shutdown(Shutdown::Both);
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn pct_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    Ok(v) => { out.push(v); i += 3; continue; }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(url: &str) -> Vec<(String, String)> {
    url.split_once('?').map(|(_, q)| q.split('&').filter_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        Some((pct_decode(k), pct_decode(v)))
    }).collect()).unwrap_or_default()
}

/// Rewrite an HLS playlist so every URI goes through `/cast/seg` (absolute provider URL,
/// CORS headers added): Chromecast's receiver and TV browsers can't fetch the provider directly.
fn rewrite_m3u8(text: &str, base: &str) -> String {
    let origin = base.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
    let dir = &base[..base.rfind('/').map(|i| i + 1).unwrap_or(base.len())];
    let abs = |u: &str| -> String {
        if u.starts_with("http://") || u.starts_with("https://") { u.to_string() }
        else if u.starts_with('/') { format!("{origin}{u}") }
        else { format!("{dir}{u}") }
    };
    let via = |u: &str| format!("/cast/seg?u={}", pct_encode(&abs(u)));
    text.lines().map(|l| {
        let t = l.trim();
        if t.is_empty() { String::new() }
        else if !t.starts_with('#') { via(t) }
        else if let Some(i) = t.find("URI=\"") {
            let rest = &t[i + 5..];
            let end = rest.find('"').unwrap_or(rest.len());
            format!("{}URI=\"{}\"{}", &t[..i], via(&rest[..end]), rest.get(end + 1..).unwrap_or(""))
        } else { t.to_string() }
    }).collect::<Vec<_>>().join("\n")
}

const TV_HTML: &str = include_str!("tv/index.html");
const TV_JS: &str = include_str!("tv/app.js");
const TV_CSS: &str = include_str!("tv/app.css");
// Player engines ship with the app: no CDN round trip from the TV before the first frame.
const HLS_JS: &str = include_str!("tv/vendor/hls.light.min.js");
const MPEGTS_JS: &str = include_str!("tv/vendor/mpegts.js");

impl LanServer {
    fn handle(&self, req: Request) {
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match parts.as_slice() {
            ["cast", "seg"] => self.segment(req, &url),
            ["cast", kind, file] => self.cast(req, kind, file),
            [""] | ["tv"] | ["tv", ""] => text(req, TV_HTML, "text/html; charset=utf-8"),
            ["tv", "app.js"] => text(req, TV_JS, "application/javascript; charset=utf-8"),
            ["tv", "app.css"] => text(req, TV_CSS, "text/css; charset=utf-8"),
            ["tv", "hls.js"] => cached(req, HLS_JS),
            ["tv", "mpegts.js"] => cached(req, MPEGTS_JS),
            ["api", "tv", rest @ ..] => self.api(req, &rest.join("/"), &url),
            ["rec", id] => self.recording(req, &pct_decode(id)),
            _ => { let _ = req.respond(Response::empty(404)); }
        }
    }

    /// `/cast/<live|movie|series>/<id>.<ext>`: the provider URL is rebuilt here, so the TV gets
    /// a short, typed path (renderers truncate or can't sniff long query URLs -> UPnP 716).
    fn cast(&self, req: Request, kind: &str, file: &str) {
        let Some(p) = self.provider.read().unwrap().clone() else {
            let _ = req.respond(Response::empty(503));
            return;
        };
        let (id, ext) = file.rsplit_once('.').unwrap_or((file, ""));
        let (id, ext) = (id.to_string(), ext.to_ascii_lowercase());
        let live = kind == "live";
        let url = match kind {
            "live" => {
                let u = p.live_url(id);
                if ext == "m3u8" && u.ends_with(".ts") { format!("{}.m3u8", &u[..u.len() - 3]) } else { u }
            }
            "movie" => p.movie_url(id, Some(ext.clone())),
            "series" => p.episode_url(id, Some(ext.clone())),
            _ => { let _ = req.respond(Response::empty(404)); return; }
        };
        let (mime, features) = dlna_profile(live, &ext);
        let mut h = vec![
            header("Content-Type", mime),
            header("transferMode.dlna.org", "Streaming"),
            header("contentFeatures.dlna.org", &features),
            header("Access-Control-Allow-Origin", "*"),
        ];

        // Renderers HEAD-probe first: answer with headers only, never open the stream
        // (or the HEAD hangs and the TV reports 716). VOD needs its length.
        if *req.method() == Method::Head {
            h.push(header("Accept-Ranges", if live { "none" } else { "bytes" }));
            let len = if live { None } else { upstream_length(&url) };
            let _ = req.respond(Response::new(200.into(), h, std::io::empty(), len.map(|l| l as usize), None));
            return;
        }
        if live && ext == "m3u8" {
            return self.playlist(req, &url);
        }
        if live {
            match LiveReader::open(url) {
                Ok(r) => {
                    h.push(header("Accept-Ranges", "none"));
                    let _ = req.respond(Response::new(200.into(), h, r, None, None));
                }
                Err(code) => { let _ = req.respond(Response::empty(if code == 0 { 502 } else { code })); }
            }
            return;
        }
        let range = req.headers().iter().find(|x| x.field.equiv("Range")).map(|x| x.value.as_str().to_string());
        match VodReader::open(url, range.as_deref()) {
            Ok((r, head)) => {
                if let Some(cr) = &head.content_range { h.push(header("Content-Range", cr)); }
                h.push(header("Accept-Ranges", "bytes"));
                let body: Box<dyn Read + Send> = Box::new(r);
                let _ = req.respond(Response::new(head.status.into(), h, body, head.content_length.map(|l| l as usize), None));
            }
            Err(code) => { let _ = req.respond(Response::empty(if code == 0 { 502 } else { code })); }
        }
    }

    /// An HLS playlist, rewritten to route through `/cast/seg`.
    fn playlist(&self, req: Request, url: &str) {
        match ureq::get(url).set("User-Agent", "VLC/3.0.20").timeout(std::time::Duration::from_secs(15)).call() {
            Ok(r) => {
                let base = r.get_url().to_string();
                let body = rewrite_m3u8(&r.into_string().unwrap_or_default(), &base);
                let h = vec![header("Content-Type", "application/vnd.apple.mpegurl"), header("Access-Control-Allow-Origin", "*"),
                    header("Cache-Control", "no-cache")];
                let _ = req.respond(Response::from_string(body).with_status_code(200).with_header(h[0].clone()).with_header(h[1].clone()).with_header(h[2].clone()));
            }
            Err(ureq::Error::Status(code, _)) => { let _ = req.respond(Response::empty(code)); }
            Err(_) => { let _ = req.respond(Response::empty(502)); }
        }
    }

    /// `/cast/seg?u=<provider url>`: a segment (or nested playlist) with CORS.
    /// ponytail: open proxy for any URL a LAN client names; it only ever runs on the home LAN.
    fn segment(&self, req: Request, url: &str) {
        let Some(u) = query(url).into_iter().find(|(k, _)| k == "u").map(|(_, v)| v) else {
            let _ = req.respond(Response::empty(400));
            return;
        };
        if !(u.starts_with("http://") || u.starts_with("https://")) { let _ = req.respond(Response::empty(400)); return; }
        if u.split('?').next().unwrap_or("").ends_with(".m3u8") { return self.playlist(req, &u); }
        match ureq::get(&u).set("User-Agent", "VLC/3.0.20").timeout(std::time::Duration::from_secs(20)).call() {
            Ok(r) => {
                let ct = r.header("content-type").unwrap_or("video/mp2t").to_string();
                let len = r.header("content-length").and_then(|l| l.parse::<usize>().ok());
                let h = vec![header("Content-Type", &ct), header("Access-Control-Allow-Origin", "*")];
                let _ = req.respond(Response::new(200.into(), h, r.into_reader(), len, None));
            }
            Err(ureq::Error::Status(code, _)) => { let _ = req.respond(Response::empty(code)); }
            Err(_) => { let _ = req.respond(Response::empty(502)); }
        }
    }

    /// A finished recording (a .ts file on this PC) for the TV page's player.
    fn recording(&self, req: Request, id: &str) {
        let path = self.recorder.read().unwrap().as_ref().and_then(|r| r.list().into_iter().find(|x| x.id == id)).map(|x| x.path);
        match path.and_then(|p| std::fs::File::open(p).ok()) {
            Some(f) => { let _ = req.respond(Response::from_file(f).with_header(header("Content-Type", "video/mp2t"))); }
            None => { let _ = req.respond(Response::empty(404)); }
        }
    }

    fn api(&self, mut req: Request, route: &str, url: &str) {
        let q = query(url);
        let arg = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
        let num = |k: &str, d: usize| arg(k).parse().unwrap_or(d);
        let Some(p) = self.provider.read().unwrap().clone() else { return json_out(req, 503, json!({ "error": "No playlist on the PC" })) };
        let user = self.user.read().unwrap().clone();
        let body = if *req.method() == Method::Post {
            let mut s = String::new();
            let _ = req.as_reader().take(1 << 20).read_to_string(&mut s);
            serde_json::from_str::<Value>(&s).unwrap_or(Value::Null)
        } else { Value::Null };

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let out = match route {
            "info" => json!({ "name": *self.name.read().unwrap(), "recording": self.recorder.read().unwrap().is_some() }),
            "home" => {
                let u = user.as_ref();
                json!({
                    "continue": u.map(|u| u.continue_watching()).unwrap_or_default(),
                    "favorites": p.channels_by_ids(u.map(|u| u.favorites(ContentKind::Live)).unwrap_or_default()).iter().map(chan).collect::<Vec<_>>(),
                    "recent": p.channels_by_ids(u.map(|u| u.recent()).unwrap_or_default()).iter().map(chan).collect::<Vec<_>>(),
                    "movies": p.recently_added_movies(24).iter().map(movie).collect::<Vec<_>>(),
                    "series": p.recently_added_series(24).iter().map(series).collect::<Vec<_>>(),
                })
            }
            "meta" => {
                let kind = if arg("kind") == "series" { ContentKind::Series } else { ContentKind::Movie };
                let year = Some(arg("year")).filter(|y| !y.is_empty());
                json!(self.tmdb.read().unwrap().clone().and_then(|t| t.lookup(kind, arg("title"), year)))
            }
            "categories" => json!(p.categories(ContentKind::Live).iter().map(|c| json!({ "id": c.id, "name": c.name, "count": c.count })).collect::<Vec<_>>()),
            "channels" => {
                let cat = arg("cat");
                let list = p.channels(if cat.is_empty() { None } else { Some(cat) });
                let (off, lim) = (num("offset", 0), num("limit", 60).min(200));
                // No guide here: its first download can take ~30 s. The page asks /nows afterwards.
                json!({ "total": list.len(), "items": list.iter().skip(off).take(lim).map(chan).collect::<Vec<_>>() })
            }
            "nows" => {
                let m: serde_json::Map<String, Value> = arg("ids").split(',').filter(|i| !i.is_empty()).take(200).filter_map(|id| {
                    p.epg(id.to_string()).into_iter().find(|e| e.end > now && e.start <= now).map(|e| (id.to_string(), json!(e.title)))
                }).collect();
                Value::Object(m)
            }
            "epg" => json!(p.epg(arg("id")).into_iter().filter(|e| e.end > now).take(12)
                .map(|e| json!({ "title": e.title, "desc": e.description, "start": e.start, "end": e.end })).collect::<Vec<_>>()),
            "movies" | "series" => {
                let (off, lim) = (num("offset", 0), num("limit", 48).min(200));
                if route == "movies" {
                    let mut l = p.movies(None); l.sort_by(|a, b| b.added.cmp(&a.added));
                    json!({ "total": l.len(), "items": l.iter().skip(off).take(lim).map(movie).collect::<Vec<_>>() })
                } else {
                    let mut l = p.series(None); l.sort_by(|a, b| b.added.cmp(&a.added));
                    json!({ "total": l.len(), "items": l.iter().skip(off).take(lim).map(series).collect::<Vec<_>>() })
                }
            }
            "episodes" => match p.episodes(arg("id")) {
                Ok(eps) => json!(eps.iter().map(|e| json!({
                    "id": e.id, "season": e.season, "number": e.number, "title": e.title, "plot": e.plot, "image": e.image,
                    "ext": e.extension, "duration": e.duration_secs,
                    "progress": user.as_ref().and_then(|u| u.progress(format!("episode:{}", e.id))).map(|w| json!({ "pos": w.position_ms, "dur": w.duration_ms })),
                })).collect::<Vec<_>>()),
                Err(e) => json!({ "error": e.to_string() }),
            },
            "progress" => {
                let key = arg("key");
                json!(user.as_ref().and_then(|u| u.progress(key)))
            }
            "search" => {
                let r = p.search(arg("q"), 30);
                json!({ "channels": r.channels.iter().map(chan).collect::<Vec<_>>(), "movies": r.movies.iter().map(movie).collect::<Vec<_>>(),
                        "series": r.series.iter().map(series).collect::<Vec<_>>() })
            }
            "save-progress" => {
                if let (Some(u), Ok(w)) = (&user, serde_json::from_value::<WatchProgress>(body)) { u.set_progress(w); }
                json!({ "ok": true })
            }
            "favorite" => json!({ "on": user.as_ref().map(|u| u.toggle_favorite(ContentKind::Live, arg("id"))).unwrap_or(false) }),
            "watched" => { if let Some(u) = &user { u.add_recent(arg("id")); } json!({ "ok": true }) }
            "record" => {
                let Some(rec) = self.recorder.read().unwrap().clone() else { return json_out(req, 400, json!({ "error": "Recording isn't available" })) };
                let id = arg("id");
                let ch = p.channels_by_ids(vec![id.clone()]).into_iter().next();
                let name = ch.as_ref().map(|c| c.name.clone()).unwrap_or_default();
                let prog = p.epg(id.clone()).into_iter().find(|e| e.start <= now && e.end > now);
                let (title, end) = prog.map(|e| (e.title, e.end)).unwrap_or_else(|| (name.clone(), now + 3600));
                // Same live URL the PC app records from (stream format respected via the provider).
                let rid = rec.record(p.live_url(id), title.clone(), name, now, end);
                json!({ "id": rid, "title": title, "until": end })
            }
            "recordings" => json!(self.recorder.read().unwrap().as_ref().map(|r| r.list()).unwrap_or_default()),
            "stop-recording" => { if let Some(r) = self.recorder.read().unwrap().as_ref() { r.stop(arg("id")); } json!({ "ok": true }) }
            _ => return json_out(req, 404, json!({ "error": "unknown" })),
        };
        json_out(req, 200, out)
    }
}

fn chan(c: &crate::Channel) -> Value { json!({ "id": c.stream_id, "name": c.name, "logo": c.logo.as_ref().or(c.alt_logo.as_ref()), "cat": c.category_id }) }
fn movie(m: &crate::Movie) -> Value { json!({ "id": m.stream_id, "name": m.name, "poster": m.poster, "year": m.year, "rating": m.rating, "ext": m.extension }) }
fn series(s: &crate::Series) -> Value { json!({ "id": s.series_id, "name": s.name, "poster": s.cover, "year": s.year, "rating": s.rating }) }

fn text(req: Request, body: &'static str, ct: &str) {
    let _ = req.respond(Response::from_string(body).with_header(header("Content-Type", ct)).with_header(header("Cache-Control", "no-cache")));
}

fn cached(req: Request, body: &'static str) {
    let _ = req.respond(Response::from_string(body).with_header(header("Content-Type", "application/javascript; charset=utf-8"))
        .with_header(header("Cache-Control", "public, max-age=604800")));
}

fn json_out(req: Request, code: u16, v: Value) {
    let _ = req.respond(Response::from_string(v.to_string()).with_status_code(code)
        .with_header(header("Content-Type", "application/json")).with_header(header("Access-Control-Allow-Origin", "*")));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m3u8_rewrite_and_query() {
        let src = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6,\nseg1.ts\n/abs/seg2.ts\nhttp://cdn/x.ts?a=1\n";
        let out = rewrite_m3u8(src, "http://h:8080/live/u/p/1.m3u8");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "#EXT-X-KEY:METHOD=AES-128,URI=\"/cast/seg?u=http%3A%2F%2Fh%3A8080%2Flive%2Fu%2Fp%2Fkey.bin\"");
        assert_eq!(lines[3], "/cast/seg?u=http%3A%2F%2Fh%3A8080%2Flive%2Fu%2Fp%2Fseg1.ts");
        assert_eq!(lines[4], "/cast/seg?u=http%3A%2F%2Fh%3A8080%2Fabs%2Fseg2.ts");
        let q = query(&format!("/x?{}", lines[5].split('?').nth(1).unwrap()));
        assert_eq!(q[0].1, "http://cdn/x.ts?a=1");
    }
}
