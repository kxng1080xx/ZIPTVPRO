//! Streams handed to cast receivers and the TV page. Port of v9's server/index.js
//! (dlnaProfile, proxyLiveStream, proxyVodStream) — the Samsung/DLNA and short-session
//! provider fixes are hard-won: keep the flags and behaviour identical.
//!
//! Both proxies are pull-based `Read`s: the HTTP server reads them into the TV's socket,
//! so a slow TV naturally slows the upstream (backpressure) and a dropped TV ends it.

use std::io::{self, Read};
use std::time::{Duration, Instant};

/// Samsung advertises exactly these FLAGS; echoing them back is what made it accept streams.
const FLAGS: &str = "ED100000000000000000000000000000";

/// (mime, contentFeatures.dlna.org) — must match the DIDL protocolInfo sent to the renderer.
pub fn dlna_profile(live: bool, ext: &str) -> (&'static str, String) {
    if live && ext == "m3u8" {
        return ("application/x-mpegurl", format!("DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS={FLAGS}"));
    }
    if live {
        // IPTV live is 188-byte MPEG-TS -> MPEG_TS_NA_ISO, no seek.
        return ("video/mpeg", format!("DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS={FLAGS}"));
    }
    // VOD: never claim a DLNA.ORG_PN (a wrong one = "file not supported"); byte-seek.
    let mime = match ext {
        "mkv" => "video/x-matroska",
        "avi" => "video/avi",
        "mov" => "video/quicktime",
        "ts" => "video/mpeg",
        _ => "video/mp4",
    };
    (mime, format!("DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS={FLAGS}"))
}

fn agent() -> ureq::Agent {
    // timeout_read doubles as v9's idle watchdog: a silently black-holed socket errors
    // after 15 s instead of freezing the picture forever.
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(15))
        .user_agent("VLC/3.0.20")
        .build()
}

/// Ok(response) for 200/206, Err(status) otherwise (0 = network error).
fn get(agent: &ureq::Agent, url: &str, range: Option<String>) -> Result<ureq::Response, u16> {
    let mut r = agent.get(url);
    if let Some(range) = range { r = r.set("Range", &range); }
    match r.call() {
        Ok(resp) if resp.status() == 200 || resp.status() == 206 => Ok(resp),
        Ok(resp) => Err(resp.status()),
        Err(ureq::Error::Status(code, _)) => Err(code),
        Err(_) => Err(0),
    }
}

/// VOD size for the DLNA HEAD probe: 1-byte ranged GET (providers often ignore HEAD).
pub fn upstream_length(url: &str) -> Option<u64> {
    let resp = get(&agent(), url, Some("bytes=0-0".into())).ok()?;
    if let Some(total) = resp.header("content-range").and_then(|cr| cr.rsplit('/').next()).and_then(|t| t.trim().parse().ok()) {
        return Some(total);
    }
    if resp.status() == 200 { resp.header("content-length")?.parse().ok() } else { None }
}

// ---------------------------------------------------------------- live (PTS splice)

/// 33-bit PTS if this 188-byte packet starts a video PES carrying a PTS.
fn ts_video_pts(p: &[u8]) -> Option<u64> {
    if p.len() < 188 || p[0] != 0x47 || p[1] & 0x40 == 0 { return None; }
    let afc = (p[3] >> 4) & 0x3;
    let off = match afc { 2 => return None, 3 => 5 + p[4] as usize, _ => 4 };
    if off + 14 > 188 || p[off..off + 3] != [0, 0, 1] { return None; }
    if !(0xE0..=0xEF).contains(&p[off + 3]) || (p[off + 7] >> 6) & 0x2 == 0 { return None; }
    let q = off + 9;
    Some((((p[q] >> 1) & 0x07) as u64) << 30
        | ((((p[q + 1] as u64) << 7) | (p[q + 2] as u64 >> 1)) & 0x7FFF) << 15
        | ((((p[q + 3] as u64) << 7) | (p[q + 4] as u64 >> 1)) & 0x7FFF))
}

/// a >= b in wrapped 33-bit PTS space.
fn pts_at_or_after(a: u64, b: u64) -> bool {
    (a.wrapping_sub(b).wrapping_add(1 << 33)) % (1 << 33) < (1 << 32)
}

const MAX_SKIP: usize = 48 * 1024 * 1024; // never drop backlog forever (~2 min at 3 Mbps)

/// One unbroken MPEG-TS stream for the TV while the provider cuts sessions (~25 s on some
/// panels): reconnects and drops the reconnect backlog up to the last video PTS already
/// sent, so the TV gets byte-continuous video with no replay and no drift.
pub struct LiveReader {
    agent: ureq::Agent,
    url: String,
    up: Option<Box<dyn Read + Send>>,
    carry: Vec<u8>,
    out: Vec<u8>,
    pos: usize,
    last_pts: Option<u64>,
    skipping: bool,
    skipped: usize,
    fast: u32,
    last_connect: Instant,
}

impl LiveReader {
    /// Err(status) when the very first connect fails: the TV is told the truth fast.
    pub fn open(url: String) -> Result<Self, u16> {
        let agent = agent();
        let resp = get(&agent, &url, None)?;
        Ok(Self {
            agent, url, up: Some(Box::new(resp.into_reader())), carry: vec![], out: vec![], pos: 0,
            last_pts: None, skipping: false, skipped: 0, fast: 0, last_connect: Instant::now(),
        })
    }

    fn reconnect(&mut self) -> bool {
        for attempt in 0..20 {
            if self.last_connect.elapsed() < Duration::from_secs(1) { self.fast += 1 } else { self.fast = 0 }
            self.last_connect = Instant::now();
            if self.fast > 6 { return false; } // source dies immediately: give up cleanly
            match get(&self.agent, &self.url, None) {
                Ok(resp) => {
                    self.up = Some(Box::new(resp.into_reader()));
                    self.skipping = self.last_pts.is_some();
                    self.skipped = 0;
                    self.carry.clear();
                    return true;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(if attempt == 0 { 500 } else { 800 })),
            }
        }
        false
    }

    fn process(&mut self, chunk: &[u8]) {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let Some(start) = buf.iter().position(|&b| b == 0x47) else { return };
        let whole = (buf.len() - start) / 188 * 188;
        self.carry = buf[start + whole..].to_vec();
        let body = &buf[start..start + whole];
        let mut from = 0;
        if self.skipping {
            let found = body.chunks(188).position(|p| {
                ts_video_pts(p).is_some_and(|pts| self.last_pts.is_none_or(|last| pts_at_or_after(pts, last)))
            });
            match found {
                Some(i) => from = i * 188,
                None => {
                    self.skipped += body.len();
                    if self.skipped <= MAX_SKIP { return; } // still in the backlog
                }
            }
            self.skipping = false;
        }
        for p in body[from..].chunks(188) {
            if let Some(pts) = ts_video_pts(p) { self.last_pts = Some(pts); }
        }
        self.out.extend_from_slice(&body[from..]);
    }
}

impl Read for LiveReader {
    fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if self.pos < self.out.len() {
                let n = dst.len().min(self.out.len() - self.pos);
                dst[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
                self.pos += n;
                if self.pos == self.out.len() { self.out.clear(); self.pos = 0; }
                return Ok(n);
            }
            let got = match self.up.as_mut() { Some(up) => up.read(&mut chunk).unwrap_or(0), None => 0 };
            if got == 0 {
                // Provider closed (or errored) the source: reconnect to the original URL.
                if !self.reconnect() { return Ok(0); }
                continue;
            }
            self.process(&chunk[..got]);
        }
    }
}

// ---------------------------------------------------------------- VOD (byte resume)

/// The first upstream answer, mirrored to the TV.
pub struct VodHead {
    pub status: u16,
    pub content_range: Option<String>,
    pub content_length: Option<u64>,
}

/// Movie/episode file that survives provider session cuts: on a drop it reconnects with
/// `Range: bytes=<next byte>-` and keeps filling the same TV response.
pub struct VodReader {
    agent: ureq::Agent,
    url: String,
    up: Option<Box<dyn Read + Send>>,
    base: u64,
    sent: u64,
    total: Option<u64>,
    skip: u64,
    fails: u32,
    session: u64,
}

impl VodReader {
    /// `range`: the TV's Range header. Only open-ended "bytes=N-" gets resume accounting.
    pub fn open(url: String, range: Option<&str>) -> Result<(Self, VodHead), u16> {
        let agent = agent();
        let base = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.strip_suffix('-')).and_then(|n| n.parse().ok());
        // Bounded/suffix ranges: one-shot passthrough (no resume).
        let resp = get(&agent, &url, range.map(str::to_string))?;
        let content_range = resp.header("content-range").map(str::to_string);
        let content_length = resp.header("content-length").and_then(|l| l.parse().ok());
        let total = content_range.as_deref().and_then(|cr| cr.rsplit('/').next()).and_then(|t| t.trim().parse().ok())
            .or(if resp.status() == 200 { content_length } else { None });
        let head = VodHead { status: resp.status(), content_range, content_length };
        let resumable = range.is_none() || base.is_some();
        Ok((Self {
            agent, url, up: Some(Box::new(resp.into_reader())), base: base.unwrap_or(0), sent: 0,
            total: if resumable { total } else { None }, skip: 0, fails: 0, session: 0,
        }, head))
    }

    fn remaining(&self) -> Option<i64> { self.total.map(|t| t as i64 - (self.base + self.sent) as i64) }

    /// Reconnect at the next byte. Err = we owe the TV bytes we can't deliver (cut the socket).
    fn resume(&mut self) -> io::Result<bool> {
        loop {
            if self.session == 0 {
                self.fails += 1;
                if self.fails > 12 { return Err(io::Error::other("source gone")); }
                std::thread::sleep(Duration::from_millis((500u64 << (self.fails - 1).min(4)).min(8000)));
            }
            self.session = 0;
            let at = self.base + self.sent;
            match get(&self.agent, &self.url, Some(format!("bytes={at}-"))) {
                Ok(resp) => {
                    let start = if resp.status() == 206 {
                        resp.header("content-range").and_then(|cr| cr.strip_prefix("bytes "))
                            .and_then(|s| s.split('-').next()).and_then(|s| s.parse().ok()).unwrap_or(0)
                    } else { 0 };
                    if start > at { return Err(io::Error::other("server skipped ahead")); }
                    self.skip = at - start; // a server ignoring Range restarts at 0: drop the overlap
                    self.up = Some(Box::new(resp.into_reader()));
                    return Ok(true);
                }
                Err(416) => return Ok(false), // resumed exactly at EOF: all delivered
                Err(_) => continue,
            }
        }
    }
}

impl Read for VodReader {
    fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
        loop {
            let got = match self.up.as_mut() { Some(up) => up.read(dst), None => Ok(0) };
            match got {
                Ok(0) | Err(_) => {
                    let clean = matches!(got, Ok(0));
                    match self.remaining() {
                        Some(r) if r <= 0 => return Ok(0), // true end of file
                        None if clean => return Ok(0),     // size unknown: trust a clean end
                        _ => {}
                    }
                    if !self.resume()? { return Ok(0); }
                }
                Ok(mut n) => {
                    if self.skip > 0 {
                        let drop = (self.skip as usize).min(n);
                        self.skip -= drop as u64;
                        dst.copy_within(drop..n, 0);
                        n -= drop;
                        if n == 0 { continue; }
                    }
                    self.fails = 0;
                    self.session += n as u64;
                    self.sent += n as u64;
                    return Ok(n);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// Video PES start packet carrying `pts`.
    fn pes(pts: u64) -> Vec<u8> {
        let mut p = vec![0xFFu8; 188];
        p[..4].copy_from_slice(&[0x47, 0x41, 0x00, 0x10]);
        p[4..13].copy_from_slice(&[0, 0, 1, 0xE0, 0, 0, 0x80, 0x80, 5]);
        p[13] = 0x21 | (((pts >> 30) & 0x07) as u8) << 1;
        p[14] = (pts >> 22) as u8;
        p[15] = 0x01 | ((pts >> 14) as u8 & 0xFE);
        p[16] = (pts >> 7) as u8;
        p[17] = 0x01 | ((pts << 1) as u8 & 0xFE);
        p
    }

    #[test]
    fn pts_roundtrip_and_wrap() {
        assert_eq!(ts_video_pts(&pes(123_456_789)), Some(123_456_789));
        assert!(pts_at_or_after(5, (1 << 33) - 5)); // wrapped
        assert!(!pts_at_or_after(10, 20));
    }

    /// Provider sends PTS 1,2,3 then cuts; the next session replays 2,3 (backlog) then 4.
    /// The backlog is dropped; the splice resumes AT the last PTS (v9's >=), because a cut
    /// usually truncates that frame mid-PES and the fresh copy replaces it.
    #[test]
    fn live_splices_reconnect_backlog() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/live.ts", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for (i, s) in l.incoming().take(2).enumerate() {
                let mut s = s.unwrap();
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let pts: &[u64] = if i == 0 { &[1, 2, 3] } else { &[2, 3, 4] };
                let body: Vec<u8> = pts.iter().flat_map(|&p| pes(p * 3000)).collect();
                write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        let mut r = LiveReader::open(url).unwrap();
        let mut seen = vec![];
        let mut buf = [0u8; 188];
        while seen.len() < 5 {
            let mut got = 0;
            while got < 188 { let n = r.read(&mut buf[got..]).unwrap(); assert!(n > 0); got += n; }
            seen.push(ts_video_pts(&buf).unwrap() / 3000);
        }
        assert_eq!(seen, [1, 2, 3, 3, 4]);
    }

    /// Provider cuts the file after 10 bytes; the reader resumes with a Range at byte 10.
    #[test]
    fn vod_resumes_at_byte_offset() {
        let file: Vec<u8> = (0..30u8).collect();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/m.mp4", l.local_addr().unwrap());
        let f = file.clone();
        std::thread::spawn(move || {
            for s in l.incoming().take(2) {
                let mut s = s.unwrap();
                let mut req = [0u8; 1024];
                let n = s.read(&mut req).unwrap();
                let req = String::from_utf8_lossy(&req[..n]).to_lowercase();
                let at: usize = req.split("range: bytes=").nth(1).and_then(|r| r.split('-').next()).and_then(|x| x.parse().ok()).unwrap_or(0);
                // Advertise the full length but cut 20 bytes early on the first session.
                let end = if at == 0 { 10 } else { f.len() };
                write!(s, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {at}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    f.len() - 1, f.len(), f.len() - at).unwrap();
                let _ = s.write_all(&f[at..end]);
            }
        });
        let (mut r, head) = VodReader::open(url, Some("bytes=0-")).unwrap();
        assert_eq!(head.status, 206);
        let mut out = vec![];
        let mut buf = [0u8; 7];
        loop { let n = r.read(&mut buf).unwrap_or(0); if n == 0 { break } out.extend_from_slice(&buf[..n]); }
        assert_eq!(out, file);
    }

    #[test]
    fn profiles_match_v9() {
        assert!(dlna_profile(true, "ts").1.starts_with("DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00"));
        assert_eq!(dlna_profile(false, "mkv").0, "video/x-matroska");
        assert!(!dlna_profile(false, "mp4").1.contains("ORG_PN"));
    }
}
