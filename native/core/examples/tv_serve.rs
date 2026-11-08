// cargo run --example tv_serve   Serves the TV page + cast routes from the desktop app's saved
// playlist (~/.ziptv10) on :8795. Progress/recordings go to a temp copy, never the real files.
fn main() {
    let home = std::path::PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap()).join(".ziptv10");
    let line = std::fs::read_to_string(home.join("playlists.tsv")).unwrap().lines().next().unwrap().to_string();
    let f: Vec<&str> = line.split('\t').collect();
    let p = ziptv_core::Provider::new(f[1].into(), f[2].into(), f[3].into());
    let catalog = std::fs::read_dir(&home).unwrap().flatten().map(|e| e.path())
        .find(|x| x.file_name().unwrap().to_string_lossy().starts_with("catalog-")).unwrap();
    println!("catalog loaded: {}", p.load(catalog.to_string_lossy().into()));
    let tmp = std::env::temp_dir().join("ziptv_tv_serve");
    std::fs::create_dir_all(&tmp).unwrap();
    if let Some(u) = std::fs::read_dir(&home).unwrap().flatten().map(|e| e.path()).find(|x| x.file_name().unwrap().to_string_lossy().starts_with("user-")) {
        std::fs::copy(u, tmp.join("user.json")).unwrap();
    }
    let user = ziptv_core::UserStore::new(tmp.join("user.json").to_string_lossy().into());
    let s = ziptv_core::LanServer::new(8795);
    s.set_provider(Some(p), Some(user), f[0].into());
    s.set_recorder(Some(ziptv_core::Recorder::new(tmp.join("rec").to_string_lossy().into())));
    // TMDB token from the repo's .env (same one the build packages); details work without it too.
    if let Some(tok) = std::fs::read_to_string("../../.env").ok().and_then(|e| e.lines().find_map(|l| l.strip_prefix("TMDB_TOKEN=").map(|t| t.trim().trim_matches('"').to_string()))) {
        s.set_tmdb(Some(ziptv_core::Tmdb::new(tok, tmp.join("tmdb.json").to_string_lossy().into())));
    }
    println!("TV page: {:?}", s.tv_url());
    loop { std::thread::sleep(std::time::Duration::from_secs(3600)); }
}
