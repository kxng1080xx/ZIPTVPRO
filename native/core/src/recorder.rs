//! DVR: records a live stream straight to a .ts file on a background thread.
//! Same on every device (no ffmpeg needed: Xtream live is already MPEG-TS).
//! Providers that drop connections mid-stream get reconnected and the file is
//! appended to, until the end time or stop(). Index kept in recordings.json.
//! ponytail: scheduled recordings live in memory, so they need the app running
//! (v9 behaved the same); persist schedules if users ask for recording while closed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordingStatus {
    Scheduled,
    Recording,
    Done,
    Failed,
}

#[derive(uniffi::Record, Clone, Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub path: String,
    /// Unix seconds.
    pub start: i64,
    pub end: i64,
    pub bytes: u64,
    pub status: RecordingStatus,
    /// Why it failed (or stopped early), for the Recordings row. Never contains the stream URL.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(uniffi::Object)]
pub struct Recorder {
    dir: String,
    list: Arc<Mutex<Vec<Recording>>>,
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[uniffi::export]
impl Recorder {
    /// `dir`: where .ts files and recordings.json live.
    #[uniffi::constructor]
    pub fn new(dir: String) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&dir);
        let mut list: Vec<Recording> = std::fs::read(format!("{dir}/recordings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // Anything "in progress" from a previous run was cut off by the app closing.
        for r in list.iter_mut() {
            if matches!(r.status, RecordingStatus::Recording | RecordingStatus::Scheduled) {
                r.status = if r.bytes > 0 { RecordingStatus::Done } else { RecordingStatus::Failed };
                if r.bytes == 0 {
                    r.error = Some("The app was closed before it started".into());
                }
            }
        }
        Arc::new(Self { dir, list: Arc::new(Mutex::new(list)), stops: Mutex::new(HashMap::new()) })
    }

    /// Records `url` from `start` (unix s; past/now = immediately) until `end`. Returns the id.
    pub fn record(&self, url: String, title: String, channel: String, start: i64, end: i64) -> String {
        let id = format!("{}-{}", start.max(now()), self.list.lock().unwrap().len());
        let safe: String = title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
        let path = format!("{}/{} - {}.ts", self.dir, safe.trim(), id);
        let rec = Recording {
            id: id.clone(), title, channel, path: path.clone(), start, end, bytes: 0, error: None,
            status: if start > now() { RecordingStatus::Scheduled } else { RecordingStatus::Recording },
        };
        self.list.lock().unwrap().insert(0, rec);
        self.save();
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().unwrap().insert(id.clone(), stop.clone());
        let list = self.list.clone();
        let dir = self.dir.clone();
        let rid = id.clone();
        std::thread::spawn(move || {
            while now() < start && !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_secs(1));
            }
            set_status(&list, &dir, &rid, RecordingStatus::Recording, None);
            let (bytes, err) = capture(&url, &path, end, &stop, |b| set_status(&list, &dir, &rid, RecordingStatus::Recording, Some(b)));
            if let Some(r) = list.lock().unwrap().iter_mut().find(|r| r.id == rid) {
                r.error = err;
            }
            set_status(&list, &dir, &rid, if bytes > 0 { RecordingStatus::Done } else { RecordingStatus::Failed }, Some(bytes));
        });
        id
    }

    pub fn stop(&self, id: String) {
        if let Some(s) = self.stops.lock().unwrap().get(&id) {
            s.store(true, Ordering::Relaxed);
        }
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Recording> {
        self.list.lock().unwrap().clone()
    }

    pub fn delete(&self, id: String) {
        self.stop(id.clone());
        let removed = {
            let mut l = self.list.lock().unwrap();
            let pos = l.iter().position(|r| r.id == id);
            pos.map(|i| l.remove(i))
        };
        if let Some(r) = removed {
            let _ = std::fs::remove_file(&r.path);
        }
        self.save();
    }
}

impl Recorder {
    fn save(&self) {
        save(&self.list, &self.dir);
    }
}

fn save(list: &Mutex<Vec<Recording>>, dir: &str) {
    if let Ok(b) = serde_json::to_vec(&*list.lock().unwrap()) {
        let _ = std::fs::write(format!("{dir}/recordings.json"), b);
    }
}

fn set_status(list: &Mutex<Vec<Recording>>, dir: &str, id: &str, status: RecordingStatus, bytes: Option<u64>) {
    {
        let mut l = list.lock().unwrap();
        if let Some(r) = l.iter_mut().find(|r| r.id == id) {
            r.status = status;
            if let Some(b) = bytes {
                r.bytes = b;
            }
        }
    }
    // Progress updates every ~4 MB would rewrite the index constantly; only persist state changes.
    if bytes.is_none() || status != RecordingStatus::Recording {
        save(list, dir);
    }
}

/// Copies the stream into `path` until `end` or `stop`; reconnects (appending) when the
/// provider drops the connection. Returns bytes written and, when it ended early, why.
fn capture(url: &str, path: &str, end: i64, stop: &AtomicBool, progress: impl Fn(u64)) -> (u64, Option<String>) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(20))
        .user_agent("VLC/3.0.20")
        .build();
    let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => f,
        Err(e) => return (0, Some(format!("Couldn't create the file: {e}"))),
    };
    let mut last_err: Option<String> = None;
    let mut total = 0u64;
    let mut last_report = 0u64;
    let mut failures = 0;
    let mut buf = vec![0u8; 64 * 1024];
    while now() < end && !stop.load(Ordering::Relaxed) && failures < 30 {
        let resp = match agent.get(url).call() {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(describe(&e));
                failures += 1;
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        let mut reader = resp.into_reader();
        loop {
            if now() >= end || stop.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    last_err = Some("The provider kept dropping the stream".into());
                    failures += 1;
                    break; // reconnect
                }
                Ok(n) => {
                    if let Err(e) = file.write_all(&buf[..n]) {
                        return (total, Some(format!("Couldn't write the file (disk full?): {e}")));
                    }
                    total += n as u64;
                    failures = 0;
                    if total - last_report > 4 << 20 {
                        last_report = total;
                        progress(total);
                    }
                }
            }
        }
    }
    let _ = file.flush();
    let stopped = stop.load(Ordering::Relaxed);
    let why = if stopped {
        Some("Stopped".into())
    } else if total > 0 && failures < 30 {
        None // ran to the end
    } else {
        last_err.or_else(|| Some("No data from the provider".into()))
    };
    (total, why)
}

/// ureq errors carry the full URL (with the login in it), so only the cause is kept.
fn describe(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(401 | 403, _) => {
            "The provider refused the connection (your plan may allow only one stream at a time)".into()
        }
        ureq::Error::Status(code, _) => format!("The provider answered HTTP {code}"),
        ureq::Error::Transport(t) => format!("Couldn't reach the provider ({})", t.kind()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn records_until_end_and_lists_done() {
        // Tiny local "provider" that sends 3 chunks then closes (forcing a reconnect).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten().take(2) {
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\r\n");
                for _ in 0..3 {
                    let _ = s.write_all(&[0x47u8; 188]);
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("ziptv-rec-{}", std::process::id())).to_string_lossy().to_string();
        let r = Recorder::new(dir.clone());
        let id = r.record(format!("http://127.0.0.1:{port}/live.ts"), "News".into(), "CNN".into(), 0, now() + 3);
        std::thread::sleep(Duration::from_secs(5));
        let rec = r.list().into_iter().find(|x| x.id == id).unwrap();
        assert_eq!(rec.status, RecordingStatus::Done);
        assert!(std::fs::metadata(&rec.path).unwrap().len() >= 188 * 3);
        r.delete(id);
        assert!(r.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refused_stream_fails_with_a_reason_but_no_login() {
        // One-stream plan: the provider refuses the second connection with 403.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            }
        });
        let dir = std::env::temp_dir().join(format!("ziptv-rec-fail-{}", std::process::id())).to_string_lossy().to_string();
        let r = Recorder::new(dir.clone());
        let id = r.record(format!("http://127.0.0.1:{port}/live/secretuser/secretpass/1.ts"), "News".into(), "CNN".into(), 0, now() + 3);
        std::thread::sleep(Duration::from_secs(6));
        let rec = r.list().into_iter().find(|x| x.id == id).unwrap();
        assert_eq!(rec.status, RecordingStatus::Failed);
        let why = rec.error.unwrap();
        assert!(why.contains("refused"), "{why}");
        assert!(!why.contains("secret"), "{why}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
