// Wegsuche (A*) für Fußgänger und Autos sowie Hilfsfunktionen für Polylinien.
import { MinHeap } from '../util/heap.js';
import { T } from './world.js';

export class PathFinder {
  constructor(world) {
    this.world = world;
    const n = world.size * world.size;
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 1;
    this.heap = new MinHeap();
    this.cache = new Map();
    this.cacheVersion = world.version;
  }

  walkCost(k) {
    const w = this.world;
    if (w.station[k] >= 0) return 1;
    const t = w.type[k];
    if (t === T.ROAD) return w.roadActive[k] ? 1 : 1.4;
    if (w.rail[k]) return 0; // Gleise nur an Bahnübergängen/Haltestellen queren
    if (t === T.PARK) return 1.1;
    if (t === T.PLOT) {
      const p = w.plots[w.plotOf[k]];
      if (p.buildingId !== null) return 0;
      return 1.5;
    }
    return 1.6;
  }

  carCost(k) {
    return this.world.roadActive[k] ? 1 : 0;
  }

  // Liefert ein Array von Kachelindizes oder null.
  find(from, to, mode) {
    if (from < 0 || to < 0) return null;
    if (this.cacheVersion !== this.world.version) {
      this.cache.clear();
      this.cacheVersion = this.world.version;
    }
    const key = `${mode}${from}:${to}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const path = this.search(from, to, mode === 'car' ? this.carCost.bind(this) : this.walkCost.bind(this));
    this.cache.set(key, path);
    if (this.cache.size > 6000) this.cache.delete(this.cache.keys().next().value);
    return path;
  }

  search(from, to, costFn) {
    const w = this.world;
    const s = w.size;
    if (from === to) return [from];
    const gen = ++this.gen;
    const { g, came, stamp, closed, heap } = this;
    heap.clear();
    const tx = to % s;
    const tz = (to / s) | 0;
    stamp[from] = gen;
    g[from] = 0;
    came[from] = -1;
    heap.push(Math.abs((from % s) - tx) + Math.abs(((from / s) | 0) - tz), from);
    const nb = [0, 0, 0, 0];
    while (heap.size) {
      const k = heap.pop();
      if (closed[k] === gen) continue;
      closed[k] = gen;
      if (k === to) break;
      const i = k % s;
      let c = 0;
      if (i > 0) nb[c++] = k - 1;
      if (i < s - 1) nb[c++] = k + 1;
      if (k >= s) nb[c++] = k - s;
      if (k < s * (s - 1)) nb[c++] = k + s;
      for (let q = 0; q < c; q++) {
        const n = nb[q];
        if (closed[n] === gen) continue;
        const cost = n === to ? 1 : costFn(n);
        if (cost <= 0) continue;
        const ng = g[k] + cost;
        if (stamp[n] !== gen || ng < g[n]) {
          stamp[n] = gen;
          g[n] = ng;
          came[n] = k;
          heap.push(ng + Math.abs((n % s) - tx) + Math.abs(((n / s) | 0) - tz), n);
        }
      }
    }
    if (closed[to] !== gen) return null;
    const path = [];
    for (let k = to; k !== -1; k = came[k]) path.push(k);
    path.reverse();
    return path;
  }
}

// --- Polylinien ---------------------------------------------------------------

export function tilesToPoints(world, tiles) {
  const pts = [];
  for (const k of tiles) pts.push([world.tileX(k), world.tileZ(k)]);
  return pts;
}

export function simplify(pts) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Versatz nach rechts (Rechtsverkehr / rechter Gehweg). rechts = (-dz, dx)
export function offsetRight(pts, off) {
  if (pts.length < 2 || off === 0) return pts.slice();
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let n1x = 0, n1z = 0, n2x = 0, n2z = 0;
    if (i > 0) {
      const dx = p[0] - a[0], dz = p[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      n1x = -dz / l; n1z = dx / l;
    }
    if (i < pts.length - 1) {
      const dx = b[0] - p[0], dz = b[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      n2x = -dz / l; n2z = dx / l;
    }
    if (i === 0) { n1x = n2x; n1z = n2z; }
    if (i === pts.length - 1) { n2x = n1x; n2z = n1z; }
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) {
      // Wende um 180°: einfach seitlich versetzen
      out.push([p[0] + n1x * off, p[1] + n1z * off]);
      continue;
    }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z;
    const scale = off / Math.max(0.35, cos);
    out.push([p[0] + mx * scale, p[1] + mz * scale]);
  }
  return out;
}

// Rundet Ecken mit quadratischen Bézierkurven ab.
export function roundCorners(pts, radius, steps = 3) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const l2 = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.02) { out.push(p); continue; }
    const s = [p[0] + (a[0] - p[0]) * (r / l1), p[1] + (a[1] - p[1]) * (r / l1)];
    const e = [p[0] + (b[0] - p[0]) * (r / l2), p[1] + (b[1] - p[1]) * (r / l2)];
    out.push(s);
    for (let q = 1; q < steps; q++) {
      const t = q / steps, u = 1 - t;
      out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1]]);
    }
    out.push(e);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

export function flatten(pts) {
  const out = new Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = Math.round(pts[i][0] * 100) / 100;
    out[2 * i + 1] = Math.round(pts[i][1] * 100) / 100;
  }
  return out;
}

// Kumulierte Längen einer geschlossenen oder offenen Polylinie (flaches Array)
export function cumulative(flat) {
  const n = flat.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(flat[2 * i] - flat[2 * i - 2], flat[2 * i + 1] - flat[2 * i - 1]);
  }
  return cum;
}

// Nächster Punkt (Bogenlänge) auf einer Polylinie
export function projectOnPolyline(flat, cum, x, z) {
  let best = Infinity;
  let bestS = 0;
  const n = flat.length / 2;
  for (let i = 1; i < n; i++) {
    const ax = flat[2 * i - 2], az = flat[2 * i - 1];
    const bx = flat[2 * i], bz = flat[2 * i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < best) {
      best = d;
      bestS = cum[i - 1] + Math.sqrt(l2) * t;
    }
  }
  return { s: bestS, dist: Math.sqrt(best) };
}

export function pointAt(flat, cum, s) {
  const n = flat.length / 2;
  if (s <= 0) return [flat[0], flat[1], Math.atan2(flat[2] - flat[0], flat[3] - flat[1])];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const segLen = cum[hi] - cum[lo] || 1;
  const t = Math.min(1, (s - cum[lo]) / segLen);
  const ax = flat[2 * lo], az = flat[2 * lo + 1], bx = flat[2 * hi], bz = flat[2 * hi + 1];
  return [ax + (bx - ax) * t, az + (bz - az) * t, Math.atan2(bx - ax, bz - az)];
}
