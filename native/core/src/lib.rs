//! ZIPTV v10 core: everything that isn't UI or video decoding.
//! Exposed to Kotlin (Android phone/TV + desktop) via uniffi; one Provider per playlist.

mod cloud;
mod epg;
mod m3u;
mod v9;
mod stream;
mod lan;
mod dlna;
mod cast;
mod names;
mod recorder;
mod tmdb;
mod update;
mod user;
mod xtream;

pub use cast::{CastDevice, CastStatus, Caster};
pub use lan::LanServer;
pub use cloud::{Cloud, CloudPlaylist, DeviceState, PairedDevice, VpnConfig, WatchContent, WatchState};
pub use recorder::{Recorder, Recording, RecordingStatus};
pub use tmdb::{CastMember, Meta, Tmdb};
pub use update::{check_update, UpdateInfo};
pub use user::{Reminder, UserStore, WatchProgress};

use epg::KeyIndex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use xtream::{as_i64, field, opt_field, Client};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)] // Kotlin: CoreException.Network etc., .message = the text below
pub enum CoreError {
    #[error("{message}")]
    Network { message: String },
    #[error("{message}")]
    Auth { message: String },
    #[error("{message}")]
    Storage { message: String },
}

#[derive(uniffi::Enum, Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum ContentKind {
    Live,
    Movie,
    Series,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct AccountInfo {
    pub status: String,
    /// Unix seconds; None = no expiry.
    pub expires_at: Option<i64>,
    pub max_connections: u32,
    pub active_connections: u32,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub kind: ContentKind,
    pub count: u32,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Channel {
    pub stream_id: String,
    /// Display name with provider junk stripped ("US: CNN HD" -> "CNN HD").
    pub name: String,
    pub raw_name: String,
    pub category_id: String,
    pub logo: Option<String>,
    /// iptv-org logo, used when the provider's `logo` link is dead (404, bad SSL…).
    #[serde(default)]
    pub alt_logo: Option<String>,
    pub epg_id: Option<String>,
    pub archive_days: u32,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Movie {
    pub stream_id: String,
    pub name: String,
    pub category_id: String,
    pub poster: Option<String>,
    pub rating: f32,
    pub year: Option<String>,
    pub extension: Option<String>,
    /// Unix seconds the provider added it (0 = unknown). Drives "Recently added".
    #[serde(default)]
    pub added: i64,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Series {
    pub series_id: String,
    pub name: String,
    pub category_id: String,
    pub cover: Option<String>,
    pub rating: f32,
    pub year: Option<String>,
    #[serde(default)]
    pub added: i64,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct Programme {
    pub title: String,
    pub description: String,
    pub start: i64,
    pub end: i64,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct Episode {
    pub id: String,
    pub season: u32,
    pub number: u32,
    pub title: String,
    pub plot: String,
    pub image: Option<String>,
    pub extension: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct SyncSummary {
    pub live: u32,
    pub movies: u32,
    pub series: u32,
    /// Lists that failed after retries (their previous copy was kept).
    pub skipped: Vec<String>,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct SearchResults {
    pub channels: Vec<Channel>,
    pub movies: Vec<Movie>,
    pub series: Vec<Series>,
}

#[uniffi::export(callback_interface)]
pub trait SyncListener: Send + Sync {
    fn on_progress(&self, message: String);
}

#[derive(Default, Serialize, Deserialize)]
struct Catalog {
    /// "server|username" the lists belong to; a failed list is only kept when it matches.
    synced_for: String,
    categories: Vec<Category>,
    channels: Vec<Channel>,
    movies: Vec<Movie>,
    series: Vec<Series>,
    /// M3U playlists: stream id -> the entry's own URL.
    #[serde(default)]
    urls: HashMap<String, String>,
}

#[derive(uniffi::Object)]
pub struct Provider {
    client: Client,
    /// Plain M3U playlist URL (a playlist saved with an empty username); None = Xtream.
    m3u: Option<String>,
    owner: String,
    catalog: RwLock<Catalog>,
    logos: RwLock<Option<KeyIndex>>,
    ext_epg: RwLock<Option<(Instant, Arc<KeyIndex>)>>,
    epg_cache: RwLock<HashMap<String, (Instant, Vec<Programme>)>>,
}

#[uniffi::export]
impl Provider {
    #[uniffi::constructor]
    pub fn new(server_url: String, username: String, password: String) -> Arc<Self> {
        let client = Client::new(&server_url, &username, &password);
        let m3u = username.trim().is_empty().then(|| server_url.trim().to_string());
        let owner = match &m3u {
            Some(url) => format!("m3u|{url}"),
            None => format!("{}|{}", client.host(), username),
        };
        Arc::new(Self {
            client,
            m3u,
            owner,
            catalog: RwLock::new(Catalog::default()),
            logos: RwLock::new(None),
            ext_epg: RwLock::new(None),
            epg_cache: RwLock::new(HashMap::new()),
        })
    }

    /// Checks the login. Network failures and bad credentials are separate errors.
    pub fn login(&self) -> Result<AccountInfo, CoreError> {
        if let Some(url) = &self.m3u {
            self.client.probe_m3u(url)?;
            return Ok(AccountInfo { status: "Active".into(), expires_at: None, max_connections: 0, active_connections: 0 });
        }
        let v = self.client.account()?;
        let u = v.get("user_info").cloned().unwrap_or(Value::Null);
        let exp = u.get("exp_date").map(as_i64).filter(|&t| t > 0);
        Ok(AccountInfo {
            status: field(&u, "status"),
            expires_at: exp,
            max_connections: u.get("max_connections").map(as_i64).unwrap_or(0) as u32,
            active_connections: u.get("active_cons").map(as_i64).unwrap_or(0) as u32,
        })
    }

    /// The bundled iptv-org logo index (public/channel-logos.json). Used to fill
    /// channels that have no provider logo.
    pub fn set_logo_index(&self, json: String) -> Result<(), CoreError> {
        let idx: KeyIndex = serde_json::from_str(&json).map_err(|e| CoreError::Storage { message: e.to_string() })?;
        *self.logos.write().unwrap() = Some(idx);
        Ok(())
    }

    /// Downloads the whole catalog, one big list at a time, each retried 3x.
    /// A list that still fails keeps its previous copy (same playlist only).
    pub fn sync(&self, listener: Box<dyn SyncListener>) -> Result<SyncSummary, CoreError> {
        let say = |m: &str| listener.on_progress(m.to_string());
        if let Some(url) = &self.m3u {
            return self.sync_m3u(url, &say);
        }
        let mut skipped = vec![];
        let mut fetch = |action: &str, label: &str| {
            say(label);
            let r = self.client.action(action, "", |n, err| say(&format!("Retrying {label} ({n}/3): {err}")));
            if r.is_none() {
                skipped.push(action.to_string());
            }
            r
        };

        let live_cats = fetch("get_live_categories", "Live categories");
        let live = fetch("get_live_streams", "Live channels");
        let vod_cats = fetch("get_vod_categories", "Movie categories");
        let vod = fetch("get_vod_streams", "Movies");
        let ser_cats = fetch("get_series_categories", "Series categories");
        let ser = fetch("get_series", "Series");
        if skipped.len() == 6 {
            return Err(CoreError::Network {
                message: "The provider closed every download. Check your connection or VPN.".into(),
            });
        }

        say("Saving");
        let mut cat = self.catalog.write().unwrap();
        let same = cat.synced_for == self.owner;
        let logos = self.logos.read().unwrap();

        if let Some(v) = live {
            cat.channels = parse_channels(&v, logos.as_ref());
        } else if !same {
            cat.channels.clear();
        }
        if let Some(v) = vod {
            cat.movies = parse_movies(&v);
        } else if !same {
            cat.movies.clear();
        }
        if let Some(v) = ser {
            cat.series = parse_series(&v);
        } else if !same {
            cat.series.clear();
        }

        let old = std::mem::take(&mut cat.categories);
        let mut cats = vec![];
        for (kind, v) in [(ContentKind::Live, live_cats), (ContentKind::Movie, vod_cats), (ContentKind::Series, ser_cats)] {
            match v {
                Some(v) => cats.extend(parse_categories(&v, kind)),
                None if same => cats.extend(old.iter().filter(|c| c.kind == kind).cloned()),
                None => {}
            }
        }
        count_categories(&mut cats, &cat);
        cat.categories = cats;
        cat.synced_for = self.owner.clone();

        Ok(SyncSummary {
            live: cat.channels.len() as u32,
            movies: cat.movies.len() as u32,
            series: cat.series.len() as u32,
            skipped,
        })
    }

    /// Persist the catalog so the next launch shows content instantly.
    pub fn save(&self, path: String) -> Result<(), CoreError> {
        let cat = self.catalog.read().unwrap();
        let bytes = serde_json::to_vec(&*cat).map_err(|e| CoreError::Storage { message: e.to_string() })?;
        std::fs::write(&path, bytes).map_err(|e| CoreError::Storage { message: e.to_string() })
    }

    /// Returns false when there is no cache, or it belongs to another playlist.
    pub fn load(&self, path: String) -> bool {
        let Ok(bytes) = std::fs::read(&path) else { return false };
        let Ok(cat) = serde_json::from_slice::<Catalog>(&bytes) else { return false };
        if cat.synced_for != self.owner {
            return false;
        }
        *self.catalog.write().unwrap() = cat;
        true
    }

    pub fn categories(&self, kind: ContentKind) -> Vec<Category> {
        self.catalog.read().unwrap().categories.iter().filter(|c| c.kind == kind).cloned().collect()
    }

    /// None = every channel.
    pub fn channels(&self, category_id: Option<String>) -> Vec<Channel> {
        let cat = self.catalog.read().unwrap();
        match category_id {
            Some(id) => cat.channels.iter().filter(|c| c.category_id == id).cloned().collect(),
            None => cat.channels.clone(),
        }
    }

    pub fn movies(&self, category_id: Option<String>) -> Vec<Movie> {
        let cat = self.catalog.read().unwrap();
        match category_id {
            Some(id) => cat.movies.iter().filter(|m| m.category_id == id).cloned().collect(),
            None => cat.movies.clone(),
        }
    }

    pub fn series(&self, category_id: Option<String>) -> Vec<Series> {
        let cat = self.catalog.read().unwrap();
        match category_id {
            Some(id) => cat.series.iter().filter(|s| s.category_id == id).cloned().collect(),
            None => cat.series.clone(),
        }
    }

    /// Case/accent-insensitive substring search; best matches (prefix) first.
    pub fn search(&self, query: String, limit: u32) -> SearchResults {
        let q = fold(&query);
        let cat = self.catalog.read().unwrap();
        if q.len() < 2 {
            return SearchResults { channels: vec![], movies: vec![], series: vec![] };
        }
        let lim = limit as usize;
        SearchResults {
            channels: ranked(&cat.channels, &q, lim, |c| &c.name),
            movies: ranked(&cat.movies, &q, lim, |m| &m.name),
            series: ranked(&cat.series, &q, lim, |s| &s.name),
        }
    }

    pub fn live_url(&self, stream_id: String) -> String {
        if let Some(u) = self.catalog.read().unwrap().urls.get(&stream_id) {
            return u.clone();
        }
        format!("{}/{}.ts", self.client.stream_base("live"), stream_id)
    }

    pub fn movie_url(&self, stream_id: String, extension: Option<String>) -> String {
        if let Some(u) = self.catalog.read().unwrap().urls.get(&stream_id) {
            return u.clone();
        }
        let ext = extension.filter(|e| !e.is_empty()).unwrap_or_else(|| "mp4".into());
        format!("{}/{}.{}", self.client.stream_base("movie"), stream_id, ext)
    }

    /// Catch-up (timeshift) for a past programme. start = unix seconds, duration in minutes.
    /// v9's client build left out `stream=`, which broke catch-up on the APK.
    pub fn catchup_url(&self, stream_id: String, start: i64, duration_min: u32) -> String {
        format!(
            "{}/streaming/timeshift.php?username={}&password={}&stream={}&start={}&duration={}",
            self.client.host(),
            xtream::urlencode(self.client.username()),
            xtream::urlencode(self.client.password()),
            xtream::urlencode(&stream_id),
            xtream::urlencode(&catchup_start(start)),
            duration_min.max(1)
        )
    }

    /// Channels for the given ids, in that order (favorites, recently watched).
    pub fn channels_by_ids(&self, ids: Vec<String>) -> Vec<Channel> {
        let cat = self.catalog.read().unwrap();
        let by: HashMap<&str, &Channel> = cat.channels.iter().map(|c| (c.stream_id.as_str(), c)).collect();
        ids.iter().filter_map(|id| by.get(id.as_str()).map(|c| (*c).clone())).collect()
    }

    pub fn movies_by_ids(&self, ids: Vec<String>) -> Vec<Movie> {
        let cat = self.catalog.read().unwrap();
        let by: HashMap<&str, &Movie> = cat.movies.iter().map(|m| (m.stream_id.as_str(), m)).collect();
        ids.iter().filter_map(|id| by.get(id.as_str()).map(|m| (*m).clone())).collect()
    }

    pub fn series_by_ids(&self, ids: Vec<String>) -> Vec<Series> {
        let cat = self.catalog.read().unwrap();
        let by: HashMap<&str, &Series> = cat.series.iter().map(|s| (s.series_id.as_str(), s)).collect();
        ids.iter().filter_map(|id| by.get(id.as_str()).map(|s| (*s).clone())).collect()
    }

    pub fn recently_added_movies(&self, limit: u32) -> Vec<Movie> {
        let cat = self.catalog.read().unwrap();
        let mut v: Vec<&Movie> = cat.movies.iter().filter(|m| m.added > 0).collect();
        v.sort_by_key(|m| std::cmp::Reverse(m.added));
        v.into_iter().take(limit as usize).cloned().collect()
    }

    pub fn recently_added_series(&self, limit: u32) -> Vec<Series> {
        let cat = self.catalog.read().unwrap();
        let mut v: Vec<&Series> = cat.series.iter().filter(|s| s.added > 0).collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.added));
        v.into_iter().take(limit as usize).cloned().collect()
    }

    pub fn episode_url(&self, episode_id: String, extension: Option<String>) -> String {
        let ext = extension.filter(|e| !e.is_empty()).unwrap_or_else(|| "mp4".into());
        format!("{}/{}.{}", self.client.stream_base("series"), episode_id, ext)
    }

    /// All episodes of a series, sorted by season then episode.
    pub fn episodes(&self, series_id: String) -> Result<Vec<Episode>, CoreError> {
        let v = self
            .client
            .action("get_series_info", &format!("&series_id={series_id}"), |_, _| {})
            .ok_or_else(|| CoreError::Network { message: "Could not load episodes".into() })?;
        Ok(parse_episodes(&v))
    }

    /// Guide for one channel: external guide first (provider EPG is often
    /// wrong), provider as fallback. Cached 30 min per channel.
    pub fn epg(&self, stream_id: String) -> Vec<Programme> {
        if let Some((t, list)) = self.epg_cache.read().unwrap().get(&stream_id) {
            if t.elapsed() < Duration::from_secs(1800) {
                return list.clone();
            }
        }
        let channel = self.catalog.read().unwrap().channels.iter().find(|c| c.stream_id == stream_id).cloned();
        let ext = channel.as_ref().and_then(|c| {
            let idx = self.external_index()?;
            epg::external(&self.client, &idx, &c.raw_name, c.epg_id.as_deref())
        });
        // M3U has no player_api to ask; the external guide is all there is.
        let list = ext.unwrap_or_else(|| if self.m3u.is_some() { vec![] } else { epg::provider(&self.client, &stream_id) });
        self.epg_cache.write().unwrap().insert(stream_id, (Instant::now(), list.clone()));
        list
    }
}

impl Provider {
    /// M3U sync: one download (3 tries), parse, replace the catalog.
    fn sync_m3u(&self, url: &str, say: &dyn Fn(&str)) -> Result<SyncSummary, CoreError> {
        say("Playlist");
        let mut text = None;
        let mut last = String::new();
        for n in 1..=3 {
            match self.client.get_text(url) {
                Ok(t) => { text = Some(t); break; }
                Err(e) => { last = e.to_string(); say(&format!("Retrying playlist ({n}/3): {last}")); }
            }
        }
        let Some(text) = text else { return Err(CoreError::Network { message: last }) };
        say("Saving");
        let parsed = m3u::parse(&text, self.logos.read().unwrap().as_ref());
        let mut cat = self.catalog.write().unwrap();
        cat.channels = parsed.channels;
        cat.movies = parsed.movies;
        cat.series.clear();
        cat.urls = parsed.urls;
        let mut cats = parsed.categories;
        count_categories(&mut cats, &cat);
        cat.categories = cats;
        cat.synced_for = self.owner.clone();
        Ok(SyncSummary { live: cat.channels.len() as u32, movies: cat.movies.len() as u32, series: 0, skipped: vec![] })
    }

    fn external_index(&self) -> Option<Arc<KeyIndex>> {
        if let Some((t, idx)) = self.ext_epg.read().unwrap().as_ref() {
            if t.elapsed() < Duration::from_secs(6 * 3600) {
                return Some(idx.clone());
            }
        }
        let v = self.client.get_json(&format!("{}index.json", epg::EXT_BASE))?;
        let idx = Arc::new(serde_json::from_value::<KeyIndex>(v).ok()?);
        *self.ext_epg.write().unwrap() = Some((Instant::now(), idx.clone()));
        Some(idx)
    }
}

fn parse_categories(v: &Value, kind: ContentKind) -> Vec<Category> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|c| Category { id: field(c, "category_id"), name: field(c, "category_name"), kind, count: 0 })
                .collect()
        })
        .unwrap_or_default()
}

fn count_categories(cats: &mut [Category], cat: &Catalog) {
    let mut counts: HashMap<(ContentKind, &str), u32> = HashMap::new();
    for c in &cat.channels {
        *counts.entry((ContentKind::Live, c.category_id.as_str())).or_default() += 1;
    }
    for m in &cat.movies {
        *counts.entry((ContentKind::Movie, m.category_id.as_str())).or_default() += 1;
    }
    for s in &cat.series {
        *counts.entry((ContentKind::Series, s.category_id.as_str())).or_default() += 1;
    }
    for c in cats.iter_mut() {
        c.count = counts.get(&(c.kind, c.id.as_str())).copied().unwrap_or(0);
    }
}

fn parse_channels(v: &Value, logos: Option<&KeyIndex>) -> Vec<Channel> {
    let Some(a) = v.as_array() else { return vec![] };
    a.iter()
        .map(|s| {
            let raw = field(s, "name");
            let epg_id = opt_field(s, "epg_channel_id");
            let alt_logo = logos.and_then(|l| l.lookup(&raw, epg_id.as_deref())).map(str::to_string);
            let logo = opt_field(s, "stream_icon").or_else(|| alt_logo.clone());
            Channel {
                stream_id: field(s, "stream_id"),
                name: names::clean_channel_name(&raw),
                raw_name: raw,
                category_id: field(s, "category_id"),
                logo,
                alt_logo,
                epg_id,
                archive_days: s.get("tv_archive_duration").map(as_i64).unwrap_or(0).max(0) as u32,
            }
        })
        .collect()
}

fn parse_movies(v: &Value) -> Vec<Movie> {
    let Some(a) = v.as_array() else { return vec![] };
    a.iter()
        .map(|s| Movie {
            stream_id: field(s, "stream_id"),
            name: field(s, "name").trim().to_string(),
            category_id: field(s, "category_id"),
            poster: opt_field(s, "stream_icon"),
            rating: field(s, "rating").parse().unwrap_or(0.0),
            year: opt_field(s, "year").or_else(|| opt_field(s, "releaseDate")),
            extension: opt_field(s, "container_extension"),
            added: s.get("added").map(as_i64).unwrap_or(0),
        })
        .collect()
}

fn parse_series(v: &Value) -> Vec<Series> {
    let Some(a) = v.as_array() else { return vec![] };
    a.iter()
        .map(|s| Series {
            series_id: field(s, "series_id"),
            name: field(s, "name").trim().to_string(),
            category_id: field(s, "category_id"),
            cover: opt_field(s, "cover"),
            rating: field(s, "rating").parse().unwrap_or(0.0),
            year: opt_field(s, "year").or_else(|| opt_field(s, "releaseDate")),
            added: s.get("last_modified").map(as_i64).unwrap_or(0),
        })
        .collect()
}

/// Xtream timeshift start: "YYYY-MM-DD:HH-MM" in UTC (same as v9's fmtCatchupStart).
fn catchup_start(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant), no chrono dependency
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}:{:02}-{:02}", secs / 3600, (secs % 3600) / 60)
}

/// get_series_info: "episodes" is an object keyed by season ("1": [...]) —
/// some panels send an array of seasons instead, so accept both.
fn parse_episodes(v: &Value) -> Vec<Episode> {
    let mut out = vec![];
    let mut push = |season_key: &str, list: &Value| {
        for e in list.as_array().into_iter().flatten() {
            let info = e.get("info").cloned().unwrap_or(Value::Null);
            out.push(Episode {
                id: field(e, "id"),
                season: e.get("season").map(as_i64).filter(|&s| s > 0).unwrap_or_else(|| season_key.parse().unwrap_or(0)) as u32,
                number: e.get("episode_num").map(as_i64).unwrap_or(0) as u32,
                title: field(e, "title"),
                plot: field(&info, "plot"),
                image: opt_field(&info, "movie_image"),
                extension: opt_field(e, "container_extension"),
            });
        }
    };
    match v.get("episodes") {
        Some(Value::Object(map)) => map.iter().for_each(|(k, list)| push(k, list)),
        Some(Value::Array(seasons)) => seasons.iter().enumerate().for_each(|(i, list)| push(&(i + 1).to_string(), list)),
        _ => {}
    }
    out.sort_by_key(|e| (e.season, e.number));
    out
}

/// Lowercase + strip common accents, so "Telemundo" finds "TELEMUNDO" and "cafe" finds "Café".
fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c => c,
        })
        .collect()
}

fn ranked<T: Clone>(items: &[T], q: &str, limit: usize, name: impl Fn(&T) -> &String) -> Vec<T> {
    // ponytail: linear scan; ~70k items is a few ms in Rust. Add an index if catalogs grow 10x.
    let mut hits: Vec<(u8, &T)> = items
        .iter()
        .filter_map(|it| {
            let n = fold(name(it));
            if n.starts_with(q) {
                Some((0, it))
            } else if n.contains(q) {
                Some((1, it))
            } else {
                None
            }
        })
        .collect();
    hits.sort_by_key(|(rank, _)| *rank);
    hits.into_iter().take(limit).map(|(_, it)| it.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Quiet;
    impl SyncListener for Quiet {
        fn on_progress(&self, _: String) {}
    }

    #[test]
    fn m3u_playlist_logs_in_syncs_and_plays_entry_urls() {
        use std::io::{Read, Write};
        let body = "#EXTM3U\n#EXTINF:-1 group-title=\"News\",CNN\nhttp://cdn/cnn.m3u8\n#EXTINF:-1 group-title=\"Films\",Film\nhttp://cdn/film.mp4\n";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in listener.incoming().take(2) {
                let mut s = s.unwrap();
                let _ = s.read(&mut [0u8; 2048]);
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let p = Provider::new(format!("http://127.0.0.1:{port}/list.m3u"), String::new(), String::new());
        assert!(p.login().is_ok());
        let sum = p.sync(Box::new(Quiet)).unwrap();
        assert_eq!((sum.live, sum.movies), (1, 1));
        let ch = &p.channels(None)[0];
        assert_eq!(p.live_url(ch.stream_id.clone()), "http://cdn/cnn.m3u8");
        let m = &p.movies(None)[0];
        assert_eq!(p.movie_url(m.stream_id.clone(), None), "http://cdn/film.mp4");
        assert_eq!(p.categories(ContentKind::Live)[0].count, 1);
    }

    #[test]
    fn channels_get_clean_names_and_index_logos() {
        let idx: KeyIndex = serde_json::from_str(r#"{"urls":["cnn.png"],"ids":{},"names":{"cnn":0}}"#).unwrap();
        let v: Value = serde_json::from_str(
            r#"[{"stream_id":7,"name":"US: CNN HD","category_id":"3","stream_icon":"","epg_channel_id":null,"tv_archive_duration":"2"},
                {"stream_id":"8","name":"Mine","category_id":3,"stream_icon":"mine.png"}]"#,
        )
        .unwrap();
        let ch = parse_channels(&v, Some(&idx));
        assert_eq!(ch[0].name, "CNN HD");
        assert_eq!(ch[0].stream_id, "7");
        assert_eq!(ch[0].logo.as_deref(), Some("cnn.png"));
        assert_eq!(ch[0].archive_days, 2);
        assert_eq!(ch[1].logo.as_deref(), Some("mine.png")); // provider logo wins
        assert_eq!(ch[1].category_id, "3");
    }

    #[test]
    fn catchup_start_is_utc_xtream_format() {
        assert_eq!(catchup_start(0), "1970-01-01:00-00");
        assert_eq!(catchup_start(1_762_437_600), "2025-11-06:14-00");
    }

    #[test]
    fn episodes_from_object_or_array_sorted() {
        let v: Value = serde_json::from_str(
            r#"{"episodes":{"2":[{"id":"21","episode_num":1,"title":"S2E1"}],
                            "1":[{"id":"12","episode_num":"2","title":"S1E2","container_extension":"mkv"},
                                 {"id":"11","episode_num":1,"title":"S1E1","info":{"plot":"p"}}]}}"#,
        )
        .unwrap();
        let eps = parse_episodes(&v);
        assert_eq!(eps.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["11", "12", "21"]);
        assert_eq!(eps[0].plot, "p");
        assert_eq!(eps[1].extension.as_deref(), Some("mkv"));
        let arr: Value = serde_json::from_str(r#"{"episodes":[[{"id":"1","episode_num":1}]]}"#).unwrap();
        assert_eq!(parse_episodes(&arr)[0].season, 1);
    }

    #[test]
    fn search_is_accent_and_case_insensitive_prefix_first() {
        let items = vec!["Telemundo".to_string(), "My Café".to_string(), "Café TV".to_string()];
        let r = ranked(&items, &fold("cafe"), 10, |s| s);
        assert_eq!(r, vec!["Café TV".to_string(), "My Café".to_string()]);
    }
}
