// Karte: Kachelraster mit Straßenblöcken, Grundstücken, Vierteln, Park und Bahnflächen.
//
// Aufbau: Jeder Block besteht aus 4x4 Kacheln (= 4 Grundstücke à 2x2) und ist von
// einer Straße (1 Kachel) umgeben. Um die Stadt liegt ein Rand für die Ringbahn.
// Weltkoordinaten: 1 Kachel = 1 Einheit, Mittelpunkt der Karte = (0, 0).

export const T = {
  LAND: 0,
  ROAD: 1,
  PLOT: 2,
  PARK: 3,
};

export const DISTRICTS = [
  { id: 0, typ: 'wohnen', name: 'Lindenhof' },
  { id: 1, typ: 'industrie', name: 'Eisenwerk' },
  { id: 2, typ: 'wohnen', name: 'Sonnenfeld' },
  { id: 3, typ: 'industrie', name: 'Chemiepark' },
  { id: 4, typ: 'wohnen', name: 'Rosengarten' },
  { id: 5, typ: 'industrie', name: 'Logistikpark' },
];

export const BLOCK = 5; // Raster: 4 Kacheln Block + 1 Kachel Straße
export const MARGIN = 4; // Rand für die Ringbahn

export class World {
  constructor(blocks, rng) {
    this.blocks = blocks;
    this.inner = blocks * BLOCK + 1;
    this.size = this.inner + 2 * MARGIN;
    const n = this.size * this.size;
    this.type = new Uint8Array(n);
    this.roadActive = new Uint8Array(n);
    this.rail = new Uint8Array(n); // Anzahl Gleise auf der Kachel
    this.station = new Int16Array(n).fill(-1);
    this.plotOf = new Int16Array(n).fill(-1);
    this.blockZone = []; // [bj][bi] -> Viertel-ID oder -1 (Park)
    this.plots = [];
    this.version = 1; // erhöht sich bei jeder Änderung (Wege-Cache)
    this.roadVersion = 1;

    const half = this.size / 2;
    this.half = half;
    const center = (this.inner - 1) / 2; // in lokalen Koordinaten

    for (let j = 0; j < this.size; j++) {
      for (let i = 0; i < this.size; i++) {
        const li = i - MARGIN;
        const lj = j - MARGIN;
        const k = j * this.size + i;
        if (li < 0 || lj < 0 || li >= this.inner || lj >= this.inner) {
          this.type[k] = T.LAND;
        } else if (li % BLOCK === 0 || lj % BLOCK === 0) {
          this.type[k] = T.ROAD;
        } else {
          this.type[k] = T.PLOT;
        }
      }
    }

    // Viertel als Tortenstücke um den Park im Zentrum.
    for (let bj = 0; bj < blocks; bj++) {
      const row = [];
      for (let bi = 0; bi < blocks; bi++) {
        const cx = bi * BLOCK + 2.5 - center;
        const cz = bj * BLOCK + 2.5 - center;
        const dist = Math.hypot(cx, cz);
        if (dist < 4.2) {
          row.push(-1);
          continue;
        }
        let ang = Math.atan2(cz, cx);
        if (ang < 0) ang += Math.PI * 2;
        row.push(Math.floor(ang / (Math.PI / 3)) % 6);
      }
      this.blockZone.push(row);
    }

    // Grundstücke anlegen
    for (let bj = 0; bj < blocks; bj++) {
      for (let bi = 0; bi < blocks; bi++) {
        const zone = this.blockZone[bj][bi];
        for (let py = 0; py < 2; py++) {
          for (let px = 0; px < 2; px++) {
            const ti = MARGIN + bi * BLOCK + 1 + px * 2;
            const tj = MARGIN + bj * BLOCK + 1 + py * 2;
            const tiles = [
              tj * this.size + ti,
              tj * this.size + ti + 1,
              (tj + 1) * this.size + ti,
              (tj + 1) * this.size + ti + 1,
            ];
            if (zone < 0) {
              for (const t of tiles) this.type[t] = T.PARK;
              continue;
            }
            // Front zur Nord- oder Südstraße (Häuserreihen mit Gärten innen)
            const facing = py === 0 ? 'n' : 's';
            const frontJ = py === 0 ? tj - 1 : tj + 2;
            const frontTiles = [frontJ * this.size + ti, frontJ * this.size + ti + 1];
            const x = ti + 1 - half;
            const z = tj + 1 - half;
            const plot = {
              id: this.plots.length,
              district: zone,
              bi, bj, px, py,
              tiles,
              x, z,
              facing,
              rot: facing === 's' ? 0 : Math.PI,
              front: frontTiles[px === 0 ? 1 : 0],
              door: { x, z: z + (facing === 's' ? 1 : -1) },
              dist: Math.hypot(x, z),
              buildingId: null,
              blocked: false, // durch Gleise belegt
              order: 0,
            };
            for (const t of tiles) this.plotOf[t] = plot.id;
            this.plots.push(plot);
          }
        }
      }
    }

    // Bebauungsreihenfolge je Viertel: von innen nach außen mit etwas Zufall.
    this.districtPlots = DISTRICTS.map(() => []);
    for (const p of this.plots) {
      p.order = p.dist + rng.range(0, 3.5);
      this.districtPlots[p.district].push(p);
    }
    for (const list of this.districtPlots) list.sort((a, b) => a.order - b.order);
    this.parkTiles = [];
    for (let k = 0; k < n; k++) if (this.type[k] === T.PARK) this.parkTiles.push(k);
  }

  idx(i, j) {
    return j * this.size + i;
  }

  ij(k) {
    return [k % this.size, Math.floor(k / this.size)];
  }

  tileX(k) {
    return (k % this.size) - this.half + 0.5;
  }

  tileZ(k) {
    return Math.floor(k / this.size) - this.half + 0.5;
  }

  tileAt(x, z) {
    const i = Math.floor(x + this.half);
    const j = Math.floor(z + this.half);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return -1;
    return j * this.size + i;
  }

  isIntersection(k) {
    const [i, j] = this.ij(k);
    return this.type[k] === T.ROAD && (i - MARGIN) % BLOCK === 0 && (j - MARGIN) % BLOCK === 0;
  }

  // Straßenrichtung einer Straßenkachel: 'x' (verläuft in x-Richtung), 'z' oder 'kreuzung'
  roadAxis(k) {
    const [i, j] = this.ij(k);
    const xr = (j - MARGIN) % BLOCK === 0;
    const zr = (i - MARGIN) % BLOCK === 0;
    if (xr && zr) return 'kreuzung';
    return xr ? 'x' : 'z';
  }

  blocksBetween(ax, az, bx, bz) {
    return (Math.abs(ax - bx) + Math.abs(az - bz)) / BLOCK;
  }

  // Straßen werden nur dort gebaut, wo Blöcke genutzt werden; danach wird das Netz
  // zusammenhängend gemacht. Gibt true zurück, wenn sich etwas geändert hat.
  updateRoads(extraTiles = []) {
    const s = this.size;
    const next = new Uint8Array(this.type.length);
    const activeBlock = (bi, bj) => {
      if (this.blockZone[bj][bi] < 0) return true;
      for (let py = 0; py < 2; py++) {
        for (let px = 0; px < 2; px++) {
          const ti = MARGIN + bi * BLOCK + 1 + px * 2;
          const tj = MARGIN + bj * BLOCK + 1 + py * 2;
          const p = this.plots[this.plotOf[tj * s + ti]];
          if (p && (p.buildingId !== null || p.blocked)) return true;
        }
      }
      return false;
    };
    for (let bj = 0; bj < this.blocks; bj++) {
      for (let bi = 0; bi < this.blocks; bi++) {
        if (!activeBlock(bi, bj)) continue;
        const i0 = MARGIN + bi * BLOCK;
        const j0 = MARGIN + bj * BLOCK;
        for (let d = 0; d <= BLOCK; d++) {
          next[j0 * s + i0 + d] = 1;
          next[(j0 + BLOCK) * s + i0 + d] = 1;
          next[(j0 + d) * s + i0] = 1;
          next[(j0 + d) * s + i0 + BLOCK] = 1;
        }
      }
    }
    for (const t of extraTiles) if (this.type[t] === T.ROAD) next[t] = 1;
    // Einmal gebaute Straßen bleiben bestehen.
    for (let k = 0; k < next.length; k++) if (this.roadActive[k]) next[k] = 1;

    this.connectRoads(next);

    let changed = false;
    for (let k = 0; k < next.length; k++) {
      if (next[k] !== this.roadActive[k]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      this.roadActive = next;
      this.roadVersion++;
      this.version++;
    }
    return changed;
  }

  // Verbindet alle Straßenstücke mit dem Netz um den Park (kürzester Weg über das Raster).
  connectRoads(active) {
    const s = this.size;
    const c = MARGIN + Math.floor(this.blocks / 2) * BLOCK;
    let start = c * s + c;
    if (!active[start]) {
      start = -1;
      for (let k = 0; k < active.length; k++) if (active[k]) { start = k; break; }
      if (start < 0) return;
    }
    const seen = new Uint8Array(active.length);
    const flood = (from) => {
      const stack = [from];
      seen[from] = 1;
      while (stack.length) {
        const k = stack.pop();
        const i = k % s;
        for (const nb of [k - 1, k + 1, k - s, k + s]) {
          if (nb < 0 || nb >= active.length) continue;
          if (Math.abs((nb % s) - i) > 1) continue;
          if (active[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
    };
    flood(start);
    for (let guard = 0; guard < 200; guard++) {
      let orphan = -1;
      for (let k = 0; k < active.length; k++) if (active[k] && !seen[k]) { orphan = k; break; }
      if (orphan < 0) return;
      // Breitensuche über alle möglichen Straßenkacheln bis zum Hauptnetz
      const prev = new Int32Array(active.length).fill(-2);
      const q = [orphan];
      prev[orphan] = -1;
      let hit = -1;
      for (let h = 0; h < q.length && hit < 0; h++) {
        const k = q[h];
        const i = k % s;
        for (const nb of [k - 1, k + 1, k - s, k + s]) {
          if (nb < 0 || nb >= active.length || prev[nb] !== -2) continue;
          if (Math.abs((nb % s) - i) > 1) continue;
          if (this.type[nb] !== T.ROAD) continue;
          prev[nb] = k;
          if (seen[nb]) { hit = nb; break; }
          q.push(nb);
        }
      }
      if (hit < 0) {
        flood(orphan); // keine Verbindung möglich – als eigenes Netz akzeptieren
        continue;
      }
      for (let k = hit; k >= 0; k = prev[k]) active[k] = 1;
      flood(orphan);
    }
  }

  // Kompakte Darstellung für den Client
  serialize() {
    return {
      size: this.size,
      blocks: this.blocks,
      margin: MARGIN,
      block: BLOCK,
      zones: this.blockZone.map((r) => r.map((z) => (z < 0 ? 'p' : String(z))).join('')).join(''),
      roads: this.roadString(),
      plots: this.plots.map((p) => [p.x, p.z, p.district, p.blocked ? 1 : 0]),
    };
  }

  roadString() {
    let out = '';
    for (let k = 0; k < this.roadActive.length; k++) out += this.roadActive[k] ? '1' : '0';
    return out;
  }
}
