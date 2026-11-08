//! Plain M3U playlists (not Xtream): one #EXTINF line + one URL per entry.
//! group-title -> category, tvg-logo -> logo, tvg-id -> EPG id. Entries whose URL is a
//! file (.mp4/.mkv…) or an Xtream /movie/ or /series/ path become movies; the rest are live.

use crate::epg::KeyIndex;
use crate::{names, Category, Channel, ContentKind, Movie};
use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

pub struct Parsed {
    pub categories: Vec<Category>,
    pub channels: Vec<Channel>,
    pub movies: Vec<Movie>,
    /// stream id -> the entry's own URL
    pub urls: HashMap<String, String>,
}

fn attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"([A-Za-z][\w-]*)="([^"]*)""#).unwrap())
}

/// Stable id from the URL so favorites/progress survive re-syncs. FNV-1a 64.
fn id_for(url: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in url.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("m{h:016x}")
}

fn is_vod(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    path.contains("/movie/") || path.contains("/series/")
        || [".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv"].iter().any(|e| path.ends_with(e))
}

pub fn parse(text: &str, logos: Option<&KeyIndex>) -> Parsed {
    let mut out = Parsed { categories: vec![], channels: vec![], movies: vec![], urls: HashMap::new() };
    let mut cat_ids: HashMap<(bool, String), String> = HashMap::new();
    let mut pending: Option<(HashMap<String, String>, String)> = None; // (attrs, display name)

    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // Display name = after the first comma that is outside quotes.
            let mut in_q = false;
            let mut split = rest.len();
            for (i, c) in rest.char_indices() {
                match c {
                    '"' => in_q = !in_q,
                    ',' if !in_q => { split = i; break; }
                    _ => {}
                }
            }
            let attrs = attr_re().captures_iter(&rest[..split])
                .map(|c| (c[1].to_ascii_lowercase(), c[2].trim().to_string()))
                .collect::<HashMap<_, _>>();
            let name = rest.get(split + 1..).unwrap_or("").trim().to_string();
            pending = Some((attrs, name));
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((attrs, mut name)) = pending.take() else { continue };
        let url = line.to_string();
        if name.is_empty() {
            name = attrs.get("tvg-name").cloned().unwrap_or_else(|| url.clone());
        }
        let vod = is_vod(&url);
        let group = attrs.get("group-title").filter(|g| !g.is_empty()).cloned()
            .unwrap_or_else(|| if vod { "Movies".into() } else { "Channels".into() });
        let next = cat_ids.len();
        let category_id = cat_ids.entry((vod, group.clone())).or_insert_with(|| {
            let id = format!("g{next}");
            out.categories.push(Category {
                id: id.clone(), name: group.clone(),
                kind: if vod { ContentKind::Movie } else { ContentKind::Live }, count: 0,
            });
            id
        }).clone();
        let id = id_for(&url);
        let logo = attrs.get("tvg-logo").filter(|l| !l.is_empty()).cloned();
        if vod {
            out.movies.push(Movie {
                stream_id: id.clone(), name: name.clone(), category_id, poster: logo,
                rating: 0.0, year: None, extension: None, added: 0,
            });
        } else {
            let epg_id = attrs.get("tvg-id").filter(|e| !e.is_empty()).cloned();
            let alt_logo = logos.and_then(|l| l.lookup(&name, epg_id.as_deref())).map(str::to_string);
            out.channels.push(Channel {
                stream_id: id.clone(), name: names::clean_channel_name(&name), raw_name: name,
                category_id, logo: logo.or_else(|| alt_logo.clone()), alt_logo, epg_id,
                archive_days: 0,
            });
        }
        out.urls.insert(id, url);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_and_vod_with_groups() {
        let m3u = r#"#EXTM3U url-tvg="http://x/epg.xml"
#EXTINF:-1 tvg-id="cnn.us" tvg-logo="http://l/cnn.png" group-title="News, USA",CNN HD
http://host/live/u/p/1.ts
#EXTINF:-1 group-title="Movies",Big Movie (2020)
http://host/movie/u/p/9.mkv
#EXTINF:-1,No Group
http://host/x.m3u8
"#;
        let p = parse(m3u, None);
        assert_eq!(p.channels.len(), 2);
        assert_eq!(p.movies.len(), 1);
        let cnn = &p.channels[0];
        assert_eq!(cnn.raw_name, "CNN HD");
        assert_eq!(cnn.epg_id.as_deref(), Some("cnn.us"));
        assert_eq!(cnn.logo.as_deref(), Some("http://l/cnn.png"));
        assert_eq!(p.urls[&cnn.stream_id], "http://host/live/u/p/1.ts");
        let news = p.categories.iter().find(|c| c.id == cnn.category_id).unwrap();
        assert_eq!(news.name, "News, USA"); // comma inside quotes is not the name split
        assert_eq!(p.categories.iter().find(|c| c.id == p.movies[0].category_id).unwrap().kind, ContentKind::Movie);
        assert_eq!(p.channels[1].name, "No Group");
        // ids are stable across parses
        assert_eq!(parse(m3u, None).channels[0].stream_id, cnn.stream_id);
    }
}
