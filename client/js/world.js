// Statische Stadt: Boden, Straßen, Gebäude, Bäume, Gleise, Bahnsteige, Laternen.
import * as THREE from 'three';
import { InstancedGroup } from './instanced.js';
import { hash01, cumulative, pointAt } from './util.js';

const COLORS = {
  wiese: [143, 196, 111],
  wieseDunkel: [129, 184, 99],
  rasen: [166, 214, 128],
  beton: [186, 183, 174],
  park: [111, 176, 95],
  schotter: [163, 154, 138],
  bahnsteig: [201, 196, 189],
  strasse: [93, 100, 112],
};

// Straßenstücke: offene Seiten im Grundzustand (0 = +x/Ost, 1 = -z/Nord, 2 = -x/West, 3 = +z/Süd)
const PIECES = [
  ['road-crossroad', [0, 1, 2, 3]],
  ['road-intersection', [0, 2, 3]],
  ['road-straight', [0, 2]],
  ['road-bend', [2, 3]],
  ['road-end', [0]],
];

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function compose(x, y, z, rotY, sx = 1, sy = sx, sz = sx) {
  tmpQ.setFromAxisAngle(UP, rotY);
  tmpP.set(x, y, z);
  tmpS.set(sx, sy, sz);
  return tmpM.compose(tmpP, tmpQ, tmpS);
}

export class CityView {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.groups = new Map(); // Modellname → InstancedGroup
    this.buildings = new Map(); // id → {b, model, anim}
    this.anims = new Map();
    this.lamps = [];
    this.factoryTops = [];
    this.shadows = false;
  }

  group(name, opts = {}) {
    let g = this.groups.get(name);
    if (!g) {
      const m = this.assets.get(name);
      if (!m) return null;
      g = new InstancedGroup(this.root, m.geometry, m.material, opts);
      this.groups.set(name, g);
    }
    return g;
  }

  clear() {
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    this.buildings.clear();
    this.anims.clear();
    if (this.ground) {
      this.root.remove(this.ground, this.outerGround);
      this.ground.geometry.dispose();
    }
    if (this.platforms) this.root.remove(this.platforms);
  }

  build(init) {
    this.clear();
    const w = init.world;
    this.size = w.size;
    this.half = w.size / 2;
    this.margin = w.margin;
    this.blocks = w.blocks;
    this.block = w.block;
    this.inner = w.blocks * w.block + 1;
    this.plots = w.plots.map(([x, z, d, blocked]) => ({ x, z, d, blocked: !!blocked, building: null }));
    this.zones = w.zones;
    this.districts = init.districts;
    this.makeGround();
    this.setRoads(w.roads);
    for (const b of init.buildings) this.setBuilding(b, false);
    this.setLines(init.lines, init.stations);
    this.updateTrees();
    this.paintGround();
  }

  // ------------------------------------------------------------------ Boden
  tileType(i, j) {
    const li = i - this.margin, lj = j - this.margin;
    if (li < 0 || lj < 0 || li >= this.inner || lj >= this.inner) return 'land';
    if (li % this.block === 0 || lj % this.block === 0) return 'road';
    const bi = Math.floor(li / this.block), bj = Math.floor(lj / this.block);
    return this.zones[bj * this.blocks + bi] === 'p' ? 'park' : 'plot';
  }

  plotIndexAt(i, j) {
    const li = i - this.margin, lj = j - this.margin;
    const bi = Math.floor(li / this.block), bj = Math.floor(lj / this.block);
    const px = Math.floor((li - bi * this.block - 1) / 2), py = Math.floor((lj - bj * this.block - 1) / 2);
    const x = this.margin + bi * this.block + 1 + px * 2 + 1 - this.half;
    const z = this.margin + bj * this.block + 1 + py * 2 + 1 - this.half;
    return this.plotLookup.get(`${x},${z}`) ?? -1;
  }

  makeGround() {
    const s = this.size;
    this.groundData = new Uint8Array(s * s * 4);
    this.groundTex = new THREE.DataTexture(this.groundData, s, s, THREE.RGBAFormat);
    this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.minFilter = THREE.LinearFilter;
    this.groundTex.colorSpace = THREE.SRGBColorSpace;
    this.groundTex.flipY = false;
    this.groundMat = new THREE.MeshLambertMaterial({ map: this.groundTex });
    this.snowUniform = { value: 0 };
    this.groundMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSnow = this.snowUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93,0.95,0.98), uSnow);');
    };
    const geo = new THREE.PlaneGeometry(s, s);
    geo.rotateX(-Math.PI / 2);
    // UV so drehen, dass Pixel (i, j) auf Kachel (i, j) liegt
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
    this.ground = new THREE.Mesh(geo, this.groundMat);
    this.ground.receiveShadow = true;
    this.ground.name = 'boden';
    this.root.add(this.ground);
    this.outerMat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(...COLORS.wieseDunkel.map((c) => c / 255), THREE.SRGBColorSpace) });
    this.outerMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSnow = this.snowUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93,0.95,0.98), uSnow);');
    };
    const og = new THREE.PlaneGeometry(s * 8, s * 8);
    og.rotateX(-Math.PI / 2);
    this.outerGround = new THREE.Mesh(og, this.outerMat);
    this.outerGround.position.y = -0.02;
    this.outerGround.receiveShadow = true;
    this.root.add(this.outerGround);
    this.plotLookup = new Map(this.plots.map((p, i) => [`${p.x},${p.z}`, i]));
  }

  paintGround() {
    const s = this.size;
    const d = this.groundData;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const k = j * s + i;
        const t = this.tileType(i, j);
        let c = COLORS.wiese;
        if (t === 'park') c = COLORS.park;
        else if (t === 'road') c = this.roadSet?.has(k) ? COLORS.strasse : COLORS.wiese;
        else if (t === 'plot') {
          const p = this.plots[this.plotIndexAt(i, j)];
          if (p?.blocked) c = COLORS.schotter;
          else if (p?.building) c = p.building.k === 'i' ? COLORS.beton : COLORS.rasen;
        }
        if (this.railTiles?.has(k)) c = COLORS.schotter;
        if (this.platformTiles?.has(k)) c = COLORS.bahnsteig;
        const n = 0.97 + hash01(k * 7 + 3) * 0.05;
        d[4 * k] = Math.min(255, c[0] * n);
        d[4 * k + 1] = Math.min(255, c[1] * n);
        d[4 * k + 2] = Math.min(255, c[2] * n);
        d[4 * k + 3] = 255;
      }
    }
    this.groundTex.needsUpdate = true;
  }

  tileCenter(k) {
    return [(k % this.size) - this.half + 0.5, Math.floor(k / this.size) - this.half + 0.5];
  }

  // ------------------------------------------------------------------ Straßen
  setRoads(str) {
    const s = this.size;
    this.roadSet = new Set();
    for (let k = 0; k < str.length; k++) if (str.charCodeAt(k) === 49) this.roadSet.add(k);
    for (const [name] of PIECES) this.group(`roads/${name}`, { receiveShadow: true })?.clear();
    this.group('roads/road-square')?.clear();
    const lamp = this.group('roads/light-square', { castShadow: false });
    lamp?.clear();
    this.lamps = [];
    for (const k of this.roadSet) {
      const i = k % s, j = Math.floor(k / s);
      const open = [
        i < s - 1 && this.roadSet.has(k + 1),
        j > 0 && this.roadSet.has(k - s),
        i > 0 && this.roadSet.has(k - 1),
        j < s - 1 && this.roadSet.has(k + s),
      ];
      const want = open.map((o, d) => (o ? d : -1)).filter((d) => d >= 0);
      const [x, z] = this.tileCenter(k);
      let placed = false;
      for (const [name, base] of PIECES) {
        if (base.length !== want.length) continue;
        for (let r = 0; r < 4 && !placed; r++) {
          const rotated = base.map((d) => (d + r) % 4).sort();
          if (rotated.join() === want.join()) {
            this.group(`roads/${name}`, { receiveShadow: true }).set(k, compose(x, 0, z, (r * Math.PI) / 2));
            placed = true;
          }
        }
        if (placed) break;
      }
      if (!placed) this.group('roads/road-square').set(k, compose(x, 0, z, 0));
      // Laternen an Kreuzungen
      if (want.length >= 3 && lamp) {
        const lx = x + 0.44, lz = z + 0.44;
        lamp.set(k, compose(lx, 0, lz, Math.PI * 0.75));
        this.lamps.push([lx - 0.14, 0.6, lz - 0.14]);
      }
    }
    if (this.groundTex) this.paintGround();
    this.treesDirty = true;
  }

  // ------------------------------------------------------------------ Gebäude
  setBuilding(b, animate = true) {
    const prev = this.buildings.get(b.id);
    if (prev) {
      if (prev.b.m === b.m) return;
      this.group(prev.b.m)?.remove(b.id);
    }
    const plot = this.plots[b.p];
    const model = this.assets.get(b.m);
    if (!plot || !model) return;
    const entry = { b, plot, model, scale: 1 };
    this.buildings.set(b.id, entry);
    plot.building = b;
    const g = this.group(b.m, { castShadow: true, receiveShadow: true });
    if (!g) return;
    if (animate) {
      entry.scale = 0.05;
      this.anims.set(b.id, { t: 0 });
    }
    g.set(b.id, compose(plot.x, 0, plot.z, b.r, entry.scale));
    if (b.k === 'i') this.updateFactoryTops();
    if (this.groundTex) this.paintGround();
    this.treesDirty = true;
  }

  removeBuilding(id) {
    const e = this.buildings.get(id);
    if (!e) return;
    this.group(e.b.m)?.remove(id);
    e.plot.building = null;
    this.buildings.delete(id);
    this.anims.delete(id);
    if (e.b.k === 'i') this.updateFactoryTops();
    this.paintGround();
    this.treesDirty = true;
  }

  setBlocked(plotIds) {
    for (const id of plotIds) if (this.plots[id]) this.plots[id].blocked = true;
    this.paintGround();
    this.treesDirty = true;
  }

  updateFactoryTops() {
    this.factoryTops = [];
    for (const e of this.buildings.values()) {
      if (e.b.k !== 'i') continue;
      const h = e.model.size.y;
      this.factoryTops.push({ id: e.b.id, x: e.plot.x + 0.25, y: h * 0.95, z: e.plot.z - 0.1 });
    }
  }

  buildingTop(id) {
    const e = this.buildings.get(id);
    if (!e) return null;
    return [e.plot.x, e.model.size.y * e.scale + 0.15, e.plot.z];
  }

  // Strahl gegen Gebäudequader → nächstes Gebäude
  pickBuilding(ray) {
    let best = null;
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    for (const e of this.buildings.values()) {
      const s = e.model.size;
      box.min.set(e.plot.x - s.x / 2, 0, e.plot.z - s.z / 2);
      box.max.set(e.plot.x + s.x / 2, s.y * e.scale, e.plot.z + s.z / 2);
      if (ray.intersectBox(box, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (!best || d < best.dist) best = { id: e.b.id, dist: d };
      }
    }
    return best;
  }

  update(dt) {
    for (const [id, a] of this.anims) {
      const e = this.buildings.get(id);
      if (!e) { this.anims.delete(id); continue; }
      a.t += dt / 1.4;
      const t = Math.min(1, a.t);
      e.scale = 0.05 + 0.95 * (1 - (1 - t) ** 3);
      this.group(e.b.m).set(id, compose(e.plot.x, 0, e.plot.z, e.b.r, e.scale));
      if (t >= 1) this.anims.delete(id);
    }
    if (this.treesDirty) {
      this.treesDirty = false;
      this.updateTrees();
    }
    for (const g of this.groups.values()) g.refreshBounds();
  }

  // ------------------------------------------------------------------ Bäume
  updateTrees() {
    const big = this.group('suburban/tree-large', { castShadow: true });
    const small = this.group('suburban/tree-small', { castShadow: true });
    if (!big || !small) return;
    big.clear();
    small.clear();
    const s = this.size;
    let n = 0;
    const place = (x, z, seed, sc = 1.3) => {
      const g = hash01(seed * 13 + 1) > 0.45 ? big : small;
      g.set(n++, compose(x, 0, z, hash01(seed) * 6.28, sc * (0.85 + hash01(seed * 3) * 0.35)));
    };
    // ein Baum im Garten hinter jedem Einfamilienhaus
    this.plots.forEach((p, idx) => {
      if (!p.building || p.building.k !== 'w' || p.building.l !== 1 || p.blocked) return;
      const side = hash01(idx * 17 + 5) > 0.5 ? 0.68 : -0.68;
      place(p.x + side, p.z + (p.building.r === 0 ? -0.8 : 0.8), 100000 + idx, 1.05);
    });
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const k = j * s + i;
        if (this.railTiles?.has(k) || this.platformTiles?.has(k)) continue;
        const t = this.tileType(i, j);
        const h = hash01(k * 31 + 7);
        const [x, z] = this.tileCenter(k);
        const jx = (hash01(k * 5 + 1) - 0.5) * 0.6, jz = (hash01(k * 9 + 2) - 0.5) * 0.6;
        if (t === 'land') {
          if (h < 0.22) place(x + jx, z + jz, k);
        } else if (t === 'park') {
          if (h < 0.3) place(x + jx, z + jz, k);
        } else if (t === 'road') {
          if (!this.roadSet.has(k) && h < 0.08) place(x + jx, z + jz, k);
        } else {
          const p = this.plots[this.plotIndexAt(i, j)];
          if (!p || p.blocked) continue;
          if (!p.building) {
            if (h < 0.16) place(x + jx, z + jz, k);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ Gleise
  setLines(lines, stations) {
    this.lines = lines;
    this.stations = stations;
    const sleepers = this.group('trains/spline-segment', { receiveShadow: true });
    const rails = this.group('trains/spline-track');
    sleepers?.clear();
    rails?.clear();
    this.railTiles = new Set();
    let ns = 0, nr = 0;
    const out = [0, 0, 0];
    const s = this.size;
    for (const line of lines) {
      for (const tr of line.tracks) {
        const cum = cumulative(tr);
        const L = cum[cum.length - 1];
        for (let d = 0.15; d < L; d += 0.3) {
          pointAt(tr, cum, d, out);
          sleepers?.set(ns++, compose(out[0], 0.012, out[1], out[2]));
          const k = Math.floor(out[1] + this.half) * s + Math.floor(out[0] + this.half);
          this.railTiles.add(k);
        }
        const step = 0.5;
        for (let d = 0; d < L; d += step) {
          const len = Math.min(step, L - d);
          pointAt(tr, cum, d + len / 2, out);
          rails?.set(nr++, compose(out[0], 0.03, out[1], out[2], 1, 1, (len + 0.02) / 0.42));
        }
      }
    }
    // Bahnsteige
    if (this.platforms) this.root.remove(this.platforms);
    this.platforms = new THREE.Group();
    this.platformTiles = new Set();
    const platMat = new THREE.MeshLambertMaterial({ color: 0xd8d4cc });
    const roofMat = this.assets.get('commercial/detail-overhang-wide');
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const plat = new THREE.InstancedMesh(boxGeo, platMat, Math.max(1, stations.length));
    plat.receiveShadow = true;
    let roofGroup = null;
    if (roofMat) roofGroup = new THREE.InstancedMesh(roofMat.geometry, roofMat.material, Math.max(1, stations.length));
    stations.forEach((st, i) => {
      const len = st.kind === 'ring' ? 2.2 : 1.3;
      plat.setMatrixAt(i, compose(st.px, 0.04, st.pz, st.rot, 0.42, 0.08, len));
      if (roofGroup) {
        const sz = roofMat.size;
        const sc = len / Math.max(sz.x, 0.1);
        roofGroup.setMatrixAt(i, compose(st.px, 0.02, st.pz, st.rot + Math.PI / 2, sc * 0.9, 0.55, 0.55));
      }
      const k = Math.floor(st.pz + this.half) * s + Math.floor(st.px + this.half);
      this.platformTiles.add(k);
    });
    plat.count = stations.length;
    this.platforms.add(plat);
    if (roofGroup) {
      roofGroup.count = stations.length;
      roofGroup.castShadow = true;
      this.platforms.add(roofGroup);
    }
    this.root.add(this.platforms);
    if (this.groundTex) this.paintGround();
    this.treesDirty = true;
  }

  pickStation(ray) {
    let best = null;
    const hit = new THREE.Vector3();
    const box = new THREE.Box3();
    for (const st of this.stations || []) {
      box.min.set(st.px - 0.7, 0, st.pz - 0.7);
      box.max.set(st.px + 0.7, 0.6, st.pz + 0.7);
      if (ray.intersectBox(box, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (!best || d < best.dist) best = { id: st.id, dist: d };
      }
    }
    return best;
  }

  setShadows(on) {
    this.shadows = on;
    for (const [name, g] of this.groups) {
      const isBuilding = /building|tree|overhang/.test(name);
      g.mesh.castShadow = on && isBuilding;
      g.castShadow = on && isBuilding;
    }
    if (this.platforms) for (const m of this.platforms.children) m.castShadow = on;
  }
}
