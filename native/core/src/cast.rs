//! Casting API for the app: find receivers (DLNA + Chromecast), play the current item on
//! one, control it. Receivers fetch the stream themselves from our LanServer (`/cast/...`).

use crate::chromecast::{self, Session};
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
    /// "dlna" or "chromecast".
    pub kind: String,
}

#[derive(uniffi::Record, Clone)]
pub struct CastStatus {
    pub position_secs: f64,
    pub duration_secs: f64,
}

#[derive(Clone)]
enum Device { Dlna(Renderer), Cast(chromecast::Device) }

impl Device {
    fn id(&self) -> &str { match self { Device::Dlna(r) => &r.id, Device::Cast(c) => &c.id } }
    fn name(&self) -> &str { match self { Device::Dlna(r) => &r.name, Device::Cast(c) => &c.name } }
    fn host(&self) -> &str { match self { Device::Dlna(r) => &r.host, Device::Cast(c) => &c.host } }
}

enum Active { Dlna(Renderer), Cast(Session) }

#[derive(uniffi::Object)]
pub struct Caster {
    server: Arc<LanServer>,
    devices: Mutex<Vec<Device>>,
    active: Mutex<Option<(String, Active)>>,
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

    /// Blocks ~3 s (SSDP + mDNS in parallel). Call off the UI thread.
    pub fn discover(&self) -> Vec<CastDevice> {
        let wait = Duration::from_secs(3);
        let (dl, cc) = std::thread::scope(|s| {
            let a = s.spawn(|| dlna::discover(wait));
            let b = s.spawn(|| chromecast::discover(wait));
            (a.join().unwrap_or_default(), b.join().unwrap_or_default())
        });
        // A Chromecast-built-in TV often also answers DLNA: keep its Cast entry only.
        let cast_hosts: Vec<String> = cc.iter().map(|c| c.host.clone()).collect();
        let mut all: Vec<Device> = cc.into_iter().map(Device::Cast).collect();
        all.extend(dl.into_iter().filter(|r| !cast_hosts.contains(&r.host)).map(Device::Dlna));
        let out = all.iter().map(|d| CastDevice {
            id: d.id().to_string(), name: d.name().to_string(),
            kind: if matches!(d, Device::Cast(_)) { "chromecast" } else { "dlna" }.into(),
        }).collect();
        *self.devices.lock().unwrap() = all;
        out
    }

    /// `kind`: "live" | "movie" | "series"; `ext`: ts / m3u8 / mp4 / mkv …
    pub fn play(&self, device_id: String, kind: String, stream_id: String, ext: String, title: String) -> Result<(), CoreError> {
        let d = self.devices.lock().unwrap().iter().find(|d| d.id() == device_id).cloned()
            .ok_or_else(|| err("TV not found, search again".into()))?;
        if self.server.port() == 0 { return Err(err("Could not start the cast server (port in use)".into())); }
        self.stop();
        let live = kind == "live";
        let base = self.server.base_url(Some(d.host().to_string()));
        match &d {
            Device::Dlna(r) => {
                // Samsung/generic DLNA: raw MPEG-TS for live (v9).
                let ext = if ext.is_empty() { if live { "ts".into() } else { "mp4".into() } } else { ext.to_ascii_lowercase() };
                let url = format!("{base}/cast/{kind}/{stream_id}.{ext}");
                let (mime, features) = dlna_profile(live, &ext);
                r.play(&url, &title, mime, &features).map_err(|e| {
                    // Same diagnostics as v9: is OUR server answering, and what does the TV accept?
                    let pre = ureq::head(&url).timeout(Duration::from_secs(5)).call().map(|x| x.status().to_string())
                        .unwrap_or_else(|_| "no response".into());
                    err(format!("{e} | server {pre} | TV accepts: {}", r.sinks()))
                })?;
                *self.active.lock().unwrap() = Some((r.name.clone(), Active::Dlna(r.clone())));
            }
            Device::Cast(c) => {
                // Chromecast can't play raw TS: live goes as HLS through our CORS proxy.
                let ext = if live { "m3u8".to_string() } else if ext.is_empty() { "mp4".into() } else { ext.to_ascii_lowercase() };
                let url = format!("{base}/cast/{kind}/{stream_id}.{ext}");
                let mime = if live { "application/x-mpegurl" } else { dlna_profile(false, &ext).0 };
                let s = Session::play(c, &url, mime, live, &title).map_err(err)?;
                *self.active.lock().unwrap() = Some((c.name.clone(), Active::Cast(s)));
            }
        }
        Ok(())
    }

    pub fn pause(&self) -> Result<(), CoreError> {
        self.with(|a| match a { Active::Dlna(r) => r.pause(), Active::Cast(s) => { s.pause(); Ok(()) } })
    }
    pub fn resume(&self) -> Result<(), CoreError> {
        self.with(|a| match a { Active::Dlna(r) => r.resume(), Active::Cast(s) => { s.resume(); Ok(()) } })
    }
    pub fn seek(&self, secs: u64) -> Result<(), CoreError> {
        self.with(|a| match a { Active::Dlna(r) => r.seek(secs), Active::Cast(s) => { s.seek(secs as f64); Ok(()) } })
    }
    /// 0..=100
    pub fn volume(&self, level: u32) -> Result<(), CoreError> {
        self.with(|a| match a { Active::Dlna(r) => r.volume(level), Active::Cast(s) => { s.volume(level as f64 / 100.0); Ok(()) } })
    }

    pub fn stop(&self) {
        if let Some((_, a)) = self.active.lock().unwrap().take() {
            match a { Active::Dlna(r) => { let _ = r.stop(); } Active::Cast(s) => s.stop() }
        }
    }

    pub fn status(&self) -> Option<CastStatus> {
        let g = self.active.lock().unwrap();
        match &g.as_ref()?.1 {
            Active::Dlna(r) => { let r = r.clone(); drop(g); r.position().map(|(p, d)| CastStatus { position_secs: p, duration_secs: d }) }
            Active::Cast(s) => { let st = s.status.lock().unwrap(); Some(CastStatus { position_secs: st.position, duration_secs: st.duration }) }
        }
    }

    /// Name of the receiver being cast to, if any.
    pub fn active_name(&self) -> Option<String> {
        self.active.lock().unwrap().as_ref().map(|(n, _)| n.clone())
    }
}

impl Caster {
    fn with(&self, f: impl FnOnce(&Active) -> Result<(), String>) -> Result<(), CoreError> {
        let g = self.active.lock().unwrap();
        let (_, a) = g.as_ref().ok_or_else(|| err("Not casting".into()))?;
        f(a).map_err(err)
    }
}
