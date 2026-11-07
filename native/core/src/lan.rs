//! The app's LAN web server: streams for cast receivers (`/cast/...`) and, later, the TV
//! page. One per app; it serves whichever playlist is active.

use crate::stream::{dlna_profile, upstream_length, LiveReader, VodReader};
use crate::Provider;
use std::io::Read;
use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, RwLock};
use tiny_http::{Header, Method, Request, Response, Server};

#[derive(uniffi::Object)]
pub struct LanServer {
    port: u16,
    provider: RwLock<Option<Arc<Provider>>>,
}

#[uniffi::export]
impl LanServer {
    /// Listens on `port` (or the next free one up to +20) on all interfaces.
    #[uniffi::constructor]
    pub fn new(port: u16) -> Arc<Self> {
        let (server, port) = (port..port.saturating_add(20))
            .find_map(|p| Server::http(("0.0.0.0", p)).ok().map(|s| (s, p)))
            .map(|(s, p)| (Some(s), p))
            .unwrap_or((None, 0));
        let me = Arc::new(Self { port, provider: RwLock::new(None) });
        if let Some(server) = server {
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

    /// The playlist streams are served from (None = nothing to serve).
    pub fn set_provider(&self, provider: Option<Arc<Provider>>) {
        *self.provider.write().unwrap() = provider;
    }

    /// 0 = could not listen.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://<our LAN IP>:<port>` as seen from `peer` (a TV's IP), or from the LAN in
    /// general when None.
    pub fn base_url(&self, peer: Option<String>) -> String {
        format!("http://{}:{}", lan_ip_for(peer.as_deref()).unwrap_or(IpAddr::from([127, 0, 0, 1])), self.port)
    }
}

/// Our address on the route to `peer` — the OS routing table picks the adapter the TV can
/// actually reach (v9 needed adapter-name filters for VPN/Hyper-V; routing does it for us).
/// ponytail: with no peer, the default route's address (a full-tunnel VPN would win there).
pub fn lan_ip_for(peer: Option<&str>) -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect((peer.unwrap_or("192.168.0.1"), 9)).or_else(|_| s.connect(("8.8.8.8", 9))).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

impl LanServer {
    fn handle(&self, req: Request) {
        let path = req.url().split('?').next().unwrap_or("").to_string();
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match parts.as_slice() {
            ["cast", kind, file] => self.cast(req, kind, file),
            _ => { let _ = req.respond(Response::empty(404)); }
        }
    }

    /// `/cast/<live|movie|series>/<id>.<ext>` — the provider URL is rebuilt here, so the TV
    /// gets a short, typed path (renderers truncate or can't sniff long query URLs -> 716).
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

        if live && ext != "m3u8" {
            match LiveReader::open(url) {
                Ok(r) => {
                    h.push(header("Accept-Ranges", "none"));
                    let _ = req.respond(Response::new(200.into(), h, r, None, None));
                }
                Err(code) => { let _ = req.respond(Response::empty(if code == 0 { 502 } else { code })); }
            }
            return;
        }
        if live {
            // HLS playlist for HLS-only receivers: one-shot passthrough.
            // ponytail: segment URLs stay the provider's (fine for DLNA/eShare; Chromecast step rewrites them).
            match ureq::get(&url).set("User-Agent", "VLC/3.0.20").call() {
                Ok(r) => { let _ = req.respond(Response::new(200.into(), h, r.into_reader(), None, None)); }
                Err(_) => { let _ = req.respond(Response::empty(502)); }
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
}
