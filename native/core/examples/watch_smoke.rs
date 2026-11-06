//! Live check of Watch Together against the cloud: create -> poll -> update -> end.
//! cargo run --release --example watch_smoke -- <data dir with device_code>
use ziptv_core::*;
fn main() {
    let dir = std::env::args().nth(1).expect("data dir");
    let cloud = Cloud::new(format!("{dir}/device_code"), "pc".into(), "10.0.0".into());
    let content = WatchContent { kind: "movie".into(), stream_id: "1".into(), ext: "mp4".into(), name: "Smoke test".into(), logo: "".into() };
    let code = cloud.watch_create("http://example.invalid:8080".into(), content).expect("create");
    println!("created {code}");
    let s = cloud.watch_poll(code.clone()).expect("poll");
    println!("poll: state={} host={} content={:?} server_now_ms={}", s.state, s.host_device, s.content.map(|c| c.name), s.server_now_ms);
    cloud.watch_update(code.clone(), 12.5, false, Some("playing".into())).expect("update");
    let s = cloud.watch_poll(code.clone()).expect("poll2");
    println!("after update: state={} position={} paused={} host_updated_ms={}", s.state, s.position, s.paused, s.host_updated_ms);
    let wrong = cloud.watch_join("http://other.invalid".into(), code.clone()).err().map(|e| e.to_string());
    println!("join from another provider: {wrong:?}");
    cloud.watch_end(code.clone());
    println!("after end: {:?}", cloud.watch_poll(code).map(|s| s.state).map_err(|e| e.to_string()));
}
