//! Google Cast (Chromecast, Google/Android TV, "Chromecast built-in" TVs): mDNS discovery
//! and the CASTV2 protocol (length-prefixed protobuf over TLS :8009) driving Google's
//! Default Media Receiver. v9 used the `chromecasts` npm package; this is the same flow.
//! Receivers fetch from our LanServer: live as HLS (/cast/live/<id>.m3u8, segments proxied
//! with CORS), VOD as the file itself.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
}

// ---------------------------------------------------------------- mDNS discovery

fn dns_name(buf: &[u8], mut pos: usize) -> Option<(String, usize)> {
    let mut labels = vec![];
    let mut end = None;
    for _ in 0..64 {
        let len = *buf.get(pos)? as usize;
        if len == 0 { pos += 1; break; }
        if len & 0xC0 == 0xC0 {
            let ptr = ((len & 0x3F) << 8) | *buf.get(pos + 1)? as usize;
            if end.is_none() { end = Some(pos + 2); }
            pos = ptr;
            continue;
        }
        labels.push(String::from_utf8_lossy(buf.get(pos + 1..pos + 1 + len)?).into_owned());
        pos += 1 + len;
    }
    Some((labels.join("."), end.unwrap_or(pos)))
}

#[derive(Default)]
struct Found { srv: HashMap<String, (u16, String)>, txt: HashMap<String, HashMap<String, String>>, a: HashMap<String, IpAddr>, ptr: Vec<String> }

fn parse_mdns(buf: &[u8], f: &mut Found) -> Option<()> {
    let u16at = |i: usize| -> Option<u16> { Some(u16::from_be_bytes([*buf.get(i)?, *buf.get(i + 1)?])) };
    let (qd, an, ns, ar) = (u16at(4)?, u16at(6)?, u16at(8)?, u16at(10)?);
    let mut pos = 12;
    for _ in 0..qd { pos = dns_name(buf, pos)?.1 + 4; }
    for _ in 0..(an as u32 + ns as u32 + ar as u32) {
        let (name, p) = dns_name(buf, pos)?;
        let (ty, rdlen) = (u16at(p)?, u16at(p + 8)? as usize);
        let rd = p + 10;
        match ty {
            12 => { let (target, _) = dns_name(buf, rd)?; if target.contains("_googlecast") || name.contains("_googlecast") { f.ptr.push(target) } }
            33 => { let (target, _) = dns_name(buf, rd + 6)?; f.srv.insert(name, (u16at(rd + 4)?, target)); }
            16 => {
                let mut kv = HashMap::new();
                let mut i = rd;
                while i < rd + rdlen {
                    let l = *buf.get(i)? as usize;
                    if let Some((k, v)) = String::from_utf8_lossy(buf.get(i + 1..i + 1 + l)?).split_once('=') { kv.insert(k.to_string(), v.to_string()); }
                    i += 1 + l;
                }
                f.txt.insert(name, kv);
            }
            1 if rdlen == 4 => { f.a.insert(name, IpAddr::from([buf[rd], buf[rd + 1], buf[rd + 2], buf[rd + 3]])); }
            _ => {}
        }
        pos = rd + rdlen;
    }
    Some(())
}

/// One-shot mDNS query (from a random port, so devices answer us by unicast).
pub fn discover(wait: Duration) -> Vec<Device> {
    let mut q = vec![0u8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for l in ["_googlecast", "_tcp", "local"] { q.push(l.len() as u8); q.extend_from_slice(l.as_bytes()); }
    q.extend_from_slice(&[0, 0, 12, 0x80, 1]); // PTR, IN with unicast-response bit
    let mut socks = vec![];
    if let Some(ip) = crate::lan::lan_ip_for(None) { if let Ok(s) = UdpSocket::bind((ip, 0)) { socks.push(s) } }
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") { socks.push(s) }
    for s in &socks {
        let _ = s.set_read_timeout(Some(Duration::from_millis(150)));
        let _ = s.send_to(&q, "224.0.0.251:5353");
    }
    let mut f = Found::default();
    let mut from: HashMap<String, IpAddr> = HashMap::new(); // instance -> responder address (fallback for A)
    let end = Instant::now() + wait;
    let mut buf = [0u8; 4096];
    while Instant::now() < end {
        for s in &socks {
            if let Ok((n, addr)) = s.recv_from(&mut buf) {
                let before: Vec<String> = f.ptr.clone();
                let _ = parse_mdns(&buf[..n], &mut f);
                for p in f.ptr.iter().filter(|p| !before.contains(p)) { from.insert(p.clone(), addr.ip()); }
            }
        }
    }
    let mut out: Vec<Device> = vec![];
    for inst in &f.ptr {
        let txt = f.txt.get(inst);
        let (port, target) = f.srv.get(inst).cloned().unwrap_or((8009, String::new()));
        let Some(ip) = f.a.get(&target).copied().or_else(|| from.get(inst).copied()) else { continue };
        let id = txt.and_then(|t| t.get("id").cloned()).unwrap_or_else(|| inst.clone());
        if out.iter().any(|d| d.id == id) { continue }
        let name = txt.and_then(|t| t.get("fn").cloned()).unwrap_or_else(|| inst.split("._googlecast").next().unwrap_or(inst).to_string());
        out.push(Device { id, name, host: ip.to_string(), port });
    }
    out
}

// ---------------------------------------------------------------- CASTV2

const NS_CONN: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEART: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECV: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
const DEFAULT_RECEIVER: &str = "CC1AD845";

fn varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 { out.push((v as u8) | 0x80); v >>= 7; }
    out.push(v as u8);
}

/// CastMessage protobuf, length-prefixed.
fn frame(src: &str, dst: &str, ns: &str, payload: &Value) -> Vec<u8> {
    let p = payload.to_string();
    let mut m = vec![0x08, 0x00];
    for (tag, s) in [(0x12u8, src), (0x1a, dst), (0x22, ns)] { m.push(tag); varint(s.len() as u64, &mut m); m.extend_from_slice(s.as_bytes()); }
    m.extend_from_slice(&[0x28, 0x00, 0x32]);
    varint(p.len() as u64, &mut m);
    m.extend_from_slice(p.as_bytes());
    let mut out = (m.len() as u32).to_be_bytes().to_vec();
    out.extend(m);
    out
}

/// (namespace, payload json) of one CastMessage body.
fn unframe(b: &[u8]) -> Option<(String, Value)> {
    let (mut i, mut ns, mut payload) = (0, String::new(), Value::Null);
    while i < b.len() {
        let key = b[i]; i += 1;
        let (field, wire) = (key >> 3, key & 7);
        let mut v = 0u64; let mut shift = 0;
        loop { let x = *b.get(i)?; i += 1; v |= ((x & 0x7f) as u64) << shift; if x < 0x80 { break } shift += 7; }
        if wire == 2 {
            let s = b.get(i..i + v as usize)?; i += v as usize;
            match field { 4 => ns = String::from_utf8_lossy(s).into_owned(), 6 => payload = serde_json::from_slice(s).unwrap_or(Value::Null), _ => {} }
        }
    }
    Some((ns, payload))
}

#[derive(Default, Clone)]
pub struct Status {
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
    media_session: Option<i64>,
    transport: Option<String>,
    session: Option<String>,
    error: Option<String>,
}

enum Cmd { Media(Value), Receiver(Value), Close }

/// A live connection to one receiver, playing one item.
pub struct Session {
    tx: Sender<Cmd>,
    pub status: Arc<Mutex<Status>>,
}

#[derive(Debug)]
struct AnyCert(Arc<rustls::crypto::CryptoProvider>);
impl rustls::client::danger::ServerCertVerifier for AnyCert {
    // Cast devices present self-signed certificates; the LAN device is the trust anchor (as in every Cast sender).
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime)
        -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> { Ok(rustls::client::danger::ServerCertVerified::assertion()) }
    fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct)
        -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> { Ok(rustls::client::danger::HandshakeSignatureValid::assertion()) }
    fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct)
        -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> { Ok(rustls::client::danger::HandshakeSignatureValid::assertion()) }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> { self.0.signature_verification_algorithms.supported_schemes() }
}

/// Fire TV sticks show up as "[Cast]" devices but never complete a session (Amazon blocks Cast).
fn looks_like_fire_tv(name: &str) -> bool {
    name.contains("[Cast]") || name.to_ascii_uppercase().starts_with("AFT")
}

impl Session {
    /// Connect, launch the Default Media Receiver and LOAD `url`. Blocks until playback
    /// starts or fails (15 s).
    pub fn play(d: &Device, url: &str, mime: &str, live: bool, title: &str) -> Result<Session, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
            .dangerous().with_custom_certificate_verifier(Arc::new(AnyCert(provider)))
            .with_no_client_auth();
        let addr = SocketAddr::new(d.host.parse().map_err(|_| "bad address")?, d.port);
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("{} unreachable: {e}", d.name))?;
        let name = rustls::pki_types::ServerName::try_from(d.host.clone()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(Arc::new(cfg), name).map_err(|e| e.to_string())?;
        let mut tls = rustls::StreamOwned::new(conn, tcp);
        tls.sock.set_read_timeout(Some(Duration::from_millis(250))).ok();

        let status = Arc::new(Mutex::new(Status::default()));
        let (tx, rx) = channel();
        let load = json!({
            "type": "LOAD", "autoplay": true,
            "media": { "contentId": url, "contentType": mime, "streamType": if live { "LIVE" } else { "BUFFERED" },
                       "metadata": { "metadataType": 0, "title": title } }
        });
        let st = status.clone();
        std::thread::Builder::new().name("chromecast".into()).spawn(move || run(&mut tls, rx, st, load)).map_err(|e| e.to_string())?;

        let start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let s = status.lock().unwrap().clone();
            if let Some(e) = s.error { let _ = tx.send(Cmd::Close); return Err(e); }
            if s.media_session.is_some() { return Ok(Session { tx, status }); }
            if start.elapsed() > Duration::from_secs(15) {
                let _ = tx.send(Cmd::Close);
                return Err(if looks_like_fire_tv(&d.name) {
                    format!("{} looks like a Fire TV, which can't receive casts (Amazon blocks Google Cast). Install the app on it instead.", d.name)
                } else { format!("{} didn't respond", d.name) });
            }
        }
    }

    pub fn pause(&self) { self.media("PAUSE", json!({})) }
    pub fn resume(&self) { self.media("PLAY", json!({})) }
    pub fn seek(&self, secs: f64) { self.media("SEEK", json!({ "currentTime": secs })) }
    pub fn volume(&self, level: f64) { let _ = self.tx.send(Cmd::Receiver(json!({ "type": "SET_VOLUME", "volume": { "level": level.clamp(0.0, 1.0) } }))); }
    pub fn stop(&self) {
        let session = self.status.lock().unwrap().session.clone();
        if let Some(s) = session { let _ = self.tx.send(Cmd::Receiver(json!({ "type": "STOP", "sessionId": s }))); }
        std::thread::sleep(Duration::from_millis(300));
        let _ = self.tx.send(Cmd::Close);
    }
    fn media(&self, ty: &str, mut extra: Value) {
        extra["type"] = json!(ty);
        let _ = self.tx.send(Cmd::Media(extra));
    }
}

fn run(tls: &mut rustls::StreamOwned<rustls::ClientConnection, TcpStream>, rx: Receiver<Cmd>, st: Arc<Mutex<Status>>, load: Value) {
    let mut req = 1i64;
    let mut next = |v: &mut Value| { req += 1; v["requestId"] = json!(req); };
    let send = |tls: &mut rustls::StreamOwned<rustls::ClientConnection, TcpStream>, dst: &str, ns: &str, v: &Value| {
        tls.write_all(&frame("sender-0", dst, ns, v)).is_ok()
    };
    let fail = |st: &Arc<Mutex<Status>>, e: String| { st.lock().unwrap().error = Some(e); };

    send(tls, "receiver-0", NS_CONN, &json!({ "type": "CONNECT" }));
    let mut launch = json!({ "type": "LAUNCH", "appId": DEFAULT_RECEIVER });
    next(&mut launch);
    if !send(tls, "receiver-0", NS_RECV, &launch) { return fail(&st, "Cast connection failed".into()); }

    let mut buf: Vec<u8> = vec![];
    let mut chunk = [0u8; 8192];
    let mut load = Some(load);
    let (mut last_ping, mut last_poll) = (Instant::now(), Instant::now());
    loop {
        while let Ok(cmd) = rx.try_recv() {
            let s = st.lock().unwrap().clone();
            match cmd {
                Cmd::Close => { let _ = tls.sock.shutdown(std::net::Shutdown::Both); return; }
                Cmd::Receiver(mut v) => { next(&mut v); send(tls, "receiver-0", NS_RECV, &v); }
                Cmd::Media(mut v) => if let (Some(t), Some(m)) = (&s.transport, s.media_session) {
                    v["mediaSessionId"] = json!(m); next(&mut v); send(tls, t, NS_MEDIA, &v);
                },
            }
        }
        if last_ping.elapsed() > Duration::from_secs(5) {
            last_ping = Instant::now();
            if !send(tls, "receiver-0", NS_HEART, &json!({ "type": "PING" })) { return fail(&st, "Cast connection lost".into()); }
        }
        let transport = st.lock().unwrap().transport.clone();
        if let Some(t) = &transport { if last_poll.elapsed() > Duration::from_secs(2) {
            last_poll = Instant::now();
            let mut v = json!({ "type": "GET_STATUS" }); next(&mut v); send(tls, t, NS_MEDIA, &v);
        } }

        match tls.read(&mut chunk) {
            Ok(0) => return fail(&st, "Cast device closed the connection".into()),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return fail(&st, format!("Cast connection lost: {e}")),
        }
        while buf.len() >= 4 {
            let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            if buf.len() < 4 + len { break }
            let msg: Vec<u8> = buf.drain(..4 + len).skip(4).collect();
            let Some((ns, p)) = unframe(&msg) else { continue };
            match p["type"].as_str().unwrap_or("") {
                "PING" => { send(tls, "receiver-0", NS_HEART, &json!({ "type": "PONG" })); }
                "RECEIVER_STATUS" => {
                    let app = p["status"]["applications"].as_array().and_then(|a| a.iter().find(|x| x["appId"] == DEFAULT_RECEIVER)).cloned();
                    if let Some(app) = app {
                        let t = app["transportId"].as_str().unwrap_or("").to_string();
                        let fresh = transport.as_deref() != Some(t.as_str());
                        { let mut s = st.lock().unwrap(); s.transport = Some(t.clone()); s.session = app["sessionId"].as_str().map(str::to_string); }
                        if fresh {
                            send(tls, &t, NS_CONN, &json!({ "type": "CONNECT" }));
                            if let Some(mut l) = load.take() {
                                l["sessionId"] = app["sessionId"].clone(); next(&mut l); send(tls, &t, NS_MEDIA, &l);
                            }
                        }
                    }
                }
                "MEDIA_STATUS" if ns == NS_MEDIA => if let Some(m) = p["status"].as_array().and_then(|a| a.first()) {
                    let mut s = st.lock().unwrap();
                    s.media_session = m["mediaSessionId"].as_i64().or(s.media_session);
                    s.position = m["currentTime"].as_f64().unwrap_or(s.position);
                    if let Some(d) = m["media"]["duration"].as_f64() { s.duration = d }
                    s.playing = m["playerState"] == "PLAYING" || m["playerState"] == "BUFFERING";
                    if m["playerState"] == "IDLE" && m["idleReason"] == "ERROR" { s.error = Some("The TV couldn't play this stream".into()) }
                },
                "LOAD_FAILED" | "LOAD_CANCELLED" | "INVALID_REQUEST" | "LAUNCH_ERROR" =>
                    fail(&st, format!("Cast {}: {}", p["type"].as_str().unwrap_or(""), p["reason"].as_str().unwrap_or("rejected"))),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let f = frame("sender-0", "receiver-0", NS_RECV, &json!({ "type": "LAUNCH", "appId": "CC1AD845" }));
        let len = u32::from_be_bytes([f[0], f[1], f[2], f[3]]) as usize;
        assert_eq!(len, f.len() - 4);
        let (ns, p) = unframe(&f[4..]).unwrap();
        assert_eq!((ns.as_str(), p["appId"].as_str()), (NS_RECV, Some("CC1AD845")));
    }

    #[test]
    fn parses_mdns_answer_with_compression() {
        // PTR _googlecast._tcp.local -> "Living-Room._googlecast._tcp.local", SRV port 8009 -> host.local, TXT fn=Living Room, A host.local
        let mut b = vec![0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0];
        let svc = b.len();
        for l in ["_googlecast", "_tcp", "local"] { b.push(l.len() as u8); b.extend_from_slice(l.as_bytes()); }
        b.push(0);
        b.extend_from_slice(&[0, 12, 0, 1, 0, 0, 0, 120]);
        let inst_rd = b.len() + 2;
        let rd: Vec<u8> = [vec![11], b"Living-Room".to_vec(), vec![0xC0, svc as u8]].concat();
        b.extend_from_slice(&(rd.len() as u16).to_be_bytes()); b.extend_from_slice(&rd);
        // SRV: name -> pointer to instance
        b.extend_from_slice(&[0xC0, inst_rd as u8, 0, 33, 0, 1, 0, 0, 0, 120]);
        let host_rd = b.len() + 2 + 6;
        let srv: Vec<u8> = [vec![0, 0, 0, 0, 0x1F, 0x49], vec![4], b"host".to_vec(), vec![0xC0, (svc + 17) as u8]].concat();
        b.extend_from_slice(&(srv.len() as u16).to_be_bytes()); b.extend_from_slice(&srv);
        // TXT
        b.extend_from_slice(&[0xC0, inst_rd as u8, 0, 16, 0, 1, 0, 0, 0, 120]);
        let txt: Vec<u8> = [vec![14], b"fn=Living Room".to_vec()].concat();
        b.extend_from_slice(&(txt.len() as u16).to_be_bytes()); b.extend_from_slice(&txt);
        // A
        b.extend_from_slice(&[0xC0, host_rd as u8, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 192, 168, 0, 40]);
        let mut f = Found::default();
        parse_mdns(&b, &mut f).unwrap();
        let inst = "Living-Room._googlecast._tcp.local";
        assert_eq!(f.ptr, vec![inst]);
        assert_eq!(f.srv[inst], (8009, "host.local".to_string()));
        assert_eq!(f.txt[inst]["fn"], "Living Room");
        assert_eq!(f.a["host.local"], IpAddr::from([192, 168, 0, 40]));
    }
}
