//! DLNA / UPnP MediaRenderer control (Samsung & LG TVs, eShare, Fire TV DLNA apps).
//! Port of what v9 got working through dlnacasts + its Samsung shims:
//!  - never call ConnectionManager::PrepareForConnection (Samsung advertises it, then
//!    rejects it with 701/704); drive InstanceID 0 straight to SetAVTransportURI;
//!  - the DIDL <res protocolInfo> carries the same DLNA.ORG features as the HTTP response
//!    (see stream::dlna_profile), or Samsung answers 716.

use regex::Regex;
use std::net::UdpSocket;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Renderer {
    pub id: String,
    pub name: String,
    pub host: String,
    av: Service,
    rc: Option<Service>,
    cm: Option<Service>,
}

#[derive(Clone, Debug)]
struct Service {
    urn: String,
    url: String,
}

/// SSDP M-SEARCH for renderers, then each one's description. ~`wait` total.
pub fn discover(wait: Duration) -> Vec<Renderer> {
    let mut locations: Vec<String> = vec![];
    let mut socks = vec![];
    // The default-route adapter first (Windows sends multicast out of ONE interface,
    // which may be a Hyper-V/VPN one when bound to 0.0.0.0), then any.
    if let Some(ip) = crate::lan::lan_ip_for(None) { if let Ok(s) = UdpSocket::bind((ip, 0)) { socks.push(s) } }
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") { socks.push(s) }
    for s in &socks {
        let _ = s.set_read_timeout(Some(Duration::from_millis(150)));
        for st in ["urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"] {
            let msg = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
            let _ = s.send_to(msg.as_bytes(), "239.255.255.250:1900");
        }
    }
    let end = Instant::now() + wait;
    let mut buf = [0u8; 2048];
    while Instant::now() < end {
        for s in &socks {
            if let Ok((n, _)) = s.recv_from(&mut buf) {
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(loc) = text.lines().find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.trim().eq_ignore_ascii_case("location").then(|| v.trim().to_string())
                }) {
                    if !locations.contains(&loc) { locations.push(loc) }
                }
            }
        }
    }
    let found: Vec<Renderer> = std::thread::scope(|sc| {
        let hs: Vec<_> = locations.iter().map(|l| sc.spawn(move || describe(l))).collect();
        hs.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    });
    let mut out: Vec<Renderer> = vec![];
    for r in found { if !out.iter().any(|o| o.id == r.id) { out.push(r) } } // one per device
    out
}

static RE_SERVICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<service>(.*?)</service>").unwrap());

fn tag(xml: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?s)<(?:\w+:)?{name}[^>]*>(.*?)</(?:\w+:)?{name}>")).ok()?;
    re.captures(xml).map(|c| unescape(c[1].trim()))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn describe(location: &str) -> Option<Renderer> {
    let xml = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build()
        .get(location).call().ok()?.into_string().ok()?;
    let origin = location.splitn(4, '/').take(3).collect::<Vec<_>>().join("/"); // http://host:port
    let base = tag(&xml, "URLBase").map(|b| b.trim_end_matches('/').to_string()).unwrap_or(origin);
    let resolve = |u: String| if u.starts_with("http") { u } else { format!("{base}/{}", u.trim_start_matches('/')) };
    let mut av = None; let mut rc = None; let mut cm = None;
    for c in RE_SERVICE.captures_iter(&xml) {
        let (Some(urn), Some(url)) = (tag(&c[1], "serviceType"), tag(&c[1], "controlURL")) else { continue };
        let s = Service { url: resolve(url), urn: urn.clone() };
        if urn.contains(":AVTransport:") { av = Some(s) }
        else if urn.contains(":RenderingControl:") { rc = Some(s) }
        else if urn.contains(":ConnectionManager:") { cm = Some(s) }
    }
    let host = location.split("//").nth(1)?.split(['/', ':']).next()?.to_string();
    Some(Renderer {
        id: tag(&xml, "UDN").unwrap_or_else(|| location.to_string()),
        name: tag(&xml, "friendlyName").unwrap_or_else(|| host.clone()),
        host, av: av?, rc, cm,
    })
}

/// One SOAP action; Err carries the UPnP error ("UPnP 716 Resource not found").
fn soap(s: &Service, action: &str, args: &[(&str, &str)]) -> Result<String, String> {
    let body: String = args.iter().map(|(k, v)| format!("<{k}>{}</{k}>", escape(v))).collect();
    let env = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{body}</u:{action}></s:Body></s:Envelope>",
        s.urn);
    let r = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build().post(&s.url)
        .set("Content-Type", "text/xml; charset=\"utf-8\"")
        .set("SOAPAction", &format!("\"{}#{action}\"", s.urn))
        .send_string(&env);
    match r {
        Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let x = resp.into_string().unwrap_or_default();
            Err(match (tag(&x, "errorCode"), tag(&x, "errorDescription")) {
                (Some(c), d) => format!("UPnP {c} {}", d.unwrap_or_default()).trim().to_string(),
                _ => format!("HTTP {code}"),
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// DIDL-Lite item the way upnp-mediarenderer-client built it for v9 (Samsung-tested).
fn didl(url: &str, title: &str, mime: &str, features: &str) -> String {
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:sec=\"http://www.sec.co.kr/\">\
         <item id=\"0\" parentID=\"-1\" restricted=\"false\"><dc:title>{}</dc:title>\
         <upnp:class>object.item.videoItem</upnp:class>\
         <res protocolInfo=\"http-get:*:{mime}:{features}\">{}</res></item></DIDL-Lite>",
        escape(title), escape(url))
}

impl Renderer {
    pub fn play(&self, url: &str, title: &str, mime: &str, features: &str) -> Result<(), String> {
        soap(&self.av, "SetAVTransportURI", &[("InstanceID", "0"), ("CurrentURI", url),
            ("CurrentURIMetaData", &didl(url, title, mime, features))])?;
        soap(&self.av, "Play", &[("InstanceID", "0"), ("Speed", "1")]).map(|_| ())
    }
    pub fn pause(&self) -> Result<(), String> { soap(&self.av, "Pause", &[("InstanceID", "0")]).map(|_| ()) }
    pub fn resume(&self) -> Result<(), String> { soap(&self.av, "Play", &[("InstanceID", "0"), ("Speed", "1")]).map(|_| ()) }
    pub fn stop(&self) -> Result<(), String> { soap(&self.av, "Stop", &[("InstanceID", "0")]).map(|_| ()) }
    pub fn seek(&self, secs: u64) -> Result<(), String> {
        let t = format!("{}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60);
        soap(&self.av, "Seek", &[("InstanceID", "0"), ("Unit", "REL_TIME"), ("Target", &t)]).map(|_| ())
    }
    /// 0..=100. Silently unsupported on renderers without RenderingControl.
    pub fn volume(&self, v: u32) -> Result<(), String> {
        let Some(rc) = &self.rc else { return Ok(()) };
        soap(rc, "SetVolume", &[("InstanceID", "0"), ("Channel", "Master"), ("DesiredVolume", &v.min(100).to_string())]).map(|_| ())
    }
    /// (position, duration) seconds; None when the renderer doesn't report them.
    pub fn position(&self) -> Option<(f64, f64)> {
        let x = soap(&self.av, "GetPositionInfo", &[("InstanceID", "0")]).ok()?;
        Some((parse_time(&tag(&x, "RelTime")?)?, tag(&x, "TrackDuration").and_then(|d| parse_time(&d)).unwrap_or(0.0)))
    }
    /// What the TV says it can play (video entries) — appended to play errors, as in v9.
    pub fn sinks(&self) -> String {
        let Some(cm) = &self.cm else { return "unknown".into() };
        let Some(sink) = soap(cm, "GetProtocolInfo", &[]).ok().and_then(|x| tag(&x, "Sink")) else { return "unknown".into() };
        let v: Vec<&str> = sink.split(',').filter(|s| s.contains("video")).take(6)
            .map(|s| s.split(':').nth(2).unwrap_or(s)).collect();
        if v.is_empty() { "unknown".into() } else { v.join(" ") }
    }
}

/// "H:MM:SS(.mmm)" -> seconds; None for empty / NOT_IMPLEMENTED.
fn parse_time(s: &str) -> Option<f64> {
    let p: Vec<f64> = s.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    (p.len() == 3).then(|| p[0] * 3600.0 + p[1] * 60.0 + p[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_description_and_times() {
        let xml = r#"<root><URLBase>http://10.0.0.5:7676/</URLBase><device><friendlyName>[TV] Samsung &amp; Co</friendlyName>
            <UDN>uuid:abc</UDN><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/smp_17_</controlURL></service>
            <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>http://10.0.0.5:7676/rc</controlURL></service>
            </serviceList></device></root>"#;
        assert_eq!(tag(xml, "friendlyName").as_deref(), Some("[TV] Samsung & Co"));
        assert_eq!(parse_time("1:02:03.500"), Some(3723.5));
        assert_eq!(parse_time("NOT_IMPLEMENTED"), None);
        assert!(didl("http://a/b?c&d", "T", "video/mpeg", "DLNA.ORG_OP=00").contains("http://a/b?c&amp;d"));
    }
}
