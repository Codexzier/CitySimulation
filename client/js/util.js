// Kleine Hilfsfunktionen für den Client.
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

const nf = new Intl.NumberFormat('de-DE');
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : nf.format(Math.round(v)));
export const fmt1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '–' : nf1.format(v));
export function compact(v) {
  if (v >= 10000) return `${nf.format(Math.round(v / 1000))} Tsd.`;
  return fmt(v);
}

// Kumulierte Längen einer flachen Punktliste [x0,z0,x1,z1,...]
export function cumulative(flat) {
  const n = flat.length / 2;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(flat[2 * i] - flat[2 * i - 2], flat[2 * i + 1] - flat[2 * i - 1]);
  }
  return cum;
}

// Punkt und Richtung bei Bogenlänge s → out = [x, z, heading]
export function pointAt(flat, cum, s, out) {
  const n = cum.length;
  if (n === 1) {
    out[0] = flat[0]; out[1] = flat[1]; out[2] = 0;
    return out;
  }
  if (s <= 0) s = 0;
  const total = cum[n - 1];
  if (s >= total) s = total;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1e-6;
  const t = (s - cum[lo]) / seg;
  const ax = flat[2 * lo], az = flat[2 * lo + 1], bx = flat[2 * hi], bz = flat[2 * hi + 1];
  out[0] = ax + (bx - ax) * t;
  out[1] = az + (bz - az) * t;
  out[2] = Math.atan2(bx - ax, bz - az);
  return out;
}

export function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export function escapeHtml(t) {
  return String(t ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
