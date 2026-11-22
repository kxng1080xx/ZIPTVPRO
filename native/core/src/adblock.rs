//! Ad blocker for custom web tabs (v9 used Ghostery's engine in Electron). Brave's adblock-rust
//! with EasyList + EasyPrivacy, shared by the Android WebView and the PC's Chromium.
//! Lists are cached in `dir` and refreshed every few days; a failed download keeps the old copy.

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
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
}

#[uniffi::export]
impl AdBlock {
    #[uniffi::constructor]
    pub fn new(dir: String) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&dir);
        Arc::new(Self { dir, engine: RwLock::new(None) })
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

    /// CSS hiding this page's known ad slots ("" when none), injected after load.
    pub fn hide_css(&self, page_url: String) -> String {
        let Ok(guard) = self.engine.read() else { return String::new() };
        let Some(engine) = guard.as_ref() else { return String::new() };
        let sel: Vec<String> = engine.url_cosmetic_resources(&page_url).hide_selectors.into_iter().collect();
        if sel.is_empty() { String::new() } else { format!("{}{{display:none!important}}", sel.join(",")) }
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
