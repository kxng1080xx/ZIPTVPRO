# Watch-on-your-phone (Cloudflare Quick Tunnel)

Exposes the desktop app's in-process server on a **private, per-launch** URL so the
user can stream their own library on a phone browser — no iOS app, no port
forwarding, and **no traffic through the metered cloud host**. The video rides the
user's own home connection.

## How it works

1. On launch, `main.electron.cjs` generates a random `SHARE_TOKEN` and passes it to
   the in-process server (`server/index.js`).
2. When the user clicks **Start sharing**, `electron/tunnel-manager.cjs` spawns
   `cloudflared tunnel --url http://127.0.0.1:<port>` and parses the assigned
   `https://<random>.trycloudflare.com` URL.
3. The UI (`src/components/share-tunnel.js`) shows a locally-generated **QR code**
   plus that URL with a Copy button, appending the token:
   `https://<random>.trycloudflare.com/?stk=<token>`. (The param is `stk`, not `t` —
   the app uses `t` as a cache-buster on `/api/categories` & `/api/streams`, and a
   collision there 403'd content.) The QR is generated on-device via the `qrcode`
   package — never sent to an online service, since the URL holds the token.
4. The phone opens it. The server's guard middleware only challenges requests that
   arrive **through the tunnel** (identified by Cloudflare's `cf-ray` /
   `cf-connecting-ip` headers) — desktop and LAN casting are never gated. A valid
   token sets a cookie, so playlist/segment requests are authorized automatically.
5. Closing the app (or **Stop sharing**) tears the tunnel down.

## Before building: install deps + bundle the `cloudflared` binary

Run `npm i` (the `qrcode` package is now in `package.json` — needed for the share
QR; if missing at runtime the panel falls back to link-only).



Drop the platform binary into `extraResources/` (already wired into the
`electron-builder` filter, copied to `resources/bin/` at build time):

- Windows: `extraResources/cloudflared.exe`
- macOS/Linux: `extraResources/cloudflared`

Download from Cloudflare's official releases
(`github.com/cloudflare/cloudflared/releases`). In dev (`electron .`), the manager
also falls back to a `cloudflared` already on your PATH, so bundling is only needed
for the packaged installer.

## Wire up the button

`initShareTunnel()` runs at startup and exposes `window.openShareTunnel()`. Point any
menu item / button at it, e.g.:

```html
<button onclick="window.openShareTunnel()">Watch on your phone</button>
```

or in code: `import { openShareTunnel } from './components/share-tunnel.js'`.

## Caveats

- **URL changes every launch.** Quick Tunnels are ephemeral; a stable custom domain
  would require a Cloudflare account + named tunnel (not bundleable per user).
- **Laptop must stay on and awake** while streaming, or the tunnel drops.
- **Cloudflare's free tier isn't meant for heavy public video** (ToS §2.8). Personal,
  per-user scale is fine; a genuinely public many-stranger service should use a VPS
  with generous bandwidth instead.
- The manager auto-restarts `cloudflared` with backoff if it drops mid-session.
