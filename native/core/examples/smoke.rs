//! Live smoke test against a real provider (not part of `cargo test`: needs network + credentials).
//!   cargo run --release --example smoke -- <server> <user> <pass> [--sync]
//! Login only by default (one tiny request); --sync downloads the whole catalog.
use std::sync::Arc;
use ziptv_core::{Provider, SyncListener};

struct Print;
impl SyncListener for Print {
    fn on_progress(&self, message: String) {
        println!("  .. {message}");
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 3 {
        eprintln!("usage: smoke <server> <user> <pass> [--sync]");
        std::process::exit(2);
    }
    let p: Arc<Provider> = Provider::new(a[0].clone(), a[1].clone(), a[2].clone());
    match p.login() {
        Ok(info) => println!("login ok: status={} max_connections={} expires_at={:?}", info.status, info.max_connections, info.expires_at),
        Err(e) => {
            println!("login failed: {e}");
            std::process::exit(1);
        }
    }
    if a.iter().any(|x| x == "--sync") {
        let t = std::time::Instant::now();
        match p.sync(Box::new(Print)) {
            Ok(s) => println!("sync ok in {:.1}s: live={} movies={} series={} skipped={:?}", t.elapsed().as_secs_f32(), s.live, s.movies, s.series, s.skipped),
            Err(e) => println!("sync failed: {e}"),
        }
    }
}
