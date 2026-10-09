// Bewegliche Objekte: Fußgänger, Autos, Bahnen sowie Gedankenblasen (Emotes).
import * as THREE from 'three';
import { InstancedBatch, Billboards } from './instanced.js';
import { WALK_FRAMES } from './assets.js';
import { cumulative, pointAt, smoothstep, clamp } from './util.js';

const PEOPLE_COLORS = [
  0x8e6bd6, 0xe0705a, 0x4da3d9, 0xe6a23c, 0x5cbf8a, 0xd65c9a,
  0x3f74d6, 0xd2402f, 0x2f9e6e, 0xc98500, 0x6b7a8f, 0x9c5fd0,
];

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const out = [0, 0, 0];

function mat(x, y, z, rot) {
  q.setFromAxisAngle(UP, rot);
  v.set(x, y, z);
  return m4.compose(v, q, one);
}

export class AgentView {
  constructor(scene, assets, init) {
    this.scene = scene;
    this.assets = assets;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.agents = new Map();
    this.buildingEmotes = new Map();
    this.charNames = init.models.char;
    this.carNames = init.models.car;
    this.emoteSyms = init.emotes;
    this.rate = init.cfg.zeitraffer;

    // Figuren: je Figur 4 Laufbilder + 1 Standbild
    const charMat = assets.materials.characters;
    this.charBatches = this.charNames.map((name) => {
      const c = assets.character(name);
      if (!c) return null;
      return [...c.frames.map((g) => new InstancedBatch(this.root, g, charMat, 8)), new InstancedBatch(this.root, c.idle, charMat, 8)];
    });
    this.carBatches = this.carNames.map((name) => {
      const m = assets.get(name);
      return m ? new InstancedBatch(this.root, m.geometry, m.material, 8) : null;
    });
    this.trainBatches = new Map();

    // Fernansicht: Personen als Punkte
    this.pointCap = 512;
    this.pointGeo = new THREE.BufferGeometry();
    this.pointPos = new Float32Array(this.pointCap * 3);
    this.pointCol = new Float32Array(this.pointCap * 3);
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute('color', new THREE.BufferAttribute(this.pointCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.pointGeo, new THREE.PointsMaterial({ size: 0.22, vertexColors: true, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    this.root.add(this.points);
    this.colors = PEOPLE_COLORS.map((c) => new THREE.Color(c));

    // Gedankenblasen
    const em = assets.emotes;
    this.emoteFrames = {};
    for (const [key, sym] of Object.entries(this.emoteSyms)) {
      const f = em.frames[sym];
      if (f) this.emoteFrames[key] = [f[0] / em.size[0], 1 - (f[1] + f[3]) / em.size[1], f[2] / em.size[0], f[3] / em.size[1]];
    }
    this.emoteBoards = new Billboards(this.root, em.texture, { capacity: 400, worldSize: 0.3, pixelSize: 24, aspect: 38 / 32 });
    this.buildingBoards = new Billboards(this.root, em.texture, { capacity: 120, worldSize: 0.45, pixelSize: 28, aspect: 38 / 32 });
    this.lines = [];
    this.trainPositions = [];
    this.carFronts = [];
  }

  reset(init) {
    this.agents.clear();
    this.buildingEmotes.clear();
    this.rate = init.cfg.zeitraffer;
    for (const a of init.agents) this.upsert(a);
    this.setLines(init.lines);
  }

  // ------------------------------------------------------------------ Ereignisse
  upsert(msg) {
    const old = this.agents.get(msg.id);
    const pts = Float32Array.from(msg.p);
    const a = {
      id: msg.id, k: msg.k, m: msg.m, pts, cum: msg.k === 'i' ? null : cumulative(pts),
      t0: msg.t0, d: Math.max(1, msg.d), rot: msg.r || 0, phase: (msg.id * 0.37) % WALK_FRAMES,
      emo: old?.emo || null, x: pts[0], z: pts[1], h: 0, sh: old ? old.h : null,
    };
    a.len = a.cum ? a.cum[a.cum.length - 1] : 0;
    this.agents.set(msg.id, a);
  }

  hide(id) {
    this.agents.delete(id);
  }

  emote(id, key, durMs, now) {
    const a = this.agents.get(id);
    if (!a || !this.emoteFrames[key]) return;
    a.emo = { key, start: now, until: now + durMs };
  }

  buildingEmote(id, key, durMs, now) {
    if (!this.emoteFrames[key]) return;
    this.buildingEmotes.set(id, { key, start: now, until: now + durMs });
  }

  setLines(lines) {
    this.lines = lines.map((l) => ({ ...l, pts: Float32Array.from(l.pts), cum: cumulative(l.pts) }));
    for (const l of this.lines) {
      for (const name of new Set(l.cars)) {
        if (this.trainBatches.has(name)) continue;
        const m = this.assets.get(`trains/${name}`);
        if (m) this.trainBatches.set(name, new InstancedBatch(this.root, m.geometry, m.material, 8));
      }
    }
  }

  // Zeitplanposition eines Fahrzeugs (identisch zur Serverlogik)
  vehicleS(line, k, simNow) {
    const P = line.period;
    let tau = ((simNow - line.epoch) / 1000 + (k * P) / line.vehicles) % P;
    if (tau < 0) tau += P;
    for (const [arr, dep, s, dist, travel] of line.table) {
      if (tau < arr) continue;
      if (tau < dep) return s;
      if (tau < dep + travel) return (s + dist * smoothstep((tau - dep) / travel)) % line.length;
    }
    return line.table[0][2];
  }

  // ------------------------------------------------------------------ Pro Bild
  update(simNow, realNow, camera, opts) {
    const far = opts.far;
    for (const b of this.charBatches) if (b) for (const x of b) x.begin();
    for (const b of this.carBatches) b?.begin();
    for (const b of this.trainBatches.values()) b.begin();
    let np = 0;
    this.carFronts.length = 0;
    const stale = 20000 * this.rate;
    const frameT = (realNow / 1000) * 6;
    for (const a of this.agents.values()) {
      if (simNow > a.t0 + a.d + stale) {
        this.agents.delete(a.id);
        continue;
      }
      if (a.k === 'i') {
        a.x = a.pts[0];
        a.z = a.pts[1];
        a.h = a.rot;
      } else {
        const u = clamp((simNow - a.t0) / a.d, 0, 1);
        pointAt(a.pts, a.cum, u * a.len, out);
        a.x = out[0];
        a.z = out[1];
        // Richtung weich nachführen
        let target = out[2];
        if (a.sh === null) a.sh = target;
        let diff = target - a.sh;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        a.sh += diff * Math.min(1, opts.dt * 10);
        a.h = a.sh;
        a.moving = u < 1;
      }
      if (a.k === 'c') {
        this.carBatches[a.m]?.push(mat(a.x, 0.015, a.z, a.h));
        if (opts.night) this.carFronts.push(a.x + Math.sin(a.h) * 0.27, a.z + Math.cos(a.h) * 0.27);
        continue;
      }
      if (far) {
        if (np >= this.pointCap) this.growPoints();
        this.pointPos[3 * np] = a.x;
        this.pointPos[3 * np + 1] = 0.12;
        this.pointPos[3 * np + 2] = a.z;
        const c = this.colors[a.m % this.colors.length];
        this.pointCol[3 * np] = c.r; this.pointCol[3 * np + 1] = c.g; this.pointCol[3 * np + 2] = c.b;
        np++;
      } else {
        const batches = this.charBatches[a.m];
        if (!batches) continue;
        const fr = a.k === 'w' && a.moving !== false ? Math.floor(frameT + a.phase) % WALK_FRAMES : WALK_FRAMES;
        batches[fr].push(mat(a.x, 0.02, a.z, a.h));
      }
    }
    this.pointGeo.setDrawRange(0, np);
    this.points.visible = far && np > 0;
    if (np) {
      this.pointGeo.attributes.position.needsUpdate = true;
      this.pointGeo.attributes.color.needsUpdate = true;
    }

    // Bahnen
    this.trainPositions.length = 0;
    for (const line of this.lines) {
      for (let k = 0; k < line.vehicles; k++) {
        const s = this.vehicleS(line, k, simNow);
        line.cars.forEach((name, c) => {
          let sc = s - c * (line.carLen + 0.05) - line.carLen / 2;
          sc = ((sc % line.length) + line.length) % line.length;
          pointAt(line.pts, line.cum, sc, out);
          let rot = out[2];
          if (line.kind === 'tram' && c === line.cars.length - 1 && c > 0) rot += Math.PI;
          this.trainBatches.get(name)?.push(mat(out[0], 0.06, out[1], rot));
          this.trainPositions.push({ x: out[0], z: out[1], line: line.id, k });
          if (opts.night && c === 0) this.carFronts.push(out[0] + Math.sin(out[2]) * 0.6, out[1] + Math.cos(out[2]) * 0.6);
        });
      }
    }

    for (const b of this.charBatches) if (b) for (const x of b) x.end();
    for (const b of this.carBatches) b?.end();
    for (const b of this.trainBatches.values()) b.end();

    this.updateEmotes(realNow, camera, opts);
  }

  growPoints() {
    this.pointCap *= 2;
    const p = new Float32Array(this.pointCap * 3);
    const c = new Float32Array(this.pointCap * 3);
    p.set(this.pointPos);
    c.set(this.pointCol);
    this.pointPos = p;
    this.pointCol = c;
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute('color', new THREE.BufferAttribute(c, 3).setUsage(THREE.DynamicDrawUsage));
  }

  updateEmotes(now, camera, opts) {
    const eb = this.emoteBoards;
    eb.setPixelFactor(camera, opts.height);
    this.buildingBoards.setPixelFactor(camera, opts.height);
    eb.begin();
    if (opts.emotes) {
      const maxAgents = opts.far ? 60 : 400;
      let n = 0;
      for (const a of this.agents.values()) {
        const e = a.emo;
        if (!e) continue;
        if (now > e.until) { a.emo = null; continue; }
        if (n++ >= maxAgents) break;
        const f = this.emoteFrames[e.key];
        const age = (now - e.start) / 1000;
        const left = (e.until - now) / 1000;
        const alpha = Math.min(1, age / 0.25, left / 0.4);
        const pop = age < 0.3 ? 1 + 0.35 * Math.sin((age / 0.3) * Math.PI) : 1;
        const y = a.k === 'c' ? 0.42 : 0.4;
        eb.push(a.x, y, a.z, f[0], f[1], f[2], f[3], alpha, pop);
      }
    }
    eb.end();
    const bb = this.buildingBoards;
    bb.begin();
    if (opts.emotes) {
      for (const [id, e] of this.buildingEmotes) {
        if (now > e.until) { this.buildingEmotes.delete(id); continue; }
        const top = opts.buildingTop(id);
        if (!top) { this.buildingEmotes.delete(id); continue; }
        const f = this.emoteFrames[e.key];
        const age = (now - e.start) / 1000;
        const left = (e.until - now) / 1000;
        const alpha = Math.min(1, age / 0.3, left / 0.5);
        const bob = Math.sin(age * 2) * 0.04;
        bb.push(top[0], top[1] + bob, top[2], f[0], f[1], f[2], f[3], alpha, 1);
      }
    }
    bb.end();
  }

  // ------------------------------------------------------------------ Auswahl
  pick(px, py, camera, width, height) {
    let best = null;
    const test = (x, y, z, radius, hit) => {
      v.set(x, y, z).project(camera);
      if (v.z > 1) return;
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < radius && (!best || d < best.d)) best = { ...hit, d };
    };
    for (const a of this.agents.values()) {
      test(a.x, a.k === 'c' ? 0.12 : 0.12, a.z, a.k === 'c' ? 20 : 14, { typ: 'person', id: a.id });
    }
    for (const t of this.trainPositions) test(t.x, 0.3, t.z, 24, { typ: 'fahrzeug', id: `${t.line}:${t.k}` });
    return best;
  }

  positionOf(id) {
    const a = this.agents.get(id);
    return a ? [a.x, a.z, a.k] : null;
  }
}
