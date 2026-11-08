//! Update check against the repo's GitHub releases. Only v10+ tags count, so the
//! v9 (Electron/Capacitor) releases never offer themselves to v10 users.

use crate::xtream::{as_str, field};
use serde_json::Value;
use std::time::Duration;

const RELEASES: &str = "https://api.github.com/repos/kxng1080xx/ZIPTVPRO/releases?per_page=20";

#[derive(uniffi::Record, Clone, Debug)]
pub struct UpdateInfo {
    pub version: String,
    /// Direct download for this platform's asset (falls back to the release page).
    pub url: String,
    pub notes: String,
}

/// `platform`: "pc" (wants .msi/.exe) or "apk" (wants .apk). None = up to date / offline.
#[uniffi::export]
pub fn check_update(current: String, platform: String) -> Option<UpdateInfo> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).user_agent("ziptv-update").build();
    let list: Value = agent.get(RELEASES).call().ok()?.into_json().ok()?;
    pick(&list, &current, &platform)
}

fn version(tag: &str) -> Option<(u32, u32, u32)> {
    let mut it = tag.trim_start_matches(['v', 'V']).split('.').map(|p| p.trim().parse::<u32>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

fn pick(list: &Value, current: &str, platform: &str) -> Option<UpdateInfo> {
    let cur = version(current)?;
    let exts: &[&str] = if platform == "apk" { &[".apk"] } else { &[".msi", ".exe"] };
    list.as_array()?
        .iter()
        .filter(|r| !r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false) && !r.get("prerelease").and_then(|d| d.as_bool()).unwrap_or(false))
        .filter_map(|r| Some((version(&field(r, "tag_name"))?, r)))
        .filter(|(v, _)| v.0 >= 10 && *v > cur)
        .max_by_key(|(v, _)| *v)
        .map(|(v, r)| {
            let asset = r.get("assets").and_then(|a| a.as_array()).and_then(|a| {
                exts.iter().find_map(|e| a.iter().find(|x| field(x, "name").to_lowercase().ends_with(e)))
            });
            UpdateInfo {
                version: format!("{}.{}.{}", v.0, v.1, v.2),
                url: asset.map(|a| field(a, "browser_download_url")).unwrap_or_else(|| field(r, "html_url")),
                notes: r.get("body").map(as_str).unwrap_or_default().chars().take(400).collect(),
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_newest_v10_plus_and_platform_asset() {
        let list: Value = serde_json::from_str(
            r#"[{"tag_name":"v9.9.9","assets":[]},
                {"tag_name":"v10.0.2","assets":[{"name":"ZIPTV-10.0.2.msi","browser_download_url":"m"},{"name":"app.apk","browser_download_url":"a"}]},
                {"tag_name":"v10.1.0","prerelease":true,"assets":[]},
                {"tag_name":"v10.0.1","html_url":"page","assets":[]}]"#,
        )
        .unwrap();
        let u = pick(&list, "10.0.0", "pc").unwrap();
        assert_eq!((u.version.as_str(), u.url.as_str()), ("10.0.2", "m"));
        assert_eq!(pick(&list, "10.0.0", "apk").unwrap().url, "a");
        assert!(pick(&list, "10.0.2", "pc").is_none());
    }
}
