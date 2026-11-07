// cargo run --example cast_scan   (lists DLNA renderers on this network)
fn main() {
    let c = ziptv_core::Caster::new(ziptv_core::LanServer::new(8790));
    for d in c.discover() { println!("{} | {} | {}", d.kind, d.name, d.id); }
}
