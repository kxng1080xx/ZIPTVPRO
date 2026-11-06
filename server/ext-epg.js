// External guide (epgshare01 via the `epg-data` branch, built by scripts/build-epg.mjs).
// Preferred over the provider's EPG, which is often wrong. Pure ESM using global
// fetch: shared by the client (xtream-api.js) and the desktop server (index.js).
import { lookupLogo as lookupIndex } from './channel-logos.js'; // same index shape as the logo index

const BASE = 'https://raw.githubusercontent.com/kxng1080xx/ZIPTVPRO/epg-data/';
const INDEX_TTL = 6 * 3600 * 1000;
const RETRY_AFTER_FAIL = 5 * 60 * 1000;
const TIMEOUT = 5000; // some networks block GitHub; never stall the guide on it

let indexP = null;
let indexExpiry = 0;

function getJson(url) {
  return Promise.race([
    fetch(url).then((r) => (r.ok ? r.json() : null)),
    new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT))
  ]).catch(() => null);
}

function loadIndex() {
  if (!indexP || Date.now() > indexExpiry) {
    indexExpiry = Date.now() + INDEX_TTL;
    indexP = getJson(`${BASE}index.json`).then((idx) => {
      if (!idx) indexExpiry = Date.now() + RETRY_AFTER_FAIL;
      return idx;
    });
  }
  return indexP;
}

// channel: { name, epg_channel_id }. Returns listings in the app's shape, or null
// when the external guide has nothing for this channel (caller falls back).
export async function fetchExternalEpg(channel) {
  if (!channel) return null;
  const file = lookupIndex(await loadIndex(), channel);
  if (!file) return null;
  const listings = await getJson(`${BASE}ch/${file}.json`);
  if (!Array.isArray(listings) || !listings.length) return null;
  // ext: already plain text — the server's base64 normalizer must skip these.
  return listings.map((l) => ({ ...l, ext: 1 }));
}
