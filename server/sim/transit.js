// Schienenverkehr: Ringbahn um die Stadt und Straßenbahnlinien („ideale Strecken“).
//
// Jede Linie ist eine geschlossene Schleife, auf der Fahrzeuge in gleichen Abständen
// fahren und an Haltestellen halten. Der Fahrplan ist rein zeitbasiert und wird
// identisch im Browser berechnet – der Server muss keine Positionen übertragen.
import { MinHeap } from '../util/heap.js';
import { T, BLOCK, MARGIN } from './world.js';
import {
  simplify, roundCorners, offsetRight, flatten, cumulative, projectOnPolyline,
} from './paths.js';

const EASE = 1.25; // Anfahren/Bremsen verlängert die Fahrzeit je Abschnitt

export const LINE_TYPES = {
  ring: { speed: 1.7, dwell: 8, cars: ['train-electric-square-a', 'train-electric-square-b', 'train-electric-square-c'], carLen: 1.12, capacity: 120 },
  tram: { speed: 1.1, dwell: 6, cars: ['train-tram-classic', 'train-tram-classic'], carLen: 1.12, capacity: 60 },
};

const STREETS = [
  'Lindenstraße', 'Schillerplatz', 'Goethestraße', 'Am Markt', 'Bahnhofstraße', 'Mühlenweg', 'Rathausplatz',
  'Parkallee', 'Kirchgasse', 'Hauptstraße', 'Gartenweg', 'Brunnenplatz', 'Ahornweg', 'Schulstraße', 'Am Anger',
  'Kastanienallee', 'Feldstraße', 'Uhlandstraße', 'Brückenstraße', 'Am Wasserturm', 'Werkstraße', 'Hafenstraße',
  'Eichendorffweg', 'Rosenstraße', 'Birkenweg', 'Am Stadtpark', 'Kantstraße', 'Mozartstraße',
];

function closedRoundedRect(half, radius, clockwise) {
  // Startpunkt Mitte oben, im Uhrzeigersinn (Bildschirm: x rechts, z unten)
  const pts = [];
  const steps = 8;
  const corners = [
    [half - radius, -half + radius, -Math.PI / 2],
    [half - radius, half - radius, 0],
    [-half + radius, half - radius, Math.PI / 2],
    [-half + radius, -half + radius, Math.PI],
  ];
  pts.push([0, -half]);
  for (const [cx, cz, a0] of corners) {
    for (let q = 0; q <= steps; q++) {
      const a = a0 + (q / steps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
  }
  pts.push([0, -half]);
  if (!clockwise) pts.reverse();
  return pts;
}

export class Transit {
  constructor(world) {
    this.world = world;
    this.lines = [];
    this.stations = [];
    this.nextLineId = 1;
    this.streetIdx = 0;
    // Mitfahrende je Fahrzeug: key `${lineId}:${k}` -> Set(residentId)
    this.passengers = new Map();
  }

  // ---------------------------------------------------------------- Aufbau
  buildRing(epoch) {
    const w = this.world;
    const R = (w.inner - 1) / 2 + 2; // Mittellinie des Rings
    const radius = 3;
    const outer = closedRoundedRect(R + 0.3, radius + 0.3, true);
    const inner = closedRoundedRect(R - 0.3, radius - 0.3, false);
    const stationIds = [];
    for (let d = 0; d < 6; d++) {
      const a = (d * 60 + 30) * (Math.PI / 180);
      const c = Math.cos(a), s = Math.sin(a);
      const t = R / Math.max(Math.abs(c), Math.abs(s));
      let x = c * t, z = s * t;
      const lim = R - radius - 1.5;
      if (Math.abs(x) >= R - 0.01) z = Math.max(-lim, Math.min(lim, z));
      else x = Math.max(-lim, Math.min(lim, x));
      // Bahnsteig auf der Stadtseite des Rings
      const nx = Math.abs(x) >= R - 0.01 ? Math.sign(x) : 0;
      const nz = nx === 0 ? Math.sign(z) : 0;
      const px = x - nx * 0.95, pz = z - nz * 0.95;
      const st = this.addStation(`Bf ${['Lindenhof', 'Eisenwerk', 'Sonnenfeld', 'Chemiepark', 'Rosengarten', 'Logistikpark'][d]}`,
        px, pz, nx !== 0 ? 0 : Math.PI / 2, 'ring', 0);
      stationIds.push(st.id);
    }
    const ringTracks = [flatten(outer), flatten(inner)];
    // Gleiskacheln markieren
    for (const tr of ringTracks) this.markTrack(tr);
    this.addLine('ring', 'Ringbahn (Uhrzeigersinn)', ringTracks[0], stationIds, epoch, 2, [ringTracks[0]]);
    this.addLine('ring', 'Ringbahn (Gegenrichtung)', ringTracks[1], stationIds, epoch + 37_000, 2, [ringTracks[1]]);
  }

  // rot = Fahrtrichtung der Gleise; der Bahnsteig liegt um `side` nach rechts versetzt.
  addStation(name, x, z, rot, kind, side = 0.5) {
    const w = this.world;
    const px = x - Math.cos(rot) * side;
    const pz = z + Math.sin(rot) * side;
    const st = {
      id: this.stations.length, name, x: round2(x), z: round2(z), px: round2(px), pz: round2(pz),
      rot, kind, tile: w.tileAt(x, z),
    };
    this.stations.push(st);
    if (st.tile >= 0) w.station[st.tile] = st.id;
    w.version++;
    return st;
  }

  markTrack(flat) {
    const w = this.world;
    const seen = new Set();

    for (let i = 0; i < flat.length - 2; i += 2) {
      const ax = flat[i], az = flat[i + 1], bx = flat[i + 2], bz = flat[i + 3];
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.3) + 1;
      for (let q = 0; q <= n; q++) {
        const k = w.tileAt(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n);
        if (k >= 0 && !seen.has(k)) {
          seen.add(k);
          w.rail[k] = Math.min(255, w.rail[k] + 1);
        }
      }
    }
    w.version++;
    return seen;
  }

  addLine(kind, name, loopFlat, stationIds, epoch, vehicles, tracks) {
    const type = LINE_TYPES[kind];
    const cum = cumulative(loopFlat);
    const L = cum[cum.length - 1];
    // Haltepunkte: jede Station auf der Schleife (Straßenbahn: zweimal, je Richtung)
    const stops = [];
    for (const sid of stationIds) {
      const st = this.stations[sid];
      for (const s of this.stationPositions(loopFlat, cum, st)) stops.push({ station: sid, s });
    }
    stops.sort((a, b) => a.s - b.s);
    const line = {
      id: this.nextLineId++, kind, name, color: kind === 'ring' ? '#3f74d6' : '#d2402f',
      pts: loopFlat, cum, length: L, stops, vehicles, speed: type.speed, dwell: type.dwell,
      epoch, cars: type.cars, carLen: type.carLen, capacity: type.capacity, tracks,
      stations: [...new Set(stationIds)],
    };
    this.buildTimetable(line);
    this.lines.push(line);
    for (const sid of line.stations) {
      const st = this.stations[sid];
      st.lines = st.lines || [];
      if (!st.lines.includes(line.id)) st.lines.push(line.id);
    }
    return line;
  }

  // Bogenlängen, an denen die Schleife an der Station vorbeiführt (eine je Durchfahrt).
  stationPositions(flat, cum, st) {
    const L = cum[cum.length - 1];
    const n = flat.length / 2;
    const runs = [];
    let cur = null;
    for (let i = 1; i < n; i++) {
      const ax = flat[2 * i - 2], az = flat[2 * i - 1];
      const dx = flat[2 * i] - ax, dz = flat[2 * i + 1] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((st.x - ax) * dx + (st.z - az) * dz) / l2));
      const d = Math.hypot(ax + dx * t - st.x, az + dz * t - st.z);
      if (d < 1.6) {
        const sPos = cum[i - 1] + Math.sqrt(l2) * t;
        if (!cur) runs.push((cur = { d, s: sPos }));
        else if (d < cur.d) { cur.d = d; cur.s = sPos; }
      } else {
        cur = null;
      }
    }
    // Lauf über Anfang/Ende der Schleife zusammenfassen
    if (runs.length > 1) {
      const first = runs[0], lastRun = runs[runs.length - 1];
      if (first.s < 1.6 && lastRun.s > L - 1.6) {
        if (lastRun.d < first.d) runs[0] = lastRun;
        runs.pop();
      }
    }
    if (runs.length === 0) runs.push({ s: projectOnPolyline(flat, cum, st.x, st.z).s });
    return runs.map((r) => Math.min(L - 0.01, r.s));
  }

  buildTimetable(line) {
    const { stops, speed, dwell, length } = line;
    let t = 0;
    const table = [];
    for (let i = 0; i < stops.length; i++) {
      const a = stops[i];
      const b = stops[(i + 1) % stops.length];
      let dist = b.s - a.s;
      if (dist <= 0) dist += length;
      table.push({ arr: t, dep: t + dwell, s: a.s, dist, travel: (dist / speed) * EASE });
      t += dwell + (dist / speed) * EASE;
    }
    line.period = t; // Sekunden
    line.table = table;
  }

  // Fahrzeug k: Zykluszeit (s) zum Zeitpunkt tSim (ms)
  phase(line, k, tSim) {
    const P = line.period;
    const x = ((tSim - line.epoch) / 1000 + (k * P) / line.vehicles) % P;
    return x < 0 ? x + P : x;
  }

  // Nächste Abfahrt an Haltepunkt i ab tSim → {k, dep (ms)}
  nextDeparture(line, i, tSim) {
    let best = null;
    const P = line.period;
    for (let k = 0; k < line.vehicles; k++) {
      const ph = this.phase(line, k, tSim);
      let wait = line.table[i].dep - ph;
      if (wait < 0.5) wait += P; // Tür geht gerade zu → nächster Zug
      if (!best || wait < best.wait) best = { k, wait };
    }
    return { k: best.k, dep: tSim + best.wait * 1000 };
  }

  rideSeconds(line, i, j) {
    let d = line.table[j].arr - line.table[i].dep;
    if (d <= 0) d += line.period;
    return d;
  }

  // Bester Weg mit einer Linie zwischen zwei Stationen in Laufweite.
  // nearA/nearB: [{station, walk}] mit Gehdistanz in Kacheln
  bestConnection(nearA, nearB, tSim, walkSpeed) {
    let best = null;
    for (const a of nearA) {
      for (const b of nearB) {
        if (a.station === b.station) continue;
        for (const line of this.lines) {
          if (!line.stations.includes(a.station) || !line.stations.includes(b.station)) continue;
          for (let i = 0; i < line.stops.length; i++) {
            if (line.stops[i].station !== a.station) continue;
            const arriveAtStop = tSim + (a.walk / walkSpeed) * 1000;
            const dep = this.nextDeparture(line, i, arriveAtStop);
            for (let j = 0; j < line.stops.length; j++) {
              if (line.stops[j].station !== b.station) continue;
              const ride = this.rideSeconds(line, i, j);
              const total = (dep.dep - tSim) / 1000 + ride + b.walk / walkSpeed;
              if (!best || total < best.total) {
                best = { line, i, j, k: dep.k, dep: dep.dep, arr: dep.dep + ride * 1000, total, a, b };
              }
            }
          }
        }
      }
    }
    return best;
  }

  stationsNear(x, z, maxDist) {
    const out = [];
    for (const st of this.stations) {
      const d = Math.abs(st.x - x) + Math.abs(st.z - z);
      if (d <= maxDist) out.push({ station: st.id, walk: d * 1.15 });
    }
    return out;
  }

  board(lineId, k, rid) {
    const key = `${lineId}:${k}`;
    let set = this.passengers.get(key);
    if (!set) this.passengers.set(key, (set = new Set()));
    set.add(rid);
  }

  alight(lineId, k, rid) {
    this.passengers.get(`${lineId}:${k}`)?.delete(rid);
  }

  // ---------------------------------------------------------------- Straßenbahnbau
  // Sucht die „ideale“ Strecke zwischen zwei Kacheln. Gleise dürfen Straßen nur
  // rechtwinklig kreuzen; Gebäude im Weg sind teuer, aber möglich (Abriss).
  planTramPath(from, to, demolitionCost) {
    const w = this.world;
    const s = w.size;
    const n = s * s * 4;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const DX = [1, 0, -1, 0];
    const DZ = [0, 1, 0, -1];
    const tx = to % s, tz = Math.floor(to / s);
    const inside = (i, j) => i >= MARGIN && j >= MARGIN && i < MARGIN + w.inner && j < MARGIN + w.inner;
    const h = (k) => Math.abs((k % s) - tx) + Math.abs(Math.floor(k / s) - tz);
    for (let d = 0; d < 4; d++) {
      g[from * 4 + d] = 0;
      heap.push(h(from), from * 4 + d);
    }
    let goal = -1;
    while (heap.size) {
      const st = heap.pop();
      if (closed[st]) continue;
      closed[st] = 1;
      const k = st >> 2;
      const dir = st & 3;
      if (k === to) { goal = st; break; }
      const i = k % s, j = Math.floor(k / s);
      const onCross = w.type[k] === T.ROAD || w.rail[k] > 0;
      for (let nd = 0; nd < 4; nd++) {
        if ((nd + 2) % 4 === dir && k !== from) continue; // nicht umkehren
        if (onCross && k !== from && nd !== dir) continue; // auf Kreuzungen geradeaus
        const ni = i + DX[nd], nj = j + DZ[nd];
        if (!inside(ni, nj)) continue;
        const nk = nj * s + ni;
        let cost = 1;
        if (w.station[nk] >= 0 && nk !== to) continue;
        if (w.type[nk] === T.ROAD) {
          if (w.isIntersection(nk)) continue;
          const axis = w.roadAxis(nk);
          const moveAxis = nd % 2 === 0 ? 'x' : 'z';
          if (axis === moveAxis) continue; // nicht längs auf der Straße
          if (w.rail[nk]) continue;
          cost += 0.6;
        } else if (w.rail[nk]) {
          if (w.rail[k] && w.type[k] !== T.ROAD) continue; // nicht längs neben fremden Gleisen
          cost += 1.5; // fremdes Gleis kreuzen
        } else if (w.type[nk] === T.PARK) {
          cost += 0.4;
        } else if (w.type[nk] === T.PLOT) {
          cost += demolitionCost(w.plots[w.plotOf[nk]]);
        }
        if (nd !== dir && k !== from) cost += 1.2;
        const ns = nk * 4 + nd;
        const ng = g[st] + cost;
        if (ng < g[ns]) {
          g[ns] = ng;
          came[ns] = st;
          heap.push(ng + h(nk), ns);
        }
      }
    }
    if (goal < 0) return null;
    const tiles = [];
    for (let st = goal; st !== -1; st = came[st]) {
      const k = st >> 2;
      if (tiles[tiles.length - 1] !== k) tiles.push(k);
    }
    tiles.reverse();
    return tiles;
  }

  // Baut eine Straßenbahnlinie entlang der Kachelstrecke.
  buildTram(tiles, nameA, nameB, epoch) {
    const w = this.world;
    // Haltestellen: Anfang, Ende und etwa alle 9 Kacheln (nicht auf Straßen/Kreuzungen)
    const stopIdx = [0];
    let last = 0;
    for (let q = 1; q < tiles.length - 1; q++) {
      const k = tiles[q];
      if (q - last >= 9 && tiles.length - 1 - q >= 5 && w.type[k] !== T.ROAD && w.rail[k] === 0) {
        stopIdx.push(q);
        last = q;
      }
    }
    stopIdx.push(tiles.length - 1);

    const center = roundCorners(simplify(tiles.map((k) => [w.tileX(k), w.tileZ(k)])), 0.55, 4);
    const fwd = offsetRight(center, 0.2);
    const back = offsetRight(center.slice().reverse(), 0.2);
    const loop = flatten([...fwd, ...back, fwd[0]]);
    const tracks = [flatten(fwd), flatten(back)];
    const railTiles = new Set();
    for (const tr of tracks) for (const k of this.markTrack(tr)) railTiles.add(k);

    const stationIds = [];
    for (let q = 0; q < stopIdx.length; q++) {
      const k = tiles[stopIdx[q]];
      let name;
      if (q === 0) name = nameA;
      else if (q === stopIdx.length - 1) name = nameB;
      else name = STREETS[this.streetIdx++ % STREETS.length];
      const a = tiles[Math.max(0, stopIdx[q] - 1)], b = tiles[Math.min(tiles.length - 1, stopIdx[q] + 1)];
      const rot = Math.atan2(w.tileX(b) - w.tileX(a), w.tileZ(b) - w.tileZ(a));
      const existing = this.stations.find((st) => st.tile === k);
      const st = existing || this.addStation(name, w.tileX(k), w.tileZ(k), rot, 'tram');
      stationIds.push(st.id);
    }
    const lengthTiles = tiles.length;
    const vehicles = Math.max(1, Math.min(4, Math.round(lengthTiles / 22)));
    const line = this.addLine('tram', `Tram ${nameA} – ${nameB}`, loop, stationIds, epoch, vehicles, tracks);
    line.tiles = tiles;
    line.railTiles = railTiles;
    w.version++;
    return line;
  }

  // ---------------------------------------------------------------- Speichern/Laden
  serialize() {
    return {
      nextLineId: this.nextLineId,
      streetIdx: this.streetIdx,
      stations: this.stations.map((s) => ({ ...s })),
      lines: this.lines.map((l) => ({
        id: l.id, kind: l.kind, name: l.name, pts: l.pts, stations: l.stations, vehicles: l.vehicles,
        epoch: l.epoch, tracks: l.tracks, tiles: l.tiles || null,
      })),
    };
  }

  restore(data) {
    const w = this.world;
    this.streetIdx = data.streetIdx || 0;
    this.stations = data.stations;
    for (const st of this.stations) {
      st.lines = [];
      if (st.tile >= 0) w.station[st.tile] = st.id;
    }
    for (const l of data.lines) {
      for (const tr of l.tracks) this.markTrack(tr);
      this.nextLineId = l.id;
      const line = this.addLine(l.kind, l.name, l.pts, l.stations, l.epoch, l.vehicles, l.tracks);
      line.tiles = l.tiles;
    }
    this.nextLineId = Math.max(data.nextLineId || 1, ...this.lines.map((l) => l.id + 1));
  }

  clientLines() {
    return this.lines.map((l) => ({
      id: l.id, kind: l.kind, name: l.name, color: l.color, pts: l.pts, length: round2(l.length),
      vehicles: l.vehicles, epoch: l.epoch, period: l.period, cars: l.cars, carLen: l.carLen,
      table: l.table.map((t) => [round2(t.arr), round2(t.dep), round2(t.s), round2(t.dist), round2(t.travel)]),
      tracks: l.tracks,
      stations: l.stations,
    }));
  }

  clientStations() {
    return this.stations.map((s) => ({
      id: s.id, name: s.name, x: s.x, z: s.z, px: s.px, pz: s.pz, rot: round2(s.rot), kind: s.kind,
    }));
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

export { BLOCK };
