//! Per-playlist user data: favorites, pins, recently watched, continue-watching
//! positions, reminders and settings. One small JSON file, rewritten on change.

use crate::ContentKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WatchProgress {
    /// "movie:123", "episode:456" or "live:789".
    pub key: String,
    pub kind: ContentKind,
    pub title: String,
    pub subtitle: String,
    pub image: Option<String>,
    /// Everything needed to resume without a lookup (stream/episode id, extension, series id).
    pub stream_id: String,
    pub extension: Option<String>,
    pub series_id: Option<String>,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub updated_at: i64,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Reminder {
    pub stream_id: String,
    pub channel_name: String,
    pub title: String,
    pub start: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    favorites: HashMap<String, Vec<String>>,
    #[serde(default)]
    pinned: HashMap<String, Vec<String>>,
    #[serde(default)]
    recent: Vec<String>,
    #[serde(default)]
    progress: Vec<WatchProgress>,
    #[serde(default)]
    reminders: Vec<Reminder>,
    #[serde(default)]
    settings: HashMap<String, String>,
}

fn kind_key(k: ContentKind) -> &'static str {
    match k {
        ContentKind::Live => "live",
        ContentKind::Movie => "movie",
        ContentKind::Series => "series",
    }
}

const RECENT_MAX: usize = 30;
const PROGRESS_MAX: usize = 60;

#[derive(uniffi::Object)]
pub struct UserStore {
    path: String,
    data: RwLock<Data>,
}

#[uniffi::export]
impl UserStore {
    /// Opens (or starts) the store at `path`. A missing or corrupt file starts empty.
    #[uniffi::constructor]
    pub fn new(path: String) -> Arc<Self> {
        let data = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Self { path, data: RwLock::new(data) })
    }

    pub fn is_favorite(&self, kind: ContentKind, id: String) -> bool {
        self.data.read().unwrap().favorites.get(kind_key(kind)).is_some_and(|v| v.contains(&id))
    }

    /// Returns the new state (true = now a favorite).
    pub fn toggle_favorite(&self, kind: ContentKind, id: String) -> bool {
        let on = self.toggle(|d| d.favorites.entry(kind_key(kind).into()).or_default(), id);
        self.persist();
        on
    }

    /// Most recently added first.
    pub fn favorites(&self, kind: ContentKind) -> Vec<String> {
        self.data.read().unwrap().favorites.get(kind_key(kind)).cloned().unwrap_or_default()
    }

    pub fn toggle_pin(&self, kind: ContentKind, category_id: String) -> bool {
        let on = self.toggle(|d| d.pinned.entry(kind_key(kind).into()).or_default(), category_id);
        self.persist();
        on
    }

    pub fn pinned(&self, kind: ContentKind) -> Vec<String> {
        self.data.read().unwrap().pinned.get(kind_key(kind)).cloned().unwrap_or_default()
    }

    /// Recently watched channels, newest first, de-duplicated.
    pub fn add_recent(&self, stream_id: String) {
        {
            let mut d = self.data.write().unwrap();
            d.recent.retain(|s| s != &stream_id);
            d.recent.insert(0, stream_id);
            d.recent.truncate(RECENT_MAX);
        }
        self.persist();
    }

    pub fn recent(&self) -> Vec<String> {
        self.data.read().unwrap().recent.clone()
    }

    /// Saves a resume point. Finished items (>= 95%) drop off Continue Watching.
    pub fn set_progress(&self, p: WatchProgress) {
        {
            let mut d = self.data.write().unwrap();
            d.progress.retain(|x| x.key != p.key);
            let finished = p.duration_ms > 0 && p.position_ms * 100 >= p.duration_ms * 95;
            if !finished {
                d.progress.insert(0, p);
                d.progress.truncate(PROGRESS_MAX);
            }
        }
        self.persist();
    }

    pub fn progress(&self, key: String) -> Option<WatchProgress> {
        self.data.read().unwrap().progress.iter().find(|p| p.key == key).cloned()
    }

    pub fn remove_progress(&self, key: String) {
        self.data.write().unwrap().progress.retain(|p| p.key != key);
        self.persist();
    }

    /// Movies/episodes started but not finished, newest first.
    pub fn continue_watching(&self) -> Vec<WatchProgress> {
        self.data.read().unwrap().progress.iter().filter(|p| p.kind != ContentKind::Live).cloned().collect()
    }

    pub fn add_reminder(&self, r: Reminder) {
        {
            let mut d = self.data.write().unwrap();
            d.reminders.retain(|x| !(x.stream_id == r.stream_id && x.start == r.start));
            d.reminders.push(r);
            d.reminders.sort_by_key(|x| x.start);
        }
        self.persist();
    }

    pub fn remove_reminder(&self, stream_id: String, start: i64) {
        self.data.write().unwrap().reminders.retain(|x| !(x.stream_id == stream_id && x.start == start));
        self.persist();
    }

    pub fn reminders(&self) -> Vec<Reminder> {
        self.data.read().unwrap().reminders.clone()
    }

    /// Reminders whose start is within `lead_secs` of `now` (and not past by more
    /// than 5 min); they are removed so each fires once.
    pub fn due_reminders(&self, now: i64, lead_secs: i64) -> Vec<Reminder> {
        let due: Vec<Reminder> = {
            let mut d = self.data.write().unwrap();
            let (due, keep): (Vec<_>, Vec<_>) =
                d.reminders.drain(..).partition(|r| r.start - now <= lead_secs && now - r.start <= 300);
            d.reminders = keep.into_iter().filter(|r| now - r.start <= 300).collect();
            due
        };
        if !due.is_empty() {
            self.persist();
        }
        due
    }

    pub fn setting(&self, key: String) -> Option<String> {
        self.data.read().unwrap().settings.get(&key).cloned()
    }

    pub fn set_setting(&self, key: String, value: Option<String>) {
        {
            let mut d = self.data.write().unwrap();
            match value {
                Some(v) => d.settings.insert(key, v),
                None => d.settings.remove(&key),
            };
        }
        self.persist();
    }
}

impl UserStore {
    fn toggle(&self, list: impl FnOnce(&mut Data) -> &mut Vec<String>, id: String) -> bool {
        let mut d = self.data.write().unwrap();
        let l = list(&mut d);
        if let Some(i) = l.iter().position(|x| x == &id) {
            l.remove(i);
            false
        } else {
            l.insert(0, id);
            true
        }
    }

    fn persist(&self) {
        // ponytail: whole-file rewrite on every change; the file is a few KB.
        if let Ok(bytes) = serde_json::to_vec(&*self.data.read().unwrap()) {
            let tmp = format!("{}.tmp", self.path);
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        std::env::temp_dir().join(format!("ziptv-test-{name}-{}.json", std::process::id())).to_string_lossy().into()
    }

    #[test]
    fn favorites_toggle_and_persist() {
        let path = tmp("fav");
        let s = UserStore::new(path.clone());
        assert!(s.toggle_favorite(ContentKind::Live, "7".into()));
        assert!(s.is_favorite(ContentKind::Live, "7".into()));
        let reopened = UserStore::new(path.clone());
        assert_eq!(reopened.favorites(ContentKind::Live), vec!["7".to_string()]);
        assert!(!reopened.toggle_favorite(ContentKind::Live, "7".into()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn progress_drops_finished_and_live_is_not_continue_watching() {
        let s = UserStore::new(tmp("prog"));
        let mk = |key: &str, kind, pos, dur| WatchProgress {
            key: key.into(), kind, title: key.into(), subtitle: String::new(), image: None,
            stream_id: "1".into(), extension: None, series_id: None, position_ms: pos, duration_ms: dur, updated_at: 0,
        };
        s.set_progress(mk("movie:1", ContentKind::Movie, 10_000, 100_000));
        s.set_progress(mk("movie:2", ContentKind::Movie, 99_000, 100_000)); // finished
        s.set_progress(mk("live:3", ContentKind::Live, 0, 0));
        let cw: Vec<String> = s.continue_watching().into_iter().map(|p| p.key).collect();
        assert_eq!(cw, vec!["movie:1"]);
    }

    #[test]
    fn reminders_fire_once() {
        let s = UserStore::new(tmp("rem"));
        s.add_reminder(Reminder { stream_id: "1".into(), channel_name: "CNN".into(), title: "News".into(), start: 1000 });
        assert!(s.due_reminders(500, 60).is_empty());
        assert_eq!(s.due_reminders(950, 60).len(), 1);
        assert!(s.due_reminders(960, 60).is_empty());
    }
}
