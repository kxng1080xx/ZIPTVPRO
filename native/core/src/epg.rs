//! Guide data: the external guide (epgshare01 via the repo's epg-data branch,
//! built by scripts/build-epg.mjs) first, the provider's EPG as fallback.

use crate::names::logo_key;
use crate::xtream::{as_i64, as_str, Client};
use crate::Programme;
use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;

pub const EXT_BASE: &str = "https://raw.githubusercontent.com/kxng1080xx/ZIPTVPRO/epg-data/";

/// Same shape as public/channel-logos.json and the EPG index.json:
/// `urls[i]` is the value; `ids` and `names` map keys to i.
#[derive(Deserialize, Default)]
pub struct KeyIndex {
    pub urls: Vec<String>,
    #[serde(default)]
    pub ids: HashMap<String, usize>,
    #[serde(default)]
    pub names: HashMap<String, usize>,
}

impl KeyIndex {
    /// epg_channel_id first (exact), then cleaned name + country, then name.
    pub fn lookup(&self, name: &str, epg_id: Option<&str>) -> Option<&str> {
        if let Some(id) = epg_id {
            let id = id.to_lowercase();
            let id = id.split('@').next().unwrap_or("");
            if let Some(&i) = self.ids.get(id) {
                return self.urls.get(i).map(|s| s.as_str());
            }
        }
        let (key, cc) = logo_key(name);
        if key.is_empty() {
            return None;
        }
        let i = (!cc.is_empty())
            .then(|| self.names.get(&format!("{key}.{cc}")))
            .flatten()
            .or_else(|| self.names.get(&key))?;
        self.urls.get(*i).map(|s| s.as_str())
    }
}

#[derive(Deserialize)]
struct ExtListing {
    title: String,
    #[serde(default)]
    description: String,
    start_timestamp: String,
    end_timestamp: String,
}

pub fn external(client: &Client, index: &KeyIndex, name: &str, epg_id: Option<&str>) -> Option<Vec<Programme>> {
    let file = index.lookup(name, epg_id)?;
    let v = client.get_json(&format!("{EXT_BASE}ch/{file}.json"))?;
    let list: Vec<ExtListing> = serde_json::from_value(v).ok()?;
    let out: Vec<Programme> = list
        .into_iter()
        .map(|l| Programme {
            title: l.title,
            description: l.description,
            start: l.start_timestamp.parse().unwrap_or(0),
            end: l.end_timestamp.parse().unwrap_or(0),
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

pub fn provider(client: &Client, stream_id: &str) -> Vec<Programme> {
    // get_simple_data_table returns the full schedule; get_short_epg often only past items.
    let Some(v) = client.action("get_simple_data_table", &format!("&stream_id={stream_id}"), |_, _| {}) else {
        return vec![];
    };
    let Some(list) = v.get("epg_listings").and_then(|l| l.as_array()) else { return vec![] };
    list.iter()
        .map(|p| Programme {
            title: decode_b64_text(&p.get("title").map(as_str).unwrap_or_default()),
            description: decode_b64_text(&p.get("description").map(as_str).unwrap_or_default()),
            start: p.get("start_timestamp").map(as_i64).unwrap_or(0),
            end: p.get("stop_timestamp").or_else(|| p.get("end_timestamp")).map(as_i64).unwrap_or(0),
        })
        .filter(|p| p.end > p.start)
        .collect()
}

/// Xtream EPG text is base64 of the WHOLE string. Anything with spaces or
/// non-base64 characters is already plain text and is returned untouched
/// (v9 bug: per-word decoding turned "Vampire" into garbage).
pub fn decode_b64_text(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
        return t.to_string();
    }
    let mut padded = t.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    match base64::engine::general_purpose::STANDARD.decode(padded.as_bytes()) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if !text.chars().any(|c| c.is_control() && !c.is_whitespace()) => text,
            _ => t.to_string(),
        },
        Err(_) => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_only_when_whole_string() {
        assert_eq!(decode_b64_text("TmlnaHRseSBOZXdz"), "Nightly News");
        assert_eq!(decode_b64_text("The Office"), "The Office");
        assert_eq!(decode_b64_text(""), "");
    }

    #[test]
    fn index_lookup_prefers_epg_id_then_country() {
        let idx: KeyIndex = serde_json::from_str(
            r#"{"urls":["a","b","c"],"ids":{"bbctwo.uk":0},"names":{"cnn":1,"cnn.us":2}}"#,
        )
        .unwrap();
        assert_eq!(idx.lookup("whatever", Some("BBCTwo.uk")), Some("a"));
        assert_eq!(idx.lookup("US: CNN HD", None), Some("c"));
        assert_eq!(idx.lookup("CNN", None), Some("b"));
        assert_eq!(idx.lookup("zzz", None), None);
    }
}
