//! Casting API for the app: find receivers, play the current item on one, control it.
//! Receivers fetch the stream themselves from our LanServer (`/cast/...`).
//! ponytail: DLNA only so far; Chromecast plugs in as a second `Device` kind.

use crate::dlna::{self, Renderer};
use crate::lan::LanServer;
use crate::stream::dlna_profile;
use crate::CoreError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(uniffi::Record, Clone)]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    /// "dlna" (later "chromecast").
    pub kind: String,
}

#[derive(uniffi::Record, Clone)]
pub struct CastStatus {
    pub position_secs: f64,
    pub duration_secs: f64,
}

#[derive(uniffi::Object)]
pub struct Caster {
    server: Arc<LanServer>,
    devices: Mutex<Vec<Renderer>>,
    active: Mutex<Option<Renderer>>,
}

fn err(m: String) -> CoreError {
    CoreError::Network { message: m }
}

#[uniffi::export]
impl Caster {
    #[uniffi::constructor]
    pub fn new(server: Arc<LanServer>) -> Arc<Self> {
        Arc::new(Self { server, devices: Mutex::new(vec![]), active: Mutex::new(None) })
    }

    /// Blocks ~3 s (SSDP). Call off the UI thread.
    pub fn discover(&self) -> Vec<CastDevice> {
        let found = dlna::discover(Duration::from_secs(3));
        let out = found.iter().map(|r| CastDevice { id: r.id.clone(), name: r.name.clone(), kind: "dlna".into() }).collect();
        *self.devices.lock().unwrap() = found;
        out
    }

    /// `kind`: "live" | "movie" | "series"; `ext`: ts / m3u8 / mp4 / mkv …
    pub fn play(&self, device_id: String, kind: String, stream_id: String, ext: String, title: String) -> Result<(), CoreError> {
        let r = self.devices.lock().unwrap().iter().find(|r| r.id == device_id).cloned()
            .ok_or_else(|| err("TV not found, search again".into()))?;
        if self.server.port() == 0 { return Err(err("Could not start the cast server (port in use)".into())); }
        let ext = if ext.is_empty() { if kind == "live" { "ts".into() } else { "mp4".into() } } else { ext.to_ascii_lowercase() };
        let url = format!("{}/cast/{kind}/{stream_id}.{ext}", self.server.base_url(Some(r.host.clone())));
        let (mime, features) = dlna_profile(kind == "live", &ext);
        r.play(&url, &title, mime, &features).map_err(|e| {
            // Same diagnostics as v9: is OUR server answering, and what does the TV accept?
            let pre = ureq::head(&url).timeout(Duration::from_secs(5)).call().map(|x| x.status().to_string())
                .unwrap_or_else(|_| "no response".into());
            err(format!("{e} | server {pre} | TV accepts: {}", r.sinks()))
        })?;
        *self.active.lock().unwrap() = Some(r);
        Ok(())
    }

    pub fn pause(&self) -> Result<(), CoreError> { self.with(|r| r.pause()) }
    pub fn resume(&self) -> Result<(), CoreError> { self.with(|r| r.resume()) }
    pub fn seek(&self, secs: u64) -> Result<(), CoreError> { self.with(|r| r.seek(secs)) }
    /// 0..=100
    pub fn volume(&self, level: u32) -> Result<(), CoreError> { self.with(|r| r.volume(level)) }

    pub fn stop(&self) {
        if let Some(r) = self.active.lock().unwrap().take() { let _ = r.stop(); }
    }

    pub fn status(&self) -> Option<CastStatus> {
        let r = self.active.lock().unwrap().clone()?;
        r.position().map(|(p, d)| CastStatus { position_secs: p, duration_secs: d })
    }

    /// Name of the receiver being cast to, if any.
    pub fn active_name(&self) -> Option<String> {
        self.active.lock().unwrap().as_ref().map(|r| r.name.clone())
    }
}

impl Caster {
    fn with(&self, f: impl FnOnce(&Renderer) -> Result<(), String>) -> Result<(), CoreError> {
        let r = self.active.lock().unwrap().clone().ok_or_else(|| err("Not casting".into()))?;
        f(&r).map_err(err)
    }
}
