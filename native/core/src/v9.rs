//! Read v9's device code out of its WebView/Electron localStorage, so a device that
//! updates from v9 keeps its activation code (same cloud, same playlists and history).
//!
//! Chromium keeps localStorage in a LevelDB: `.log` files (write batches) and `.ldb`
//! tables (snappy-compressed blocks). Entries: key `_<origin>\0\x01<name>`, value
//! `\x01<latin1>`. We read every file, keep the newest value per origin, done.
//! ponytail: no manifest walk; stale tables can only add older (lower seq) values.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const KEY: &[u8] = b"ziptv_device_code";

/// Where v9 kept its storage, relative to v10's `device_code` file.
pub fn candidate_dirs(code_file: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    // Android: code_file = <data>/files/device_code; v9 (Capacitor WebView) = <data>/app_webview/...
    if let Some(data) = code_file.parent().and_then(|p| p.parent()) {
        v.push(data.join("app_webview/Default/Local Storage/leveldb"));
        v.push(data.join("app_webview/Local Storage/leveldb"));
    }
    // Windows: v9 (Electron) = %APPDATA%/ZIPTV Pro
    if let Some(app) = std::env::var_os("APPDATA") {
        v.push(PathBuf::from(app).join("ZIPTV Pro/Local Storage/leveldb"));
    }
    v
}

pub fn device_code(dirs: &[PathBuf]) -> Option<String> {
    dirs.iter().find_map(|d| from_dir(d))
}

/// origin -> (sequence, code or None when deleted)
type Seen = HashMap<Vec<u8>, (u64, Option<String>)>;

fn from_dir(dir: &Path) -> Option<String> {
    let mut seen = Seen::new();
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        let Ok(bytes) = std::fs::read(&p) else { continue };
        match p.extension().and_then(|x| x.to_str()) {
            Some("log") => read_log(&bytes, &mut seen),
            Some("ldb") | Some("sst") => { let _ = read_table(&bytes, &mut seen); }
            _ => {}
        }
    }
    // The app's own origin first (Electron: local server; Capacitor: localhost), then any.
    let rank = |o: &[u8]| if o.windows(9).any(|w| w == b"localhost") { 0 } else { 1 };
    let mut found: Vec<_> = seen.into_iter().filter_map(|(o, (s, c))| Some((rank(&o), u64::MAX - s, c?))).collect();
    found.sort();
    found.into_iter().next().map(|(_, _, c)| c)
}

fn record(key: &[u8], seq: u64, value: Option<&[u8]>, seen: &mut Seen) {
    // key = "_" origin "\0" "\x01" name
    let Some(nul) = key.iter().position(|&b| b == 0) else { return };
    if key.first() != Some(&b'_') || key.get(nul + 1) != Some(&1) || &key[nul + 2..] != KEY { return }
    let code = match value {
        Some(v) if v.first() == Some(&1) => {
            let c = String::from_utf8_lossy(&v[1..]).trim().to_string();
            if c.len() < 4 || c.len() > 12 || !c.bytes().all(|b| b.is_ascii_alphanumeric()) { return }
            Some(c.to_uppercase())
        }
        Some(_) => return, // UTF-16 or junk: a code is always latin1
        None => None,
    };
    let origin = key[1..nul].to_vec();
    let e = seen.entry(origin).or_insert((0, None));
    if seq >= e.0 { *e = (seq, code); }
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let x = *b.get(*i)?;
        *i += 1;
        v |= ((x & 0x7f) as u64) << shift;
        if x < 0x80 { return Some(v) }
    }
    None
}

fn slice<'a>(b: &'a [u8], i: &mut usize, n: usize) -> Option<&'a [u8]> {
    let s = b.get(*i..*i + n)?;
    *i += n;
    Some(s)
}

/// Log = 32 KiB blocks of records (crc4 len2 type1 data); FIRST/MIDDLE/LAST fragments join.
fn read_log(b: &[u8], seen: &mut Seen) {
    let (mut i, mut batch) = (0usize, Vec::new());
    while i + 7 <= b.len() {
        let left = 32768 - i % 32768;
        if left < 7 { i += left; continue }
        let len = u16::from_le_bytes([b[i + 4], b[i + 5]]) as usize;
        let kind = b[i + 6];
        let Some(data) = b.get(i + 7..i + 7 + len) else { break };
        i += 7 + len;
        match kind {
            1 => { let _ = read_batch(data, seen); }
            2 => batch = data.to_vec(),
            3 => batch.extend_from_slice(data),
            4 => { batch.extend_from_slice(data); let _ = read_batch(&batch, seen); batch.clear(); }
            _ => { if len == 0 { i += left - 7; } } // zero padding to the block end
        }
    }
}

fn read_batch(b: &[u8], seen: &mut Seen) -> Option<()> {
    let seq = u64::from_le_bytes(b.get(..8)?.try_into().ok()?);
    let count = u32::from_le_bytes(b.get(8..12)?.try_into().ok()?);
    let mut i = 12;
    for n in 0..count as u64 {
        let tag = *b.get(i)?;
        i += 1;
        let kl = varint(b, &mut i)? as usize;
        let key = slice(b, &mut i, kl)?;
        if tag == 1 {
            let vl = varint(b, &mut i)? as usize;
            let val = slice(b, &mut i, vl)?;
            record(key, seq + n, Some(val), seen);
        } else {
            record(key, seq + n, None, seen);
        }
    }
    Some(())
}

/// Table: footer (last 48 bytes) -> index block -> data blocks.
fn read_table(b: &[u8], seen: &mut Seen) -> Option<()> {
    let footer = b.get(b.len().checked_sub(48)?..)?;
    let mut i = 0;
    varint(footer, &mut i)?; varint(footer, &mut i)?; // metaindex handle
    let (off, size) = (varint(footer, &mut i)? as usize, varint(footer, &mut i)? as usize);
    let index = block(b, off, size)?;
    for (_, handle) in entries(&index)? {
        let mut j = 0;
        let (o, s) = (varint(&handle, &mut j)? as usize, varint(&handle, &mut j)? as usize);
        let Some(data) = block(b, o, s) else { continue };
        for (ikey, val) in entries(&data).unwrap_or_default() {
            if ikey.len() < 8 { continue }
            let (key, tag) = ikey.split_at(ikey.len() - 8);
            let tag = u64::from_le_bytes(tag.try_into().ok()?);
            record(key, tag >> 8, if tag & 0xff == 1 { Some(&val) } else { None }, seen);
        }
    }
    Some(())
}

fn block(b: &[u8], off: usize, size: usize) -> Option<Vec<u8>> {
    let raw = b.get(off..off + size)?;
    match *b.get(off + size)? {
        0 => Some(raw.to_vec()),
        1 => snap::raw::Decoder::new().decompress_vec(raw).ok(),
        _ => None,
    }
}

/// Block entries: shared, non_shared, value_len varints + key delta + value; restarts at the end.
fn entries(b: &[u8]) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    let restarts = u32::from_le_bytes(b.get(b.len().checked_sub(4)?..)?.try_into().ok()?) as usize;
    let end = b.len().checked_sub(4 + restarts * 4)?;
    let (mut i, mut key, mut out) = (0usize, Vec::new(), Vec::new());
    while i < end {
        let shared = varint(b, &mut i)? as usize;
        let non = varint(b, &mut i)? as usize;
        let vl = varint(b, &mut i)? as usize;
        key.truncate(shared);
        key.extend_from_slice(slice(b, &mut i, non)?);
        out.push((key.clone(), slice(b, &mut i, vl)?.to_vec()));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(seq: u64, entries: &[(&[u8], Option<&[u8]>)]) -> Vec<u8> {
        let mut b = seq.to_le_bytes().to_vec();
        b.extend((entries.len() as u32).to_le_bytes());
        for (k, v) in entries {
            b.push(v.is_some() as u8);
            b.push(k.len() as u8);
            b.extend(*k);
            if let Some(v) = v { b.push(v.len() as u8); b.extend(*v); }
        }
        b
    }

    fn log(batches: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for b in batches {
            out.extend([0, 0, 0, 0]);
            out.extend((b.len() as u16).to_le_bytes());
            out.push(1);
            out.extend(b);
        }
        out
    }

    #[test]
    fn newest_code_wins_and_localhost_preferred() {
        let k_local = b"_http://localhost:56789\0\x01ziptv_device_code";
        let k_web = b"_https://ziptvpro.pages.dev\0\x01ziptv_device_code";
        let other = b"_http://localhost:56789\0\x01ziptv_device_state";
        let bytes = log(&[
            batch(5, &[(k_local, Some(b"\x01OLD234")), (k_web, Some(b"\x01WEB234"))]),
            batch(9, &[(other, Some(b"\x01{}")), (k_local, Some(b"\x01NEW234"))]),
        ]);
        let dir = std::env::temp_dir().join(format!("ziptv_v9_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("000003.log"), &bytes).unwrap();
        assert_eq!(device_code(&[dir.clone()]).as_deref(), Some("NEW234"));
        // Deleted on localhost -> fall back to the other origin.
        let bytes2 = [bytes, log(&[batch(12, &[(k_local, None)])])].concat();
        std::fs::write(dir.join("000003.log"), &bytes2).unwrap();
        assert_eq!(device_code(&[dir.clone()]).as_deref(), Some("WEB234"));
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod live {
    /// cargo test --lib v9::live -- --ignored --nocapture   (reads this PC's real v9 storage)
    #[test]
    #[ignore]
    fn this_pc() {
        let dirs = super::candidate_dirs(std::path::Path::new("/nonexistent/files/device_code"));
        for d in &dirs { println!("{} -> {:?}", d.display(), super::from_dir(d)); }
    }
}
