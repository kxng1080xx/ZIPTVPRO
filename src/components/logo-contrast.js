// Dark channel logos (BET's black wordmarks, the black "HBO" in HBO Family)
// vanish on the dark UI. When a channel logo loads, redraw it on a canvas with
// its near-black, colourless pixels turned white — coloured parts are kept.
// Only logos with a transparent background are touched (black text on a white
// box is already readable). Logos whose host blocks CORS can't be read, so they
// stay as-is. Results are cached per URL.

const SEL = '.epg-channel-row-logo img, .home-chtile img, .gsearch-thumb.live img, .tvn-mono img';
const MAX = 200; // px; logos render well below this
const cache = new Map(); // src -> Promise<dataURL | null>

const isDarkNeutral = (r, g, b) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b < 90 && Math.max(r, g, b) - Math.min(r, g, b) < 45;

export function recolor(img) {
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h); // throws when CORS-tainted
  const px = data.data;
  let clear = 0, opaque = 0, dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 40) { clear++; continue; }
    opaque++;
    if (isDarkNeutral(px[i], px[i + 1], px[i + 2])) dark++;
  }
  const total = w * h;
  // Needs a see-through background and a real chunk of dark ink.
  if (clear / total < 0.1 || !opaque || dark / opaque < 0.2) return null;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] && isDarkNeutral(px[i], px[i + 1], px[i + 2])) {
      // ponytail: hard swap to white; anti-aliased edges keep their alpha so they still blend
      px[i] = px[i + 1] = px[i + 2] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

function probe(src) {
  if (!cache.has(src)) {
    cache.set(src, new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => { try { resolve(recolor(im)); } catch (e) { resolve(null); } };
      // Network/provider hiccup: forget it so the next render retries.
      im.onerror = () => { cache.delete(src); resolve(null); };
      im.src = src;
    }));
  }
  return cache.get(src);
}

// load doesn't bubble, so listen in the capture phase for every <img> on the page.
document.addEventListener('load', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.matches(SEL)) return;
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith('data:')) return;
  probe(src).then((url) => {
    if (url && (img.currentSrc || img.src) === src) img.src = url;
  });
}, true);
