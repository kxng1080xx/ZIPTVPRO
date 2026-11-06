//! ZIPTV cloud (device activation, admin-provisioned playlists, expiry, VPN
//! profile, companion pairing, watch-history mirror). Same endpoints and
//! payloads as v9's src/components/cloud-sync.js.

use crate::xtream::{as_i64, as_str, field, opt_field};
use crate::{ContentKind, CoreError, WatchProgress};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Cloudflare Pages only (Vercel dropped in v10). A list so another host can be added later.
const BASES: [&str; 1] = ["https://ziptvpro.pages.dev"];
const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusable chars

#[derive(uniffi::Record, Clone, Debug)]
pub struct CloudPlaylist {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub hidden_tabs: Vec<String>,
    pub hidden_categories: Vec<String>,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct PairedDevice {
    pub device_id: String,
    pub platform: String,
    pub label: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct VpnConfig {
    pub enabled: bool,
    pub version: i64,
    pub ovpn: String,
    pub username: String,
    pub password: String,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct DeviceState {
    /// "pending" (not activated yet), "active", "expired", ...
    pub status: String,
    pub label: Option<String>,
    pub expires_at: Option<String>,
    pub expired: bool,
    pub notice: String,
    pub playlists: Vec<CloudPlaylist>,
    pub companion: Option<PairedDevice>,
    pub vpn: Option<VpnConfig>,
}

#[derive(uniffi::Object)]
pub struct Cloud {
    code: String,
    platform: String,
    app_version: String,
    agent: ureq::Agent,
    preferred: Mutex<usize>,
}

#[uniffi::export]
impl Cloud {
    /// `platform`: "pc" or "apk" (what the admin panel shows). The device code is
    /// created once and kept in `code_file`.
    #[uniffi::constructor]
    pub fn new(code_file: String, platform: String, app_version: String) -> Arc<Self> {
        let code = std::fs::read_to_string(&code_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() >= 4)
            .unwrap_or_else(|| {
                let c = new_code();
                let _ = std::fs::write(&code_file, &c);
                c
            });
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build();
        Arc::new(Self { code, platform, app_version, agent, preferred: Mutex::new(0) })
    }

    pub fn device_code(&self) -> String {
        self.code.clone()
    }

    /// Heartbeat + state: activation status, expiry, admin playlists, VPN, companion.
    pub fn heartbeat(&self) -> Result<DeviceState, CoreError> {
        let v = self.post("/api/device", json!({
            "device_id": self.code, "platform": self.platform, "app_version": self.app_version
        }))?;
        Ok(parse_state(&v))
    }

    /// Mirrors a manually added playlist to this device's cloud record. Returns its id.
    pub fn add_playlist(&self, name: String, server_url: String, username: String, password: String) -> Result<String, CoreError> {
        let v = self.post("/api/device", json!({
            "action": "add_playlist", "device_id": self.code,
            "name": name, "server_url": server_url, "username": username, "password": password, "type": "xtream"
        }))?;
        Ok(field(&v, "id"))
    }

    pub fn remove_playlist(&self, remote_id: String) -> Result<(), CoreError> {
        self.post("/api/device", json!({ "action": "remove_playlist", "device_id": self.code, "playlist_id": remote_id }))
            .map(|_| ())
    }

    pub fn remove_all_playlists(&self) -> Result<(), CoreError> {
        self.post("/api/device", json!({ "action": "remove_all_playlists", "device_id": self.code })).map(|_| ())
    }

    pub fn pair(&self, companion_code: String) -> Result<PairedDevice, CoreError> {
        let v = self.post("/api/device", json!({
            "action": "pair", "device_id": self.code, "companion_code": companion_code.trim().to_uppercase()
        }))?;
        v.get("companion").map(parse_companion).ok_or_else(|| CoreError::Network { message: "Pairing failed".into() })
    }

    pub fn unpair(&self) -> Result<(), CoreError> {
        self.post("/api/device", json!({ "action": "unpair", "device_id": self.code })).map(|_| ())
    }

    /// Best-effort mirror of one Continue Watching entry (never fails the caller).
    pub fn record_history(&self, playlist_id: String, p: WatchProgress) {
        let entry = json!({
            "id": p.key, "type": kind_name(p.kind), "name": p.title, "subtitle": p.subtitle, "logo": p.image,
            "streamId": p.stream_id, "ext": p.extension, "seriesId": p.series_id,
            "position": p.position_ms / 1000, "duration": p.duration_ms / 1000, "updatedAt": p.updated_at,
        });
        let _ = self.post("/api/history", json!({
            "action": "record", "device_id": self.code, "playlist_id": playlist_id, "entries": [entry]
        }));
    }

    pub fn delete_history(&self, playlist_id: String, key: String) {
        let _ = self.post("/api/history", json!({
            "action": "delete", "device_id": self.code, "playlist_id": playlist_id, "item_id": key
        }));
    }

    /// The paired companion's Continue Watching (newest first); empty when unpaired/offline.
    pub fn companion_history(&self, limit: u32) -> Vec<WatchProgress> {
        let Ok(v) = self.post("/api/history", json!({ "action": "companion-list", "device_id": self.code, "limit": limit }))
        else {
            return vec![];
        };
        v.get("entries").and_then(|e| e.as_array()).map(|a| a.iter().filter_map(parse_entry).collect()).unwrap_or_default()
    }
}

impl Cloud {
    /// POST JSON to the first reachable host; a non-JSON error page (ISP block,
    /// challenge) moves on to the next host. JSON errors are real answers.
    fn post(&self, path: &str, body: Value) -> Result<Value, CoreError> {
        let start = *self.preferred.lock().unwrap();
        let mut last = String::from("Cloud unreachable");
        for i in 0..BASES.len() {
            let idx = (start + i) % BASES.len();
            let resp = self.agent.post(&format!("{}{path}", BASES[idx])).send_json(body.clone());
            let (status, text, is_json) = match resp {
                Ok(r) => {
                    let j = r.content_type().contains("json");
                    (r.status(), r.into_string().unwrap_or_default(), j)
                }
                Err(ureq::Error::Status(code, r)) => {
                    let j = r.content_type().contains("json");
                    (code, r.into_string().unwrap_or_default(), j)
                }
                Err(e) => {
                    last = crate::xtream::friendly(&e);
                    continue;
                }
            };
            if !is_json {
                last = format!("Cloud host error {status}");
                continue;
            }
            *self.preferred.lock().unwrap() = idx;
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status >= 400 {
                let msg = v.get("error").map(as_str).filter(|s| !s.is_empty()).unwrap_or(format!("Cloud error {status}"));
                return Err(CoreError::Network { message: msg });
            }
            return Ok(v);
        }
        Err(CoreError::Network { message: last })
    }
}

fn kind_name(k: ContentKind) -> &'static str {
    match k {
        ContentKind::Live => "live",
        ContentKind::Movie => "movie",
        ContentKind::Series => "series",
    }
}

fn new_code() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from OS randomness per instance — enough for a 6-char code.
    (0..6)
        .map(|_| {
            let mut h = RandomState::new().build_hasher();
            h.write_u64(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0));
            CODE_CHARS[(h.finish() % CODE_CHARS.len() as u64) as usize] as char
        })
        .collect()
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().map(as_str).collect()).unwrap_or_default()
}

fn parse_companion(c: &Value) -> PairedDevice {
    PairedDevice { device_id: field(c, "device_id"), platform: field(c, "platform"), label: opt_field(c, "label") }
}

pub(crate) fn parse_state(v: &Value) -> DeviceState {
    DeviceState {
        status: opt_field(v, "status").unwrap_or_else(|| "pending".into()),
        label: opt_field(v, "label"),
        expires_at: opt_field(v, "expires_at"),
        expired: v.get("expired").and_then(|b| b.as_bool()).unwrap_or(false),
        notice: field(v, "notice"),
        playlists: v
            .get("playlists")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .map(|p| CloudPlaylist {
                        id: field(p, "id"),
                        name: opt_field(p, "name").unwrap_or_else(|| "Playlist".into()),
                        server_url: field(p, "server_url"),
                        username: field(p, "username"),
                        password: field(p, "password"),
                        hidden_tabs: strings(p.get("hidden_tabs")),
                        hidden_categories: strings(p.get("hidden_categories")),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        companion: v.get("companion").filter(|c| c.is_object()).map(parse_companion),
        vpn: v.get("vpn").filter(|c| c.is_object()).map(|c| VpnConfig {
            enabled: c.get("enabled").and_then(|b| b.as_bool()).unwrap_or(false),
            version: c.get("version").map(as_i64).unwrap_or(0),
            ovpn: field(c, "ovpn"),
            username: field(c, "username"),
            password: field(c, "password"),
        }),
    }
}

/// History entries come from v9 and v10 devices; read the shared fields leniently.
fn parse_entry(e: &Value) -> Option<WatchProgress> {
    let kind = match field(e, "type").as_str() {
        "movie" => ContentKind::Movie,
        "series" | "episode" => ContentKind::Series,
        _ => return None,
    };
    Some(WatchProgress {
        key: opt_field(e, "id")?,
        kind,
        title: opt_field(e, "name").unwrap_or_default(),
        subtitle: field(e, "subtitle"),
        image: opt_field(e, "logo"),
        stream_id: opt_field(e, "streamId").or_else(|| opt_field(e, "stream_id")).unwrap_or_default(),
        extension: opt_field(e, "ext"),
        series_id: opt_field(e, "seriesId"),
        position_ms: e.get("position").map(as_i64).unwrap_or(0) * 1000,
        duration_ms: e.get("duration").map(as_i64).unwrap_or(0) * 1000,
        updated_at: e.get("updatedAt").map(as_i64).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_state_parses_admin_playlists_and_expiry() {
        let v: Value = serde_json::from_str(
            r#"{"status":"expired","expired":true,"notice":"Renew","expires_at":"2026-01-01",
                "playlists":[{"id":7,"name":"A","server_url":"http://h","username":"u","password":"p",
                              "hidden_tabs":["movies"],"hidden_categories":[12,"13"]}],
                "companion":{"device_id":"AB12CD","platform":"apk","label":null},
                "vpn":{"enabled":true,"version":"3","ovpn":"x","username":"","password":""}}"#,
        )
        .unwrap();
        let s = parse_state(&v);
        assert!(s.expired);
        assert_eq!(s.playlists[0].id, "7");
        assert_eq!(s.playlists[0].hidden_categories, vec!["12", "13"]);
        assert_eq!(s.companion.unwrap().device_id, "AB12CD");
        assert_eq!(s.vpn.unwrap().version, 3);
        assert_eq!(parse_state(&json!({})).status, "pending");
    }

    #[test]
    fn device_code_is_six_unambiguous_chars() {
        let c = new_code();
        assert_eq!(c.len(), 6);
        assert!(c.bytes().all(|b| CODE_CHARS.contains(&b)));
    }
}

// ---------------------------------------------------------------- Watch Together
// Same wire protocol as v9 (functions/api/watch.js), so v9 and v10 devices can share a room.
// Rooms are matched on a SHA-256 of the provider host only; credentials never leave the device.

#[derive(uniffi::Record, Clone, Debug)]
pub struct WatchContent {
    /// "movie" or "series" (an episode), as in v9.
    pub kind: String,
    pub stream_id: String,
    pub ext: String,
    pub name: String,
    pub logo: String,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct WatchState {
    pub code: String,
    /// "lobby" | "playing" | "ended"
    pub state: String,
    /// Host position in seconds when it last reported.
    pub position: f64,
    pub paused: bool,
    pub host_updated_ms: i64,
    pub host_device: String,
    pub guests: Vec<String>,
    pub content: Option<WatchContent>,
    pub server_now_ms: i64,
}

/// "http://Host:8080/" -> sha256("host:8080") hex, like v9's subHash().
pub fn sub_hash(server: &str) -> String {
    use sha2::{Digest, Sha256};
    let key = server.trim().to_lowercase();
    let key = key.trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/');
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// ISO-8601 UTC ("2026-11-06T16:40:10.123Z" or "+00:00") -> unix ms. 0 if unparsable.
fn iso_ms(s: &str) -> i64 {
    let b = s.as_bytes();
    if b.len() < 19 { return 0; }
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let (y, m, d) = (n(0..4), n(5..7), n(8..10));
    let (hh, mm, ss) = (n(11..13), n(14..16), n(17..19));
    let mut ms = 0;
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        ms = format!("{frac:0<3}")[..3].parse().unwrap_or(0);
    }
    // days from civil (Howard Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    ((days * 86400 + hh * 3600 + mm * 60 + ss) * 1000) + ms
}

fn watch_state(v: &Value) -> WatchState {
    let content = v.get("content").filter(|c| c.is_object()).map(|c| WatchContent {
        kind: field(c, "type"), stream_id: field(c, "streamId"), ext: field(c, "ext"),
        name: field(c, "name"), logo: field(c, "logo"),
    });
    WatchState {
        code: field(v, "code"),
        state: field(v, "state"),
        position: v.get("position").and_then(|p| p.as_f64()).unwrap_or(0.0),
        paused: v.get("paused").and_then(|p| p.as_bool()).unwrap_or(true),
        host_updated_ms: iso_ms(&field(v, "host_updated_at")),
        host_device: field(v, "host_device"),
        guests: v.get("guests").and_then(|g| g.as_array())
            .map(|a| a.iter().map(|g| field(g, "device")).collect()).unwrap_or_default(),
        content,
        server_now_ms: iso_ms(&field(v, "server_now")),
    }
}

fn watch_error(e: CoreError) -> CoreError {
    let msg = e.to_string();
    let friendly = match msg.as_str() {
        "not_found" => "That code isn't valid — check it and try again.",
        "subscription_mismatch" => "Can't join — that session is on a different provider.",
        "not_host" => "Only the host can control this session.",
        _ => return e,
    };
    CoreError::Auth { message: friendly.into() }
}

#[uniffi::export]
impl Cloud {
    /// Host: opens a room for `content` on the playlist at `server`. Returns the 4-letter code.
    pub fn watch_create(&self, server: String, content: WatchContent) -> Result<String, CoreError> {
        let v = self.post("/api/watch", serde_json::json!({
            "action": "create", "device_id": self.code, "sub_hash": sub_hash(&server),
            "content": { "type": content.kind, "streamId": content.stream_id, "ext": content.ext,
                         "name": content.name, "logo": content.logo, "backdrop": "" }
        })).map_err(watch_error)?;
        Ok(field(&v, "code"))
    }

    pub fn watch_join(&self, server: String, code: String) -> Result<WatchState, CoreError> {
        self.post("/api/watch", serde_json::json!({
            "action": "join", "code": code.trim().to_uppercase(), "device_id": self.code, "sub_hash": sub_hash(&server)
        })).map(|v| watch_state(&v)).map_err(watch_error)
    }

    /// Err with "That code isn't valid…" once the room is gone (host ended / expired).
    pub fn watch_poll(&self, code: String) -> Result<WatchState, CoreError> {
        self.post("/api/watch", serde_json::json!({ "action": "poll", "code": code, "device_id": self.code }))
            .map(|v| watch_state(&v)).map_err(watch_error)
    }

    /// Host only. `state`: "playing" to release the guests, "ended" to close.
    pub fn watch_update(&self, code: String, position: f64, paused: bool, state: Option<String>) -> Result<(), CoreError> {
        let mut body = serde_json::json!({ "action": "update", "code": code, "device_id": self.code,
                                           "position": position, "paused": paused });
        if let Some(s) = state { body["state"] = Value::String(s); }
        self.post("/api/watch", body).map(|_| ()).map_err(watch_error)
    }

    pub fn watch_end(&self, code: String) {
        let _ = self.post("/api/watch", serde_json::json!({ "action": "end", "code": code, "device_id": self.code }));
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;

    #[test]
    fn sub_hash_matches_v9_normalisation() {
        // v9: lowercase, strip scheme + trailing slashes, then SHA-256 hex.
        assert_eq!(sub_hash("HTTP://Cord-Cutter.net:8080/"), sub_hash("cord-cutter.net:8080"));
        assert_eq!(sub_hash("abc").len(), 64);
        assert_eq!(sub_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn iso_times_parse() {
        assert_eq!(iso_ms("1970-01-01T00:00:01.500Z"), 1500);
        assert_eq!(iso_ms("2000-03-01T00:00:00Z"), 951868800000);
        assert_eq!(iso_ms("2026-11-06T16:40:10.1+00:00"), iso_ms("2026-11-06T16:40:10Z") + 100);
    }
}
