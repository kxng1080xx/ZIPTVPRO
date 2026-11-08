//! Xtream Codes HTTP client. Blocking (ureq): Kotlin calls it on an IO dispatcher.
//! Lessons carried over from v9:
//!  - big lists are downloaded one at a time and retried (providers/VPNs cut
//!    multi-MB bodies mid-download -> "terminated");
//!  - a list that still fails returns None so the caller can keep the old copy;
//!  - numbers arrive as strings OR numbers, so everything is read via Value.

use crate::CoreError;
use serde_json::Value;
use std::time::Duration;

pub struct Client {
    agent: ureq::Agent,
    base: String,
    host: String,
    username: String,
    password: String,
}

impl Client {
    pub fn new(server_url: &str, username: &str, password: &str) -> Self {
        let mut host = server_url.trim().trim_end_matches('/').to_string();
        if !host.starts_with("http://") && !host.starts_with("https://") {
            host = format!("http://{host}");
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(90))
            .user_agent("VLC/3.0.20")
            .build();
        let base = format!(
            "{host}/player_api.php?username={}&password={}",
            urlencode(username),
            urlencode(password)
        );
        Self { agent, base, host, username: username.to_string(), password: password.to_string() }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn password(&self) -> &str {
        &self.password
    }

    /// "http://host:port/live/user/pass" — stream URLs append "/<id>.<ext>".
    pub fn stream_base(&self, kind: &str) -> String {
        format!("{}/{kind}/{}/{}", self.host, urlencode(&self.username), urlencode(&self.password))
    }

    pub fn get_text(&self, url: &str) -> Result<String, CoreError> {
        let resp = self.agent.get(url).call().map_err(|e| CoreError::Network { message: friendly(&e) })?;
        // Not into_string(): it refuses bodies over 10 MB, and live lists are bigger.
        let mut text = String::new();
        std::io::Read::read_to_string(&mut resp.into_reader(), &mut text)
            .map_err(|_| CoreError::Network { message: "The server closed the connection mid-download".into() })?;
        Ok(text)
    }

    /// Account check. Errors distinguish "can't reach" from "bad login".
    pub fn account(&self) -> Result<Value, CoreError> {
        let text = self.get_text(&self.base)?;
        let v: Value = serde_json::from_str(&text)
            .map_err(|_| CoreError::Auth { message: "Server did not return account data".into() })?;
        let auth = v.pointer("/user_info/auth").map(as_i64).unwrap_or(0);
        if auth != 1 {
            return Err(CoreError::Auth { message: "Invalid username or password".into() });
        }
        Ok(v)
    }

    /// One action, retried. None = still failing after retries (caller keeps old data).
    pub fn action(&self, action: &str, extra: &str, mut on_retry: impl FnMut(u32, &str)) -> Option<Value> {
        let url = format!("{}&action={action}{extra}", self.base);
        for attempt in 1..=3u32 {
            // A non-JSON reply (HTML error page, "max connections reached", a
            // redirect to a notice video) is a FAILURE, not an empty list: treating
            // it as [] wiped the whole catalog when the account was busy.
            let result = self.get_text(&url).and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|_| CoreError::Network {
                    message: format!("provider returned non-JSON ({} bytes)", text.len()),
                })
            });
            match result {
                Ok(v) => return Some(v),
                Err(e) => {
                    on_retry(attempt, &e.to_string());
                    if attempt < 3 {
                        std::thread::sleep(Duration::from_millis(1500 * attempt as u64));
                    }
                }
            }
        }
        None
    }

    /// Cheap M3U check for "add playlist": reads only the first bytes of the link.
    pub fn probe_m3u(&self, url: &str) -> Result<(), CoreError> {
        let resp = self.agent.get(url).call().map_err(|e| CoreError::Network { message: friendly(&e) })?;
        let mut head = [0u8; 1024];
        let n = std::io::Read::read(&mut resp.into_reader(), &mut head).unwrap_or(0);
        let text = String::from_utf8_lossy(&head[..n]);
        if text.trim_start_matches('\u{feff}').trim_start().starts_with("#EXT") {
            Ok(())
        } else {
            Err(CoreError::Auth { message: "That link isn't an M3U playlist".into() })
        }
    }

    pub fn get_json(&self, url: &str) -> Option<Value> {
        self.get_text(url).ok().and_then(|t| serde_json::from_str(&t).ok())
    }
}

/// User-facing text for an HTTP failure. Never includes the URL: Xtream URLs carry
/// the username and password, and ureq's Display put them on screen.
pub fn friendly(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("The server answered HTTP {code}"),
        ureq::Error::Transport(t) => match t.kind() {
            ureq::ErrorKind::Dns => "Server not found (check the address)".into(),
            ureq::ErrorKind::ConnectionFailed => "Couldn't connect to the server".into(),
            ureq::ErrorKind::Io => "The server or your network reset the connection (try a VPN)".into(),
            ureq::ErrorKind::TooManyRedirects => "The server keeps redirecting".into(),
            ureq::ErrorKind::BadStatus | ureq::ErrorKind::BadHeader => "The server sent an invalid reply".into(),
            _ => "Network problem".into(),
        },
    }
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

pub fn as_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Value::String(s) => s.trim().parse::<f64>().map(|f| f as i64).unwrap_or(0),
        Value::Bool(b) => *b as i64,
        _ => 0,
    }
}

pub fn field(v: &Value, key: &str) -> String {
    v.get(key).map(as_str).unwrap_or_default()
}

pub fn opt_field(v: &Value, key: &str) -> Option<String> {
    let s = field(v, key);
    if s.trim().is_empty() { None } else { Some(s) }
}
