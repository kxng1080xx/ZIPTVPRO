//! Ad blocker for custom web tabs (v9 used Ghostery's engine in Electron). Brave's adblock-rust
//! with EasyList + EasyPrivacy. Android asks per request (WebView); the PC's WebView2 can't be hooked
//! per request, so it goes through `start_proxy`, which refuses connections to ad/tracker servers.
//! Lists are cached in `dir` and refreshed every few days; a failed download keeps the old copy.

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

const LISTS: [(&str, &str); 2] = [
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt"),
];
const REFRESH: Duration = Duration::from_secs(4 * 24 * 3600);

#[derive(uniffi::Object)]
pub struct AdBlock {
    dir: String,
    engine: RwLock<Option<Engine>>,
    /// Proxy only: off = pass everything through (Settings toggle; the proxy stays in place).
    enabled: AtomicBool,
    /// Proxy only: the tabs' own sites, never blocked even if a list names them.
    allowed: RwLock<Vec<String>>,
}

#[uniffi::export]
impl AdBlock {
    #[uniffi::constructor]
    pub fn new(dir: String) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&dir);
        Arc::new(Self { dir, engine: RwLock::new(None), enabled: AtomicBool::new(true), allowed: RwLock::new(Vec::new()) })
    }

    /// Downloads (when stale) and parses the lists. Blocking: call off the UI thread. Until it
    /// finishes nothing is blocked.
    pub fn load(&self) {
        if self.engine.read().map(|e| e.is_some()).unwrap_or(false) { return; }
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).user_agent("ziptv-adblock").build();
        let mut set = FilterSet::new(false);
        for (file, url) in LISTS {
            let path = format!("{}/{file}", self.dir);
            let stale = std::fs::metadata(&path).and_then(|m| m.modified()).ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok()).map_or(true, |age| age > REFRESH);
            if stale {
                if let Ok(text) = agent.get(url).call().and_then(|r| r.into_string().map_err(Into::into)) {
                    if text.len() > 1000 { let _ = std::fs::write(&path, &text); }
                }
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                set.add_filter_list(text, ParseOptions::default());
            }
        }
        if let Ok(mut e) = self.engine.write() { *e = Some(Engine::new_with_filter_set(set)); }
    }

    /// `kind`: script, image, stylesheet, xmlhttprequest, media, font, sub_frame, document, other.
    pub fn should_block(&self, url: String, page_url: String, kind: String) -> bool {
        let Ok(guard) = self.engine.read() else { return false };
        let Some(engine) = guard.as_ref() else { return false };
        let Ok(req) = Request::new(&url, &page_url, &kind, "GET") else { return false };
        let r = engine.check_network_request(&req);
        r.should_block()
    }

    pub fn set_enabled(&self, on: bool) { self.enabled.store(on, Ordering::Relaxed); }

    /// Hosts the proxy must never block: the web tabs' own addresses.
    pub fn set_allowed_hosts(&self, hosts: Vec<String>) {
        if let Ok(mut a) = self.allowed.write() {
            *a = hosts.into_iter().map(|h| h.trim_start_matches("www.").to_lowercase()).filter(|h| !h.is_empty()).collect();
        }
    }

    /// Starts a local HTTP proxy (127.0.0.1, free port) that refuses ad/tracker servers and tunnels
    /// everything else; returns the port. HTTPS stays end-to-end encrypted: only the host name is seen.
    pub fn start_proxy(self: Arc<Self>) -> u16 {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return 0 };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let me = self.clone();
                std::thread::spawn(move || { let _ = me.serve(conn); });
            }
        });
        port
    }

    /// CSS hiding this page's known ad slots ("" when none), injected after load.
    pub fn hide_css(&self, page_url: String) -> String {
        let Ok(guard) = self.engine.read() else { return String::new() };
        let Some(engine) = guard.as_ref() else { return String::new() };
        let sel: Vec<String> = engine.url_cosmetic_resources(&page_url).hide_selectors.into_iter().collect();
        if sel.is_empty() { String::new() } else { format!("{}{{display:none!important}}", sel.join(",")) }
    }
}

impl AdBlock {
    /// Host-level check for the proxy (it never sees full HTTPS URLs). Counted as third-party, so
    /// `$third-party` ad-server rules apply; the tabs' own sites are exempt.
    fn blocks_host(&self, host: &str) -> bool {
        if !self.enabled.load(Ordering::Relaxed) { return false; }
        let h = host.to_lowercase();
        let own = self.allowed.read().map(|a| a.iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))).unwrap_or(false);
        !own && self.should_block(format!("https://{h}/"), "https://ziptv.invalid/".into(), "script".into())
    }

    fn serve(&self, mut client: TcpStream) -> std::io::Result<()> {
        client.set_read_timeout(Some(Duration::from_secs(30)))?;
        let mut head = Vec::with_capacity(1024);
        let mut buf = [0u8; 4096];
        let end = loop {
            let n = client.read(&mut buf)?;
            if n == 0 { return Ok(()); }
            head.extend_from_slice(&buf[..n]);
            if let Some(i) = head.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
            if head.len() > 64 * 1024 { return Ok(()); }
        };
        let text = String::from_utf8_lossy(&head[..end]).to_string();
        let mut first = text.lines().next().unwrap_or("").split_whitespace();
        let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
        let connect = method.eq_ignore_ascii_case("CONNECT");
        let (host, port): (String, u16) = if connect {
            let (h, p) = target.rsplit_once(':').unwrap_or((target, "443"));
            (h.trim_matches(['[', ']']).to_string(), p.parse().unwrap_or(443))
        } else {
            let rest = target.strip_prefix("http://").unwrap_or(target);
            let authority = rest.split('/').next().unwrap_or("");
            match authority.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse().unwrap_or(80)),
                None => (authority.to_string(), 80),
            }
        };
        if host.is_empty() || self.blocks_host(&host) {
            client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        }
        let mut upstream = TcpStream::connect((host.as_str(), port))?;
        client.set_read_timeout(None)?;
        if connect {
            client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
        } else {
            // One request per connection: a reused proxy connection may carry the next request to another
            // host, which this tunnel would send to the wrong server.
            let fixed: String = text.split("\r\n")
                .filter(|l| !l.is_empty())
                .filter(|l| { let l = l.to_ascii_lowercase(); !l.starts_with("proxy-connection:") && !l.starts_with("connection:") })
                .map(|l| format!("{l}\r\n")).collect();
            upstream.write_all(format!("{fixed}Connection: close\r\n\r\n").as_bytes())?;
        }
        upstream.write_all(&head[end..])?;
        let (mut c2, mut u2) = (client.try_clone()?, upstream.try_clone()?);
        let t = std::thread::spawn(move || { let _ = std::io::copy(&mut c2, &mut u2); let _ = u2.shutdown(std::net::Shutdown::Write); });
        let _ = std::io::copy(&mut upstream, &mut client);
        let _ = client.shutdown(std::net::Shutdown::Both);
        let _ = t.join();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_listed_hosts_only() {
        let a = AdBlock::new(std::env::temp_dir().join("ziptv-adblock-test").to_string_lossy().into());
        let mut set = FilterSet::new(false);
        set.add_filter_list("||ads.example.com^\nexample.org##.banner-ad".to_string(), ParseOptions::default());
        *a.engine.write().unwrap() = Some(Engine::new_with_filter_set(set));
        assert!(a.should_block("https://ads.example.com/x.js".into(), "https://news.test/".into(), "script".into()));
        assert!(!a.should_block("https://cdn.example.net/app.js".into(), "https://news.test/".into(), "script".into()));
        assert!(a.hide_css("https://example.org/page".into()).contains(".banner-ad"));
        // Proxy host checks: listed host blocked, a tab's own site exempt, off = nothing blocked.
        assert!(a.blocks_host("ads.example.com"));
        a.set_allowed_hosts(vec!["www.example.com".into()]);
        assert!(!a.blocks_host("ads.example.com"));
        a.set_allowed_hosts(vec![]);
        a.set_enabled(false);
        assert!(!a.blocks_host("ads.example.com"));
    }

    #[test]
    fn proxy_refuses_blocked_hosts() {
        let a = AdBlock::new(std::env::temp_dir().join("ziptv-adblock-proxy").to_string_lossy().into());
        let mut set = FilterSet::new(false);
        set.add_filter_list("||ads.example.com^".to_string(), ParseOptions::default());
        *a.engine.write().unwrap() = Some(Engine::new_with_filter_set(set));
        let port = a.clone().start_proxy();
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"CONNECT ads.example.com:443 HTTP/1.1\r\nHost: ads.example.com:443\r\n\r\n").unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    }
}

#[cfg(test)]
mod real_lists {
    /// `ZIPTV_ADBLOCK_DIR=~/.ziptv10/adblock cargo test --release real_lists -- --ignored`
    #[test]
    #[ignore]
    fn easylist_blocks_ad_servers() {
        let a = super::AdBlock::new(std::env::var("ZIPTV_ADBLOCK_DIR").unwrap());
        let t = std::time::Instant::now();
        a.load();
        eprintln!("loaded in {:?}", t.elapsed());
        let page = "https://www.cnn.com/".to_string();
        assert!(a.should_block("https://securepubads.g.doubleclick.net/tag/js/gpt.js".into(), page.clone(), "script".into()));
        assert!(a.should_block("https://www.google-analytics.com/analytics.js".into(), page.clone(), "script".into()));
        assert!(!a.should_block("https://www.youtube.com/s/player/base.js".into(), "https://www.youtube.com/".into(), "script".into()));
    }
}
