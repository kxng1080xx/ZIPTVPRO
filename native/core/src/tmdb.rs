//! TMDB "About" data (overview, cast, genres, ratings, trailer). Port of v9's
//! server/tmdb.js: same title cleaning, search-then-details, trailer choice.
//! Results cached on disk (hit 7 days, miss 1 day).

use crate::xtream::{as_i64, as_str, field, urlencode};
use crate::ContentKind;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://api.themoviedb.org/3";
const IMG: &str = "https://image.tmdb.org/t/p";
const TTL_HIT: i64 = 7 * 86_400;
const TTL_MISS: i64 = 86_400;

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct CastMember {
    pub name: String,
    pub character: String,
    pub profile: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub title: String,
    pub overview: String,
    pub tagline: String,
    pub genres: Vec<String>,
    pub status: String,
    pub created_by: Vec<String>,
    pub director: Vec<String>,
    pub networks: Vec<String>,
    pub seasons: u32,
    pub episodes: u32,
    pub release_date: String,
    pub runtime: u32,
    pub rating: f32,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub cast: Vec<CastMember>,
    /// YouTube video key of the best trailer.
    pub trailer_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    at: i64,
    meta: Option<Meta>,
}

#[derive(uniffi::Object)]
pub struct Tmdb {
    token: String,
    path: String,
    agent: ureq::Agent,
    cache: Mutex<HashMap<String, Entry>>,
}

#[uniffi::export]
impl Tmdb {
    /// `token`: TMDB v4 read access token. `cache_path`: JSON file for results.
    #[uniffi::constructor]
    pub fn new(token: String, cache_path: String) -> Arc<Self> {
        let cache = std::fs::read(&cache_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
        Arc::new(Self { token, path: cache_path, agent, cache: Mutex::new(cache) })
    }

    /// None = not found / no token / offline. Never throws: About is optional.
    pub fn lookup(&self, kind: ContentKind, title: String, year: Option<String>) -> Option<Meta> {
        if self.token.is_empty() {
            return None;
        }
        let tv = kind == ContentKind::Series;
        let key = format!("{}:{}:{}", if tv { "tv" } else { "movie" }, title.to_lowercase().trim(), year.as_deref().unwrap_or(""));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        if let Some(e) = self.cache.lock().unwrap().get(&key) {
            if now - e.at < if e.meta.is_some() { TTL_HIT } else { TTL_MISS } {
                return e.meta.clone();
            }
        }
        let seg = if tv { "tv" } else { "movie" };
        let (query, title_year) = clean_title(&title);
        if query.is_empty() {
            return None;
        }
        let year = year.filter(|y| !y.trim().is_empty()).or(title_year).unwrap_or_default();
        let ykey = if tv { "first_air_date_year" } else { "year" };
        // Network/HTTP failures are not cached as misses (so they retry next time).
        let search = self.call(&format!("/search/{seg}?query={}&{ykey}={}&include_adult=false", urlencode(&query), urlencode(&year)))?;
        let meta = match best_match(&search, &query, tv) {
            Some(id) if id > 0 => {
                let append = if tv { "credits,aggregate_credits,videos,external_ids" } else { "credits,videos,external_ids" };
                Some(normalize(tv, &self.call(&format!("/{seg}/{id}?append_to_response={append}"))?))
            }
            _ => None,
        };
        let mut c = self.cache.lock().unwrap();
        c.insert(key, Entry { at: now, meta: meta.clone() });
        if let Ok(bytes) = serde_json::to_vec(&*c) {
            let _ = std::fs::write(&self.path, bytes);
        }
        meta
    }
}

impl Tmdb {
    fn call(&self, path_query: &str) -> Option<Value> {
        let r = self
            .agent
            .get(&format!("{API}{path_query}"))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("accept", "application/json")
            .call()
            .ok()?;
        r.into_json().ok()
    }
}

/// TMDB's first hit is often a short or making-of with the same name ("X2" ->
/// a 9-minute costume doc). Among the top results prefer an exact title match,
/// then the most-voted (the real film/show), then TMDB's order.
fn best_match(search: &Value, query: &str, tv: bool) -> Option<i64> {
    let results = search.get("results")?.as_array()?;
    let q = query.to_lowercase();
    results
        .iter()
        .take(8)
        .enumerate()
        .max_by_key(|(i, r)| {
            let title = field(r, if tv { "name" } else { "title" }).to_lowercase();
            let exact = (title == q) as i64;
            let votes = r.get("vote_count").map(as_i64).unwrap_or(0);
            (exact, votes, -(*i as i64))
        })
        .map(|(_, r)| r.get("id").map(as_i64).unwrap_or(0))
        .filter(|&id| id > 0)
}

fn img(path: Option<&Value>, size: &str) -> Option<String> {
    path.map(as_str).filter(|p| !p.is_empty()).map(|p| format!("{IMG}/{size}{p}"))
}

fn names(v: Option<&Value>) -> Vec<String> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().map(|x| field(x, "name")).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}

fn normalize(tv: bool, d: &Value) -> Meta {
    let cast_list = d
        .pointer("/credits/cast")
        .and_then(|c| c.as_array())
        .filter(|a| !a.is_empty())
        .or_else(|| d.pointer("/aggregate_credits/cast").and_then(|c| c.as_array()));
    let cast = cast_list
        .map(|a| {
            a.iter()
                .take(20)
                .map(|c| CastMember {
                    name: field(c, "name"),
                    character: c
                        .get("character")
                        .map(as_str)
                        .filter(|s| !s.is_empty())
                        .or_else(|| c.pointer("/roles/0/character").map(as_str))
                        .unwrap_or_default(),
                    profile: img(c.get("profile_path"), "w185"),
                })
                .collect()
        })
        .unwrap_or_default();
    let director = d
        .pointer("/credits/crew")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter(|c| field(c, "job") == "Director").map(|c| field(c, "name")).collect())
        .unwrap_or_default();
    // Official YouTube trailer > trailer > teaser > anything on YouTube.
    let trailer_key = d.pointer("/videos/results").and_then(|v| v.as_array()).and_then(|vids| {
        vids.iter()
            .filter(|v| field(v, "site") == "YouTube" && !field(v, "key").is_empty())
            .max_by_key(|v| {
                let t = field(v, "type");
                (if t == "Trailer" { 4 } else if t == "Teaser" { 2 } else { 0 }) + v.get("official").and_then(|o| o.as_bool()).unwrap_or(false) as i32
            })
            .map(|v| field(v, "key"))
    });
    Meta {
        title: field(d, if tv { "name" } else { "title" }),
        overview: field(d, "overview"),
        tagline: field(d, "tagline"),
        genres: names(d.get("genres")),
        status: field(d, "status"),
        created_by: names(d.get("created_by")),
        director,
        networks: names(d.get("networks")),
        seasons: d.get("number_of_seasons").map(as_i64).unwrap_or(0) as u32,
        episodes: d.get("number_of_episodes").map(as_i64).unwrap_or(0) as u32,
        release_date: field(d, if tv { "first_air_date" } else { "release_date" }),
        runtime: if tv { d.pointer("/episode_run_time/0").map(as_i64).unwrap_or(0) } else { d.get("runtime").map(as_i64).unwrap_or(0) } as u32,
        rating: d.get("vote_average").and_then(|v| v.as_f64()).map(|r| (r * 10.0).round() as f32 / 10.0).unwrap_or(0.0),
        poster: img(d.get("poster_path"), "w500"),
        backdrop: img(d.get("backdrop_path"), "w1280"),
        cast,
        trailer_key,
    }
}

static TAGS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^\s*[\[({|]\s*[A-Za-z0-9 .+-]{1,18}\s*[\])}|]\s*",
        r"(?i)^\s*(?:VOD|MOVIES?|FILM|SERIES|LIVE|NEW|ENCORE|PREMIERE|4K|UHD|HD|FHD|SD)\s*[-:|]\s*",
        r"^\s*[A-Za-z]{2,6}\s*\|\s*",
        r"(?i)^\s*(?:EN|ENG|US|USA|UK|GB|CA|CAN|AU|FR|DE|ES|IT|ITA|PT|BR|NL|AR|ARA|TR|RU|PL|IN|IND|VIP|MULTI)\s*[:\-–—]\s*",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});
static MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[\(\[](?:New|Repeat|R|Live|HD|FHD|UHD|4K|CC|SAP|Stereo|Subtitled|Premiere|Finale)[\)\]]").unwrap()
});
static EPISODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*[-–—:]?\s*\b(?:S\d{1,2}\s*E\d{1,3}|Season\s*\d+\s*Episode\s*\d+)\b.*$").unwrap());
static PAREN_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\((19\d{2}|20\d{2})\)").unwrap());
static BARE_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(19\d{2}|20\d{2})\b").unwrap());
static NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:4K|UHD|HDR10\+?|HDR|DV|DOLBY(?:\s*VISION)?|ATMOS|IMAX|3D|REMUX|BLU-?RAY|WEB-?(?:DL|RIP)|HD-?RIP|DVD-?RIP|BR-?RIP|HDTS|CAM|x26[45]|H\.?26[45]|HEVC|AVC|AAC|DTS|DD5\.1|MULTI|DUAL|VOSTFR|LATINO|CASTELLANO|SUB(?:BED|S)?|DUB(?:BED)?|1080[pi]|720[pi]|2160[pi]|480[pi])\b").unwrap()
});
static BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\[\](){}]").unwrap());
static TRAIL_DASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[-–—_]+\s*$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());

/// "EN - The Drop (2024) 1080p" -> ("The Drop", Some("2024")).
pub fn clean_title(raw: &str) -> (String, Option<String>) {
    let mut s = raw.to_string();
    for _ in 0..4 {
        let before = s.clone();
        for re in TAGS.iter() {
            s = re.replace(&s, "").into_owned();
        }
        if s == before {
            break;
        }
    }
    s = MARKERS.replace_all(&s, " ").into_owned();
    s = EPISODE.replace(&s, " ").into_owned();
    let mut year = None;
    if let Some(c) = PAREN_YEAR.captures(&s) {
        year = Some(c[1].to_string());
        s = s.replacen(&c[0].to_string(), " ", 1);
    } else if let Some(m) = BARE_YEAR.find_iter(&s).last() {
        year = Some(m.as_str().to_string());
        s.replace_range(m.range(), " ");
    }
    s = NOISE.replace_all(&s, " ").into_owned();
    s = BRACKETS.replace_all(&s, " ").into_owned();
    s = TRAIL_DASH.replace(&s, " ").into_owned();
    (SPACES.replace_all(&s, " ").trim().to_string(), year)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_clean_like_v9() {
        assert_eq!(clean_title("EN - The Drop (2024) 1080p"), ("The Drop".into(), Some("2024".into())));
        assert_eq!(clean_title("[US] Chicago Fire S12E04"), ("Chicago Fire".into(), None));
        assert_eq!(clean_title("3 Days to Kill 2014"), ("3 Days to Kill".into(), Some("2014".into())));
        assert_eq!(clean_title("VOD: Dune Part Two (2024) 4K HDR"), ("Dune Part Two".into(), Some("2024".into())));
    }

    #[test]
    fn best_match_prefers_exact_title_then_votes() {
        let v: Value = serde_json::from_str(
            r#"{"results":[{"id":1,"title":"X2","vote_count":3},{"id":2,"title":"X2: X-Men United","vote_count":9000},
                           {"id":3,"title":"X2","vote_count":5000}]}"#,
        )
        .unwrap();
        assert_eq!(best_match(&v, "X2", false), Some(3));
        assert_eq!(best_match(&serde_json::json!({"results":[]}), "X2", false), None);
    }

    #[test]
    fn normalize_picks_official_trailer_and_cast_fallback() {
        let d: Value = serde_json::from_str(
            r#"{"name":"Show","genres":[{"name":"Drama"}],"number_of_seasons":2,"vote_average":8.36,
                "credits":{"cast":[]},"aggregate_credits":{"cast":[{"name":"A","roles":[{"character":"Hero"}]}]},
                "videos":{"results":[{"site":"YouTube","key":"t1","type":"Teaser"},
                                     {"site":"YouTube","key":"t2","type":"Trailer","official":true},
                                     {"site":"Vimeo","key":"v","type":"Trailer","official":true}]}}"#,
        )
        .unwrap();
        let m = normalize(true, &d);
        assert_eq!(m.trailer_key.as_deref(), Some("t2"));
        assert_eq!(m.cast[0].character, "Hero");
        assert_eq!(m.rating, 8.4);
        assert_eq!(m.genres, vec!["Drama"]);
    }
}
