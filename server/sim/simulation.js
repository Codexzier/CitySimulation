// Die eigentliche Stadtsimulation: Einwohner, Gebäude, Verkehr, Umwelt, Statistik.
import { TIME } from '../config.js';
import { Rng } from '../util/rng.js';
import { MinHeap } from '../util/heap.js';
import { World, DISTRICTS } from './world.js';
import {
  PathFinder, tilesToPoints, simplify, offsetRight, roundCorners, polyLength, flatten,
} from './paths.js';
import { Transit } from './transit.js';
import {
  VORNAMEN_W, VORNAMEN_M, NACHNAMEN, BRANCHEN_JE_VIERTEL, BERUFE, BETRIEBSNAMEN, EMOTES,
} from './names.js';

const { HOUR, DAY } = TIME;
export const STATE_VERSION = 3;

const WALK_SPEED = 0.32; // Kacheln je Sekunde (1 Kachel ≈ 10 m)
const CAR_SPEED = 1.15;
const CAP = [0, 4, 10, 20]; // Bewohner je Stufe: Haus, Mehrfamilienhaus, Hochhaus
const LEVEL_NAME = ['', 'Einfamilienhaus', 'Mehrfamilienhaus', 'Hochhaus'];
const RES_DISTRICTS = [0, 2, 4];
const IND_DISTRICTS = [1, 3, 5];
const P0 = 40; // Schadstoffmenge je Zelle, bei der die Luftqualität auf 37 % fällt
const SEASONS = ['Frühling', 'Sommer', 'Herbst', 'Winter'];

const letters = (a, b) => Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i));
const MODELS = {
  1: letters('a', 'u').map((c) => `suburban/building-type-${c}`),
  2: letters('a', 'k').map((c) => `commercial/building-${c}`),
  3: [...letters('a', 'e').map((c) => `commercial/building-skyscraper-${c}`), 'commercial/building-l', 'commercial/building-m'],
};
// Grundfläche der Industriegebäude (aus den Modellen) → Arbeitsplätze
const IND_SIZES = {
  a: [2.08, 1.24], b: [2.08, 1.26], c: [1.88, 2.11], d: [0.88, 1.42], e: [1.68, 1.29], f: [1.79, 1.28],
  g: [1.68, 1.28], h: [1.32, 1.31], i: [1.03, 1.3], j: [1.03, 1.3], k: [1.3, 0.91], l: [2.08, 1.87],
  m: [1.32, 1.7], n: [0.98, 1.42], o: [0.88, 1.24], p: [1.68, 0.99], q: [2.14, 1.77], r: [2.48, 1.27],
  s: [2.12, 0.92], t: [1.72, 1.39],
};
export const CHAR_MODELS = [
  ...letters('a', 'f').map((c) => `characters/character-female-${c}`),
  ...letters('a', 'f').map((c) => `characters/character-male-${c}`),
];
export const CAR_MODELS = ['cars/sedan', 'cars/suv', 'cars/hatchback-sports', 'cars/van', 'cars/suv-luxury',
  'cars/sedan-sports', 'cars/taxi'];
const RES_STREETS = ['Lindenweg', 'Amselweg', 'Fliederstraße', 'Tulpenweg', 'Sonnenstraße', 'Ahornallee',
  'Drosselgasse', 'Kirschweg', 'Erlenring', 'Wiesenstraße', 'Talweg', 'Rosenweg', 'Buchenweg', 'Am Hang'];
const IND_STREETS = ['Werkstraße', 'Industriering', 'Hafenstraße', 'Gewerbeweg', 'Kanalstraße', 'Schmiedestraße'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;

export class Simulation {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.cycleMs = 2 * cfg.tagNachtWechselMs;
    this.outbox = [];
    this.visible = new Map();
    this.queue = new MinHeap();
    this.residents = new Map();
    this.buildings = new Map();
    this.weather = { temp: 14, typ: 'bewoelkt', text: 'Bewölkt', wind: 10, niederschlag: 0, quelle: 'start' };
    this.perf = { cpu: 0, limitEinwohner: cfg.maxEinwohner, gedrosselt: false };
    this.zuzug = { aktiv: true, grund: '' };
    this.news = [];
  }

  // ======================================================================= Aufbau
  init(saved) {
    if (saved && saved.version === STATE_VERSION) {
      try {
        this.restore(saved);
        this.log.log(`[sim] Stadt geladen: ${this.residents.size} Einwohner, Tag ${this.dayIndex() + 1}`);
        return;
      } catch (err) {
        this.log.error('[sim] Spielstand defekt, gründe neue Stadt:', err);
      }
    }
    this.create();
    this.log.log(`[sim] Neue Stadt „${this.cfg.stadtName}“ gegründet (Seed ${this.seed})`);
  }

  create() {
    this.seed = this.cfg.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.rng = new Rng(this.seed ^ 0x5bd1e995);
    this.blocks = this.cfg.stadtBloecke;
    this.world = new World(this.blocks, new Rng(this.seed));
    this.transit = new Transit(this.world);
    this.paths = new PathFinder(this.world);
    this.simMs = 0;
    this.nextRid = 1;
    this.nextBid = 1;
    this.founded = new Date().toISOString();
    this.initRuntime();
    this.transit.buildRing(0);
    for (const d of IND_DISTRICTS) this.buildFactory(d);
    for (let i = 0; i < this.cfg.startEinwohner; i++) {
      this.spawnResident(this.rng.range(0, 0.5) * this.cfg.lebensdauerMinMs);
    }
    this.world.updateRoads();
    this.outbox.length = 0;
  }

  initRuntime() {
    const w = this.world;
    this.tileLoad = new Int16Array(w.size * w.size);
    this.cells = Math.ceil(w.size / 5);
    this.pollution = this.pollution || new Float32Array(this.cells * this.cells);
    this.odCar = this.odCar || DISTRICTS.map(() => DISTRICTS.map(() => 0));
    this.odPrev = this.odPrev || DISTRICTS.map(() => DISTRICTS.map(() => 0));
    this.tramCooldown = this.tramCooldown || {};
    this.history = this.history || { stunden: [], tage: [] };
    this.dayAcc = this.dayAcc || this.newDayAcc();
    this.modeEma = this.modeEma || { fuss: 1, auto: 0, bahn: 0 };
    this.immigrationAcc = this.immigrationAcc || 0;
    this.emissionRate = this.emissionRate || 0;
    this.emissionWindow = 0;
    this.emoteAcc = 0;
    this.buildingEmoteAcc = 0;
    this.nextHourAt = Math.floor(this.simMs / HOUR) * HOUR + HOUR;
    this.cycleHourMs = this.cycleMs / 24;
    this.nextCycleHourAt = Math.floor(this.simMs / this.cycleHourMs) * this.cycleHourMs + this.cycleHourMs;
    this.lastDeathCheck = 0;
  }

  newDayAcc() {
    return { emissionKg: 0, luft: 0, glueck: 0, samples: 0, fuss: 0, auto: 0, bahn: 0, arbeitslose: 0 };
  }

  // ======================================================================= Zeit
  hod(t = this.simMs) {
    const x = (t / this.cycleMs + 0.25) % 1; // Start um 6:00 Uhr
    return x * 24;
  }

  nextHod(t, h) {
    const dh = (((h - this.hod(t)) % 24) + 24) % 24;
    return t + (dh / 24) * this.cycleMs;
  }

  hodMs(h) {
    return (h / 24) * this.cycleMs;
  }

  cycleIndex(t = this.simMs) {
    return Math.floor(t / this.cycleMs + 0.25);
  }

  dayIndex(t = this.simMs) {
    return Math.floor(t / DAY);
  }

  isNight(t = this.simMs) {
    const h = this.hod(t);
    return h < 6 || h >= 18;
  }

  clockInfo() {
    const h = this.hod();
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    const yearPos = (this.simMs % this.cfg.jahrMs) / this.cfg.jahrMs;
    return {
      tag: this.dayIndex() + 1,
      jahr: Math.floor(this.simMs / this.cfg.jahrMs) + 1,
      jahreszeit: SEASONS[Math.floor(yearPos * 4) % 4],
      jahresAnteil: r2(yearPos),
      uhr: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      nacht: this.isNight(),
    };
  }

  ageDays(r) {
    return (this.simMs - r.geb) / DAY;
  }

  phase(r) {
    const age = this.simMs - r.geb;
    if (age >= this.cfg.lebensdauerMinMs * 0.9) return 'rente';
    if (age < this.cfg.lebensdauerMinMs * 0.08) return 'azubi';
    return 'arbeit';
  }

  // ======================================================================= Ereignisse
  schedule(r, t, a) {
    r.seq++;
    r.nextAt = t;
    r.nextA = a;
    this.queue.push(t, { rid: r.id, seq: r.seq, a });
  }

  emit(msg) {
    this.outbox.push(msg);
  }

  // Ein Simulationsschritt über dtSim Millisekunden Simulationszeit
  step(dtSim) {
    const end = this.simMs + dtSim;
    while (this.queue.size && this.queue.peekKey() <= end) {
      const t = this.queue.peekKey();
      const ev = this.queue.pop();
      if (t > this.simMs) this.simMs = t;
      const r = this.residents.get(ev.rid);
      if (!r || r.seq !== ev.seq) continue;
      this.handle(r, ev.a);
    }
    this.simMs = end;
    while (this.nextCycleHourAt <= end) {
      this.onCycleHour(this.nextCycleHourAt);
      this.nextCycleHourAt += this.cycleHourMs;
    }
    while (this.nextHourAt <= end) {
      this.onHour(this.nextHourAt);
      this.nextHourAt += HOUR;
    }
    this.immigration(dtSim);
    if (end - this.lastDeathCheck > 2000 || dtSim > 2000) {
      this.deaths();
      this.lastDeathCheck = end;
    }
    this.environment(dtSim);
    this.randomEmotes(dtSim);
  }

  handle(r, a) {
    switch (a) {
      case 'work': this.startTrip(r, 'work'); break;
      case 'home': this.startTrip(r, 'home'); break;
      case 'leisure': this.startTrip(r, 'leisure'); break;
      case 'leg': this.nextLeg(r); break;
      case 'plan': this.planFromHome(r); break;
      default: break;
    }
  }

  // ======================================================================= Einwohner
  spawnResident(age = 0) {
    const female = this.rng.chance(0.5);
    const r = {
      id: this.nextRid++,
      vn: this.rng.pick(female ? VORNAMEN_W : VORNAMEN_M),
      nn: this.rng.pick(NACHNAMEN),
      w: female,
      m: female ? this.rng.int(0, 5) : this.rng.int(6, 11),
      car: this.rng.chance(0.06) ? 6 : this.rng.int(0, 5),
      geb: this.simMs - age,
      tod: this.simMs - age + this.rng.range(this.cfg.lebensdauerMinMs, this.cfg.lebensdauerMaxMs),
      home: null,
      job: null,
      beruf: null,
      glueck: 62 + this.rng.range(-8, 8),
      partner: null,
      ort: 'home',
      seq: 0,
      schicht: this.rng.chance(0.12) ? 'nacht' : 'tag',
      start: 0,
      eco: this.rng.next(),
      auto: this.rng.chance(0.85),
      modus: null,
      pendel: 0,
      stau: 0,
      umzug: 0,
      trauer: 0,
      freizeit: -1,
      emo: null,
      trip: null,
      place: null,
      atWork: false,
    };
    r.start = r.schicht === 'tag' ? this.rng.range(5.8, 8.2) : this.rng.range(20.8, 21.6);
    const home = this.placeResident(r);
    if (!home) {
      this.nextRid--;
      return null;
    }
    this.residents.set(r.id, r);
    this.findJob(r);
    this.planFromHome(r, this.simMs + this.rng.range(0, 20_000));
    return r;
  }

  removeResident(r, reason) {
    this.endTripState(r);
    if (r.home) {
      const b = this.buildings.get(r.home);
      if (b) b.bewohner = b.bewohner.filter((x) => x !== r.id);
    }
    this.quitJob(r);
    if (r.partner) {
      const p = this.residents.get(r.partner);
      if (p) {
        p.partner = null;
        if (reason === 'tod') {
          p.trauer = this.simMs;
          if (this.visible.has(p.id)) this.showEmote(p, 'liebeskummer', 6000);
        }
      }
    }
    this.residents.delete(r.id);
    r.seq++;
  }

  // Beendet laufende Wege (sichtbare Figuren, Fahrzeugbelegung, Straßenlast)
  endTripState(r) {
    const tr = r.trip;
    if (tr) {
      const leg = tr.legs[tr.i];
      if (leg) this.endLeg(r, leg, tr);
      r.trip = null;
    }
    if (this.visible.has(r.id)) {
      this.visible.delete(r.id);
      this.emit({ e: 'h', id: r.id });
    }
    if (r.atWork) {
      const job = this.buildings.get(r.job);
      if (job) job.anwesend = Math.max(0, job.anwesend - 1);
      r.atWork = false;
    }
  }

  deaths() {
    const dead = [];
    for (const r of this.residents.values()) if (r.tod <= this.simMs) dead.push(r);
    for (const r of dead) {
      const home = this.buildings.get(r.home);
      this.removeResident(r, 'tod');
      if (home) this.buildingEmote(home, 'liebeskummer', 5000);
    }
    if (dead.length) this.dayAcc.tode = (this.dayAcc.tode || 0) + dead.length;
  }

  immigration(dtSim) {
    this.immigrationAcc += (dtSim / HOUR) * this.cfg.einwohnerProStunde;
    let guard = 0;
    while (this.immigrationAcc >= 1 && guard++ < 500) {
      const pop = this.residents.size;
      if (pop >= this.perf.limitEinwohner) {
        this.zuzug = { aktiv: false, grund: pop >= this.cfg.maxEinwohner ? 'Maximum erreicht' : 'Leistungsgrenze erreicht' };
        this.immigrationAcc = Math.min(this.immigrationAcc, 1);
        return;
      }
      const r = this.spawnResident(0);
      if (!r) {
        this.zuzug = { aktiv: false, grund: 'kein Wohnraum frei' };
        this.immigrationAcc = Math.min(this.immigrationAcc, 1);
        return;
      }
      this.zuzug = { aktiv: true, grund: '' };
      this.dayAcc.zuzuege = (this.dayAcc.zuzuege || 0) + 1;
      this.immigrationAcc -= 1;
      if (this.visible.has(r.id)) this.showEmote(r, 'fragend', 5000);
    }
  }

  // ======================================================================= Wohnen
  districtPopulation(d) {
    let n = 0;
    for (const b of this.buildings.values()) if (b.kind === 'wohnen' && b.d === d) n += b.bewohner.length;
    return n;
  }

  placeResident(r, prefer = null) {
    const order = RES_DISTRICTS
      .map((d) => [d, this.districtPopulation(d) + (d === prefer ? -1e6 : 0) + this.rng.next()])
      .sort((a, b) => a[1] - b[1])
      .map((x) => x[0]);
    for (const d of order) {
      const b = this.housingInDistrict(d);
      if (b) {
        b.bewohner.push(r.id);
        r.home = b.id;
        return b;
      }
    }
    return null;
  }

  // Gleichmäßige Verteilung: erst freie Plätze, dann neue Häuser am Rand,
  // sonst Aufstockung in der Mitte (Einfamilienhaus → Mehrfamilienhaus → Hochhaus).
  housingInDistrict(d) {
    const list = [];
    let pop = 0;
    for (const b of this.buildings.values()) {
      if (b.kind !== 'wohnen' || b.d !== d) continue;
      list.push(b);
      pop += b.bewohner.length;
    }
    list.sort((a, b) => this.world.plots[a.plot].dist - this.world.plots[b.plot].dist);
    let best = null;
    let bestScore = Infinity;
    list.forEach((b, rank) => {
      const cap = CAP[b.level];
      if (b.bewohner.length >= cap) return;
      const score = b.bewohner.length / cap + rank * 0.001;
      if (score < bestScore) { bestScore = score; best = b; }
    });
    if (best) return best;
    const target = Math.ceil(2 + 2 * Math.sqrt(pop + 1));
    const freePlot = this.world.districtPlots[d].find((p) => p.buildingId === null && !p.blocked);
    if (list.length < target && freePlot) return this.buildHouse(freePlot);
    let up = null;
    let upScore = Infinity;
    list.forEach((b, rank) => {
      if (b.level >= 3) return;
      const score = b.level + (2.5 * rank) / list.length;
      if (score < upScore) { upScore = score; up = b; }
    });
    if (up) {
      this.upgrade(up);
      return up;
    }
    if (freePlot) return this.buildHouse(freePlot);
    return null;
  }

  buildHouse(plot) {
    const b = {
      id: this.nextBid++, kind: 'wohnen', plot: plot.id, d: plot.district, level: 1,
      model: this.rng.pick(MODELS[1]), bewohner: [], arbeiter: [], jobs: 0, anwesend: 0,
      gebaut: this.simMs, adresse: this.address(plot, RES_STREETS),
    };
    plot.buildingId = b.id;
    this.buildings.set(b.id, b);
    this.world.version++;
    if (this.world.updateRoads()) this.emit({ e: 'roads', roads: this.world.roadString() });
    this.emit({ e: 'b', b: this.clientBuilding(b) });
    return b;
  }

  upgrade(b) {
    b.level++;
    b.model = this.rng.pick(MODELS[b.level]);
    b.umgebaut = this.simMs;
    this.emit({ e: 'b', b: this.clientBuilding(b) });
    this.news.push({ t: this.simMs, text: `${b.adresse}: ${LEVEL_NAME[b.level - 1]} wird zum ${LEVEL_NAME[b.level]}` });
    if (this.news.length > 200) this.news.splice(0, this.news.length - 200);
  }

  address(plot, streets) {
    const street = streets[(plot.bj * 3 + plot.bi * 7 + (plot.facing === 'n' ? 1 : 0)) % streets.length];
    return `${street} ${plot.bi * 2 + plot.px + 1 + plot.py * 20}`;
  }

  // ======================================================================= Arbeit
  buildFactory(d) {
    const plot = this.world.districtPlots[d].find((p) => p.buildingId === null && !p.blocked);
    if (!plot) return null;
    const letter = this.rng.pick(Object.keys(IND_SIZES));
    const [sx, sz] = IND_SIZES[letter];
    const branche = this.rng.pick(BRANCHEN_JE_VIERTEL[d]);
    const b = {
      id: this.nextBid++, kind: 'industrie', plot: plot.id, d, level: 1,
      model: `industrial/building-${letter}`, bewohner: [], arbeiter: [], anwesend: 0,
      jobs: clamp(Math.round(sx * sz * 6), 6, 26), branche,
      name: `${this.rng.pick(BETRIEBSNAMEN[branche])} ${DISTRICTS[d].name}`,
      gebaut: this.simMs, adresse: this.address(plot, IND_STREETS),
    };
    plot.buildingId = b.id;
    this.buildings.set(b.id, b);
    this.world.version++;
    if (this.world.updateRoads()) this.emit({ e: 'roads', roads: this.world.roadString() });
    this.emit({ e: 'b', b: this.clientBuilding(b) });
    return b;
  }

  findJob(r) {
    if (this.phase(r) === 'rente') return false;
    const home = this.buildings.get(r.home);
    if (!home) return false;
    const hp = this.world.plots[home.plot];
    const cands = [];
    for (const b of this.buildings.values()) {
      if (b.kind !== 'industrie') continue;
      const free = b.jobs - b.arbeiter.length;
      if (free <= 0) continue;
      const p = this.world.plots[b.plot];
      const blocks = this.world.blocksBetween(hp.x, hp.z, p.x, p.z);
      cands.push([b, free / (1 + blocks / 10)]);
    }
    if (cands.length === 0) {
      const d = IND_DISTRICTS
        .map((x) => [x, this.districtJobs(x) + this.rng.next()])
        .sort((a, b) => a[1] - b[1])
        .map((x) => x[0])
        .find((x) => this.world.districtPlots[x].some((p) => p.buildingId === null && !p.blocked));
      if (d === undefined) return false;
      const nb = this.buildFactory(d);
      if (!nb) return false;
      cands.push([nb, 1]);
    }
    const job = this.rng.weighted(cands);
    this.takeJob(r, job);
    return true;
  }

  takeJob(r, job) {
    this.quitJob(r);
    job.arbeiter.push(r.id);
    r.job = job.id;
    const pair = this.rng.pick(BERUFE[job.branche]);
    r.beruf = pair[r.w ? 1 : 0];
  }

  quitJob(r) {
    if (!r.job) return;
    const b = this.buildings.get(r.job);
    if (b) {
      b.arbeiter = b.arbeiter.filter((x) => x !== r.id);
      if (r.atWork) b.anwesend = Math.max(0, b.anwesend - 1);
    }
    r.atWork = false;
    r.job = null;
  }

  districtJobs(d) {
    let n = 0;
    for (const b of this.buildings.values()) if (b.kind === 'industrie' && b.d === d) n += b.jobs;
    return n;
  }

  // ======================================================================= Tagesablauf
  planFromHome(r, at = this.simMs) {
    if (r.trip) return;
    const t = Math.max(at, this.simMs);
    const h = this.hod(t);
    const ci = this.cycleIndex(t);
    const working = r.job && this.phase(r) !== 'rente';
    const bad = ['regen', 'gewitter', 'schnee'].includes(this.weather.typ);
    const leisureChance = (bad ? 0.15 : 0.4) * (this.perf.gedrosselt ? 0.3 : 1);
    if (working) {
      const evening = r.schicht === 'tag' ? h >= 14.5 && h < 20.5 : h >= 12.5 && h < 18.5;
      if (evening && r.freizeit !== ci) {
        r.freizeit = ci;
        if (this.rng.chance(leisureChance)) {
          this.schedule(r, t + this.hodMs(this.rng.range(0.2, 1.5)), 'leisure');
          return;
        }
      }
      let leave = this.nextHod(t, r.start + this.rng.range(-0.2, 0.2));
      if (leave - t < this.hodMs(0.3)) leave += this.cycleMs; // gerade erst angekommen
      // Kommt vor der nächsten Schicht noch ein Freizeitfenster?
      const windowAt = this.nextHod(t, r.schicht === 'tag' ? 15 : 13) + this.hodMs(this.rng.range(0, 1));
      if (windowAt < leave - this.hodMs(1.5) && this.cycleIndex(windowAt) !== r.freizeit) {
        this.schedule(r, windowAt, 'plan');
        return;
      }
      this.schedule(r, leave, 'work');
      return;
    }
    // Rentner, Arbeitssuchende, Neubürger: bis zu zwei Ausflüge am Tag
    const outings = r.freizeit === ci ? (r.ausfluege || 0) : 0;
    if (h >= 8.5 && h < 18 && outings < 2 && this.rng.chance(0.65)) {
      r.freizeit = ci;
      r.ausfluege = outings + 1;
      this.schedule(r, t + this.hodMs(this.rng.range(0.2, 1.5)), 'leisure');
      return;
    }
    this.schedule(r, this.nextHod(t, this.rng.range(8.6, 12)), 'plan');
  }

  // ======================================================================= Wege
  buildingPlace(b) {
    const p = this.world.plots[b.plot];
    return { kind: 'gebaeude', id: b.id, x: p.x, z: p.z, tile: p.front, door: p.door, d: b.d };
  }

  stationPlace(st) {
    return { kind: 'station', id: st.id, x: st.px, z: st.pz, tile: st.tile, door: { x: st.px, z: st.pz } };
  }

  currentPlace(r) {
    if (r.place) return r.place;
    const b = this.buildings.get(r.home);
    return b ? this.buildingPlace(b) : null;
  }

  leisureTarget(r) {
    const bad = ['regen', 'gewitter', 'schnee'].includes(this.weather.typ);
    const choice = this.rng.weighted(bad ? [['park', 3], ['besuch', 6]] : [['park', 6], ['besuch', 2], ['bummel', 2]]);
    if (choice === 'besuch') {
      const home = this.buildings.get(r.home);
      const hp = home ? this.world.plots[home.plot] : null;
      const cands = [];
      for (const b of this.buildings.values()) {
        if (b.kind !== 'wohnen' || b.id === r.home) continue;
        const p = this.world.plots[b.plot];
        if (hp && this.world.blocksBetween(hp.x, hp.z, p.x, p.z) > 7) continue;
        cands.push(b);
      }
      if (cands.length) {
        const pl = this.buildingPlace(this.rng.pick(cands));
        pl.besuch = true;
        return pl;
      }
    }
    if (choice === 'bummel') {
      const from = this.currentPlace(r);
      for (let tries = 0; tries < 6; tries++) {
        const x = from.x + this.rng.range(-12, 12);
        const z = from.z + this.rng.range(-12, 12);
        const k = this.world.tileAt(x, z);
        if (k >= 0 && this.world.type[k] === 1 && this.world.roadActive[k]) {
          const px = this.world.tileX(k), pz = this.world.tileZ(k);
          return { kind: 'bummel', x: px, z: pz, tile: k, door: { x: px, z: pz } };
        }
      }
    }
    const k = this.rng.pick(this.world.parkTiles);
    const x = this.world.tileX(k) + this.rng.range(-0.35, 0.35);
    const z = this.world.tileZ(k) + this.rng.range(-0.35, 0.35);
    return { kind: 'park', x, z, tile: k, door: { x, z } };
  }

  startTrip(r, purpose) {
    const from = this.currentPlace(r);
    let to = null;
    if (purpose === 'work') {
      const job = this.buildings.get(r.job);
      if (!job || this.phase(r) === 'rente') return this.planFromHome(r);
      to = this.buildingPlace(job);
    } else if (purpose === 'home') {
      const home = this.buildings.get(r.home);
      if (!home) return;
      to = this.buildingPlace(home);
    } else {
      to = this.leisureTarget(r);
    }
    if (!from || !to) return this.schedule(r, this.simMs + this.hodMs(1), 'plan');
    if (r.atWork) {
      const job = this.buildings.get(r.job);
      if (job) job.anwesend = Math.max(0, job.anwesend - 1);
      r.atWork = false;
    }
    const { legs, mode } = this.planLegs(r, from, to);
    if (purpose === 'leisure' && (to.kind === 'park' || to.kind === 'bummel')) {
      const stay = to.kind === 'park' ? this.hodMs(this.rng.range(0.6, 2.2)) : this.hodMs(this.rng.range(0.05, 0.2));
      legs.push({ k: 'idle', x: to.x, z: to.z, dur: stay, rot: this.rng.range(-Math.PI, Math.PI) });
    }
    r.trip = { purpose, legs, i: -1, to, start: this.simMs, mode };
    r.ort = 'unterwegs';
    if (purpose === 'work') {
      r.modus = mode;
      this.modeEma[mode] = (this.modeEma[mode] || 0) + 1;
      this.dayAcc[mode] = (this.dayAcc[mode] || 0) + 1;
      r.trip.workEnd = this.simMs + this.hodMs(8 + this.rng.range(-0.3, 0.4));
      if (mode === 'auto') {
        const home = this.buildings.get(r.home);
        const job = this.buildings.get(r.job);
        if (home && job) this.odCar[home.d][job.d]++;
      }
    }
    this.nextLeg(r);
  }

  planLegs(r, from, to) {
    const blocks = this.world.blocksBetween(from.door.x, from.door.z, to.door.x, to.door.z);
    const legs = [];
    if (blocks <= this.cfg.zuFussBloecke) {
      legs.push(this.walkLeg(r, from, to));
      return { legs, mode: 'fuss' };
    }
    const car = r.auto ? this.carLeg(from, to) : null;
    let conn = null;
    if (this.transit.lines.length) {
      const nearA = this.transit.stationsNear(from.door.x, from.door.z, 16);
      const nearB = this.transit.stationsNear(to.door.x, to.door.z, 16);
      if (nearA.length && nearB.length) conn = this.transit.bestConnection(nearA, nearB, this.simMs, WALK_SPEED);
    }
    const carSec = car ? car.dur / 1000 + 15 : Infinity;
    if (conn && (conn.total < carSec * (1.15 + r.eco * 0.9) || !car)) {
      const stA = this.transit.stations[conn.a.station];
      const stB = this.transit.stations[conn.b.station];
      const pA = this.stationPlace(stA);
      const pB = this.stationPlace(stB);
      pA.x += this.rng.range(-0.25, 0.25);
      pA.door = { x: pA.x, z: pA.z };
      legs.push(this.walkLeg(r, from, pA));
      legs.push({ k: 'wait', line: conn.line.id, i: conn.i, j: conn.j, x: pA.x, z: pA.z, rot: stA.rot });
      legs.push({ k: 'ride', line: conn.line.id, i: conn.i, j: conn.j });
      legs.push(this.walkLeg(r, pB, to));
      return { legs, mode: 'bahn' };
    }
    if (car) {
      legs.push(car);
      return { legs, mode: 'auto' };
    }
    legs.push(this.walkLeg(r, from, to));
    return { legs, mode: 'fuss' };
  }

  walkLeg(r, from, to) {
    const tiles = this.paths.find(from.tile, to.tile, 'walk');
    let pts;
    if (!tiles) {
      pts = [[from.door.x, from.door.z], [to.door.x, to.door.z]];
    } else {
      let core = simplify(tilesToPoints(this.world, tiles));
      core = offsetRight(core, 0.3 + ((r.id * 37) % 10) / 100);
      core = roundCorners(core, 0.25, 2);
      pts = [[from.door.x, from.door.z], ...core, [to.door.x, to.door.z]];
    }
    const len = polyLength(pts);
    const slow = this.ageDays(r) > this.cfg.lebensdauerMinMs / DAY ? 1.3 : 1;
    return { k: 'walk', pts: flatten(pts), dur: Math.max(500, (len / WALK_SPEED) * 1000 * slow), len };
  }

  carLeg(from, to) {
    const tiles = this.paths.find(from.tile, to.tile, 'car');
    if (!tiles || tiles.length < 2) return null;
    let core = simplify(tilesToPoints(this.world, tiles));
    core = offsetRight(core, 0.2);
    core = roundCorners(core, 0.4, 3);
    const len = polyLength(core);
    let load = 0;
    for (const k of tiles) load += this.tileLoad[k];
    const avg = load / tiles.length;
    const cong = 1 + Math.max(0, avg - 1.2) * 0.4;
    return { k: 'car', pts: flatten(core), dur: (len / CAR_SPEED) * cong * 1000, tiles, stau: cong > 1.7, len };
  }

  nextLeg(r) {
    const tr = r.trip;
    if (!tr) return;
    const prev = tr.legs[tr.i];
    if (prev) this.endLeg(r, prev, tr);
    tr.i++;
    if (tr.i >= tr.legs.length) return this.arrive(r);
    const leg = tr.legs[tr.i];
    const t = this.simMs;
    switch (leg.k) {
      case 'walk': {
        this.show(r, { e: 'a', id: r.id, k: 'w', m: r.m, p: leg.pts, t0: t, d: Math.round(leg.dur) }, 'walk');
        this.schedule(r, t + leg.dur, 'leg');
        break;
      }
      case 'car': {
        for (const k of leg.tiles) this.tileLoad[k]++;
        const kg = leg.len * 0.12;
        for (const k of leg.tiles) this.addPollution(k, kg / leg.tiles.length);
        if (leg.stau) r.stau = this.simMs;
        tr.stau = leg.stau;
        this.show(r, { e: 'a', id: r.id, k: 'c', m: r.car, p: leg.pts, t0: t, d: Math.round(leg.dur) }, 'car');
        this.schedule(r, t + leg.dur, 'leg');
        break;
      }
      case 'wait': {
        const line = this.transit.lines.find((l) => l.id === leg.line);
        if (!line) { tr.legs.splice(tr.i, 2); tr.i--; return this.nextLeg(r); }
        const dep = this.transit.nextDeparture(line, leg.i, t);
        tr.veh = dep.k;
        tr.dep = dep.dep;
        this.show(r, { e: 'a', id: r.id, k: 'i', m: r.m, p: [r2(leg.x), r2(leg.z)], r: r2(leg.rot), t0: t, d: Math.round(dep.dep - t) }, 'wait');
        this.schedule(r, dep.dep, 'leg');
        break;
      }
      case 'ride': {
        const line = this.transit.lines.find((l) => l.id === leg.line);
        if (!line) { tr.legs.splice(tr.i, 1); tr.i--; return this.nextLeg(r); }
        this.hide(r);
        this.transit.board(line.id, tr.veh, r.id);
        const arr = tr.dep + this.transit.rideSeconds(line, leg.i, leg.j) * 1000;
        this.schedule(r, Math.max(t + 100, arr), 'leg');
        break;
      }
      case 'idle': {
        this.show(r, { e: 'a', id: r.id, k: 'i', m: r.m, p: [r2(leg.x), r2(leg.z)], r: r2(leg.rot), t0: t, d: Math.round(leg.dur) }, 'park');
        if (tr.to.kind === 'park') this.parkEncounter(r);
        this.schedule(r, t + leg.dur, 'leg');
        break;
      }
      default:
        this.nextLeg(r);
    }
  }

  endLeg(r, leg, tr) {
    if (leg.k === 'car') {
      for (const k of leg.tiles) this.tileLoad[k] = Math.max(0, this.tileLoad[k] - 1);
    } else if (leg.k === 'ride') {
      this.transit.alight(leg.line, tr.veh, r.id);
    }
  }

  arrive(r) {
    const tr = r.trip;
    r.trip = null;
    this.hide(r);
    const now = this.simMs;
    if (tr.purpose === 'work') {
      r.pendel = (now - tr.start) / 1000;
      const job = this.buildings.get(r.job);
      if (!job) {
        r.place = null;
        return this.startTrip(r, 'home');
      }
      r.ort = 'work';
      r.atWork = true;
      job.anwesend++;
      r.place = this.buildingPlace(job);
      this.schedule(r, Math.max(now + 1000, tr.workEnd), 'home');
    } else if (tr.purpose === 'home') {
      r.ort = 'home';
      r.place = null;
      this.planFromHome(r);
    } else {
      r.place = tr.to;
      if (tr.to.besuch) {
        r.ort = 'freizeit';
        this.schedule(r, now + this.hodMs(this.rng.range(0.6, 2)), 'home');
      } else {
        this.schedule(r, now + 200, 'home');
      }
    }
  }

  show(r, msg, ctx) {
    this.visible.set(r.id, msg);
    this.emit(msg);
    if (this.rng.chance(0.3)) {
      const k = this.pickEmote(r, ctx);
      if (k) this.showEmote(r, k, this.rng.range(3500, 6500));
    }
  }

  hide(r) {
    if (this.visible.delete(r.id)) this.emit({ e: 'h', id: r.id });
  }

  showEmote(r, k, d) {
    r.emo = { k, until: this.simMs + d * this.cfg.zeitraffer };
    this.emit({ e: 'm', id: r.id, k, d: Math.round(d) });
  }

  buildingEmote(b, k, d) {
    this.emit({ e: 'bm', id: b.id, k, d: Math.round(d) });
  }

  // Zwei Alleinstehende treffen sich im Park und verlieben sich vielleicht.
  parkEncounter(r) {
    if (r.partner || this.phase(r) === 'rente') return;
    for (const id of this.visible.keys()) {
      if (id === r.id) continue;
      const o = this.residents.get(id);
      if (!o || o.partner || !o.trip || o.trip.to.kind !== 'park') continue;
      const leg = o.trip.legs[o.trip.i];
      if (!leg || leg.k !== 'idle') continue;
      if (Math.hypot(leg.x - r.trip.to.x, leg.z - r.trip.to.z) > 6) continue;
      if (this.rng.chance(0.15)) {
        r.partner = o.id;
        o.partner = r.id;
        this.showEmote(r, 'verliebt', 7000);
        this.showEmote(o, 'verliebt', 7000);
      }
      return;
    }
  }

  // ======================================================================= Emotionen
  pickEmote(r, ctx) {
    const now = this.simMs;
    const w = this.weather;
    const g = r.glueck;
    const items = [];
    const phase = this.phase(r);
    if (r.partner) items.push(['verliebt', g > 55 ? 3 : 1]);
    if (r.trauer && now - r.trauer < 2 * DAY) items.push(['liebeskummer', 5]);
    if (!r.job && phase !== 'rente') items.push(['enttaeuscht', 3], ['fragend', 2]);
    if (g < 45) items.push(['enttaeuscht', 2], ['abweisend', 2]);
    if (g < 32) items.push(['boese', 3]);
    if (g > 60) items.push(['freuen', 3]);
    if (g > 68 && (ctx === 'walk' || ctx === 'park')) items.push(['singen', 3]);
    if (g > 72 && r.job) items.push(['sorglos', 2]);
    if (ctx === 'car' && r.trip?.stau) items.push(['boese', 7]);
    if (ctx === 'wait') items.push(['fragend', 1]);
    if (w.temp > 25) items.push(['schwitzend', 4]);
    if (ctx === 'walk' && r.trip?.legs?.[r.trip.i]?.len > 25) items.push(['schwitzend', 2]);
    if (ctx === 'work') items.push(['schwitzend', 1], ['freuen', 1]);
    if (r.umzug && now - r.umzug < 2 * DAY) items.push(['entsetzt', 5], ['boese', 2]);
    const home = this.buildings.get(r.home);
    const aqi = home ? this.aqiAt(this.world.plots[home.plot].front) : 80;
    if (aqi < 45) items.push(['benommen', 3], ['entsetzt', 1]);
    const h = this.hod();
    if (r.schicht === 'nacht' && h > 5 && h < 9) items.push(['benommen', 2], ['schlafend', 2]);
    if (ctx === 'home' && (h >= 21.5 || h < 5.5)) items.push(['schlafend', 8]);
    if (now - r.geb < 0.3 * DAY) items.push(['fragend', 3]);
    if (phase === 'rente') items.push(['benommen', 0.5], ['sorglos', 1]);
    if ((w.typ === 'regen' || w.typ === 'gewitter') && ctx === 'walk') items.push(['abweisend', 2]);
    items.push(['freuen', 0.5]);
    return this.rng.weighted(items);
  }

  randomEmotes(dtSim) {
    // Raten in Echtzeit, damit auch im Zeitraffer nicht zu viele Blasen gleichzeitig erscheinen
    const sec = dtSim / 1000 / this.cfg.zeitraffer;
    this.emoteAcc += this.visible.size * sec * 0.035;
    let n = Math.min(10, Math.floor(this.emoteAcc));
    this.emoteAcc -= Math.floor(this.emoteAcc);
    if (n > 0 && this.visible.size) {
      const ids = [...this.visible.keys()];
      while (n-- > 0) {
        const r = this.residents.get(this.rng.pick(ids));
        if (!r || (r.emo && r.emo.until > this.simMs)) continue;
        const msg = this.visible.get(r.id);
        const ctx = msg.k === 'c' ? 'car' : msg.k === 'w' ? 'walk' : r.trip?.to?.kind === 'park' ? 'park' : 'wait';
        const k = this.pickEmote(r, ctx);
        if (k) this.showEmote(r, k, this.rng.range(3500, 6000));
      }
    }
    // Gedanken über Gebäuden (Schlafende, Arbeitende)
    this.buildingEmoteAcc += sec * 0.3 * Math.min(3, 1 + this.buildings.size / 60);
    let m = Math.min(8, Math.floor(this.buildingEmoteAcc));
    this.buildingEmoteAcc -= Math.floor(this.buildingEmoteAcc);
    if (m <= 0 || this.buildings.size === 0) return;
    const all = [...this.buildings.values()];
    const h = this.hod();
    const night = h >= 21.5 || h < 5.5;
    while (m-- > 0) {
      const b = this.rng.pick(all);
      if (b.kind === 'wohnen') {
        const atHome = b.bewohner.map((id) => this.residents.get(id)).filter((r) => r && r.ort === 'home');
        if (!atHome.length) continue;
        const k = night ? 'schlafend' : this.pickEmote(this.rng.pick(atHome), 'home');
        if (k) this.buildingEmote(b, k, this.rng.range(4000, 7000));
      } else if (b.anwesend > 0) {
        const present = b.arbeiter.map((id) => this.residents.get(id)).filter((r) => r && r.atWork);
        if (!present.length) continue;
        const k = this.pickEmote(this.rng.pick(present), 'work');
        if (k) this.buildingEmote(b, k, this.rng.range(4000, 7000));
      }
    }
  }

  // ======================================================================= Umwelt
  cellOf(k) {
    const s = this.world.size;
    return Math.floor(Math.floor(k / s) / 5) * this.cells + Math.floor((k % s) / 5);
  }

  addPollution(k, kg) {
    this.pollution[this.cellOf(k)] += kg;
    this.emissionWindow += kg;
    this.dayAcc.emissionKg += kg;
  }

  aqiAt(k) {
    if (k < 0) return 100;
    return 100 * Math.exp(-this.pollution[this.cellOf(k)] / P0);
  }

  environment(dtSim) {
    const dtH = dtSim / HOUR;
    if (dtH <= 0) return;
    // Industrie und Heizungen
    const heat = clamp((18 - this.weather.temp) / 10, 0.15, 2.5);
    for (const b of this.buildings.values()) {
      const front = this.world.plots[b.plot].front;
      if (b.kind === 'industrie') {
        if (b.arbeiter.length) this.addPollution(front, (2 + 1.2 * b.anwesend) * dtH);
      } else {
        let home = 0;
        for (const id of b.bewohner) if (this.residents.get(id)?.ort === 'home') home++;
        if (home) this.addPollution(front, home * 0.08 * heat * dtH);
      }
    }
    // Ausbreitung und Abbau (Wind und Regen reinigen die Luft)
    const wet = ['regen', 'gewitter', 'schnee', 'niesel'].includes(this.weather.typ) ? 0.5 : 0;
    const lambda = 0.25 + 0.035 * (this.weather.wind || 0) + wet;
    const decay = Math.exp(-lambda * dtH);
    const n = this.cells;
    const P = this.pollution;
    const next = new Float32Array(P.length);
    const a = clamp(dtH * 2, 0, 0.18);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const v = P[c];
        let sum = 0;
        sum += i > 0 ? P[c - 1] : 0;
        sum += i < n - 1 ? P[c + 1] : 0;
        sum += j > 0 ? P[c - n] : 0;
        sum += j < n - 1 ? P[c + n] : 0;
        next[c] = (v * (1 - 4 * a) + a * sum) * decay;
      }
    }
    this.pollution = next;
    // Emissionsrate (kg/h) gleitend mitteln
    const rate = this.emissionWindow / dtH;
    const k = clamp(dtH, 0.002, 1);
    this.emissionRate += (rate - this.emissionRate) * k;
    this.emissionWindow = 0;
  }

  airQuality() {
    let sum = 0;
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.kind !== 'wohnen' || !b.bewohner.length) continue;
      sum += this.aqiAt(this.world.plots[b.plot].front) * b.bewohner.length;
      n += b.bewohner.length;
    }
    const index = n ? sum / n : 100;
    const text = index >= 80 ? 'sehr gut' : index >= 60 ? 'gut' : index >= 40 ? 'mäßig' : index >= 20 ? 'schlecht' : 'sehr schlecht';
    return { index: Math.round(index), text };
  }

  // ======================================================================= Stündlich
  onCycleHour(t) {
    const h = Math.round(this.hod(t));
    for (const r of this.residents.values()) this.updateHappiness(r);
    // Ruhestand und Arbeitssuche
    for (const r of this.residents.values()) {
      const phase = this.phase(r);
      if (phase === 'rente' && r.job) {
        this.quitJob(r);
        r.beruf = r.w ? 'Rentnerin' : 'Rentner';
        if (this.visible.has(r.id)) this.showEmote(r, 'sorglos', 5000);
      } else if (phase !== 'rente' && !r.job && r.home) {
        this.findJob(r);
      }
    }
    if (h === 12) this.jobSwitching();
    if (h === 0) {
      // neuer Tageszyklus: Pendlerzahlen merken
      this.odPrev = this.odCar;
      this.odCar = DISTRICTS.map(() => DISTRICTS.map(() => 0));
      for (const k of Object.keys(this.modeEma)) this.modeEma[k] *= 0.5;
    }
    if (h === 3) this.planTramLines();
  }

  updateHappiness(r) {
    const now = this.simMs;
    const w = this.weather;
    let h = 55;
    const phase = this.phase(r);
    if (phase === 'rente') h += 8;
    else if (r.job) h += phase === 'azubi' ? 8 : 12;
    else h -= 18;
    if (r.pendel > 0) h -= clamp((r.pendel - 60) / 8, 0, 18);
    if (r.stau && now - r.stau < this.cycleMs) h -= 8;
    const home = this.buildings.get(r.home);
    if (home) {
      const plot = this.world.plots[home.plot];
      h -= (100 - this.aqiAt(plot.front)) * 0.25;
      h += [0, 6, 2, -1][home.level];
      if (plot.dist < 12) h += 4; // Park in der Nähe
      if (this.transit.stations.some((st) => Math.abs(st.x - plot.x) + Math.abs(st.z - plot.z) < 10)) h += 3;
    }
    if ((w.typ === 'klar' || w.typ === 'heiter') && w.temp >= 12 && w.temp <= 26) h += 6;
    if (w.typ === 'regen' || w.typ === 'gewitter') h -= 4;
    if (w.temp > 28) h -= 6;
    if (w.temp < -5) h -= 4;
    if (r.partner) h += 10;
    if (r.umzug) h -= 20 * Math.exp(-(now - r.umzug) / (2 * DAY));
    if (r.trauer) h -= 15 * Math.exp(-(now - r.trauer) / (3 * DAY));
    h = clamp(h, 0, 100);
    r.glueck = clamp(r.glueck + (h - r.glueck) * 0.35, 0, 100);
  }

  // Wer lange mit dem Auto pendelt, sucht sich manchmal Arbeit in der Nähe.
  jobSwitching() {
    for (const r of this.residents.values()) {
      if (!r.job || r.modus !== 'auto' || r.pendel < 40 || !this.rng.chance(0.12)) continue;
      const home = this.buildings.get(r.home);
      if (!home) continue;
      const hp = this.world.plots[home.plot];
      let best = null;
      for (const b of this.buildings.values()) {
        if (b.kind !== 'industrie' || b.id === r.job || b.arbeiter.length >= b.jobs) continue;
        const p = this.world.plots[b.plot];
        const d = this.world.blocksBetween(hp.x, hp.z, p.x, p.z);
        if (d <= this.cfg.zuFussBloecke && (!best || d < best.d)) best = { b, d };
      }
      if (best) {
        const wasAtWork = r.atWork;
        if (wasAtWork) {
          // Wechsel erst wirksam, wenn die Schicht vorbei ist
          continue;
        }
        this.takeJob(r, best.b);
      }
    }
  }

  // ======================================================================= Straßenbahn
  planTramLines() {
    const trams = this.transit.lines.filter((l) => l.kind === 'tram').length;
    if (trams >= this.cfg.maxTramLinien) return;
    let bestPair = null;
    for (const wd of RES_DISTRICTS) {
      for (const id of IND_DISTRICTS) {
        const n = this.odPrev[wd][id];
        const key = `${wd}-${id}`;
        if (n < this.cfg.tramSchwelle || (this.tramCooldown[key] || 0) > this.simMs) continue;
        if (!bestPair || n > bestPair.n) bestPair = { wd, id, n, key };
      }
    }
    if (!bestPair || (this.tramCooldown.alle || 0) > this.simMs) return;
    this.tramCooldown[bestPair.key] = this.simMs + 2 * DAY;
    this.tramCooldown.alle = this.simMs + 1.5 * DAY;
    // Schwerpunkte der Autopendler
    let hx = 0, hz = 0, wx = 0, wz = 0, n = 0;
    for (const r of this.residents.values()) {
      if (r.modus !== 'auto' || !r.job) continue;
      const home = this.buildings.get(r.home);
      const job = this.buildings.get(r.job);
      if (!home || !job || home.d !== bestPair.wd || job.d !== bestPair.id) continue;
      const hp = this.world.plots[home.plot];
      const jp = this.world.plots[job.plot];
      hx += hp.x; hz += hp.z; wx += jp.x; wz += jp.z; n++;
    }
    if (n < 3) return;
    hx /= n; hz /= n; wx /= n; wz /= n;
    // Schon gut angebunden?
    for (const line of this.transit.lines) {
      const near = (x, z) => line.stations.some((sid) => {
        const st = this.transit.stations[sid];
        return Math.abs(st.x - x) + Math.abs(st.z - z) < 10;
      });
      if (near(hx, hz) && near(wx, wz)) return;
    }
    const a = this.tramEndTile(hx, hz, bestPair.wd);
    const b = this.tramEndTile(wx, wz, bestPair.id);
    if (a < 0 || b < 0 || a === b) return;
    const cost = (plot) => {
      if (plot.buildingId === null) return plot.blocked ? 0.2 : 0.3;
      const bd = this.buildings.get(plot.buildingId);
      return 5 + (bd ? bd.bewohner.length * 0.25 + bd.arbeiter.length * 0.15 : 0);
    };
    const tiles = this.transit.planTramPath(a, b, cost);
    if (!tiles || tiles.length < 6) return;
    // Grundstücke auf der Strecke räumen
    const plots = new Set();
    for (const k of tiles) if (this.world.plotOf[k] >= 0) plots.add(this.world.plotOf[k]);
    let demolished = 0;
    let moved = 0;
    let leftCity = 0;
    const displaced = [];
    for (const pid of plots) {
      const plot = this.world.plots[pid];
      plot.blocked = true;
      if (plot.buildingId !== null) {
        const bd = this.buildings.get(plot.buildingId);
        if (bd) {
          displaced.push(...this.demolish(bd));
          demolished++;
        }
      }
    }
    this.world.version++;
    const line = this.transit.buildTram(tiles, DISTRICTS[bestPair.wd].name, DISTRICTS[bestPair.id].name, this.simMs);
    // In Kurven berühren die Gleise auch Nachbargrundstücke
    for (const k of line.railTiles) {
      const pid = this.world.plotOf[k];
      if (pid < 0 || plots.has(pid)) continue;
      const plot = this.world.plots[pid];
      plot.blocked = true;
      if (plot.buildingId !== null) {
        const bd = this.buildings.get(plot.buildingId);
        if (bd) {
          displaced.push(...this.demolish(bd));
          demolished++;
        }
      }
    }
    // Verdrängte Einwohner ziehen in andere Häuser und Hochhäuser
    for (const r of displaced) {
      r.umzug = this.simMs;
      if (this.placeResident(r, bestPair.wd)) {
        moved++;
        if (!r.trip) {
          r.place = null;
          if (r.ort === 'home') this.planFromHome(r);
        }
      } else {
        this.removeResident(r, 'wegzug');
        leftCity++;
      }
    }
    this.world.updateRoads();
    this.world.version++;
    this.emit({ e: 'roads', roads: this.world.roadString() });
    this.emit({
      e: 'line', lines: this.transit.clientLines(), stations: this.transit.clientStations(),
      plots: this.world.plots.filter((p) => p.blocked).map((p) => p.id),
    });
    const text = `Neue Straßenbahn ${line.name}: ${tiles.length} Gleiskacheln, ${demolished} Gebäude abgerissen, `
      + `${moved} Einwohner umgezogen${leftCity ? `, ${leftCity} weggezogen` : ''}.`;
    this.news.push({ t: this.simMs, text });
    this.emit({ e: 'news', text });
    this.log.log(`[sim] ${text}`);
  }

  tramEndTile(x, z, district) {
    const w = this.world;
    let best = -1;
    let bestScore = Infinity;
    for (const p of w.plots) {
      if (p.district !== district) continue;
      const d0 = Math.abs(p.x - x) + Math.abs(p.z - z);
      if (d0 > 14) continue;
      for (const k of p.tiles) {
        if (w.rail[k] || w.station[k] >= 0) continue;
        const d = Math.abs(w.tileX(k) - x) + Math.abs(w.tileZ(k) - z);
        let score = d;
        if (p.buildingId !== null) {
          const b = this.buildings.get(p.buildingId);
          score += 3 + (b ? b.bewohner.length / 4 : 0);
        }
        if (score < bestScore) { bestScore = score; best = k; }
      }
    }
    return best;
  }

  demolish(b) {
    const displaced = [];
    for (const id of b.bewohner) {
      const r = this.residents.get(id);
      if (!r) continue;
      r.home = null;
      displaced.push(r);
    }
    b.bewohner = [];
    for (const id of [...b.arbeiter]) {
      const r = this.residents.get(id);
      if (!r) continue;
      this.quitJob(r);
      r.umzug = r.umzug || this.simMs;
    }
    const plot = this.world.plots[b.plot];
    plot.buildingId = null;
    this.buildings.delete(b.id);
    this.emit({ e: 'bx', id: b.id });
    // Arbeitslose suchen später neu
    return displaced;
  }

  // ======================================================================= Historie
  onHour(t) {
    const st = this.computeStats();
    const sample = {
      t, einwohner: st.einwohner, zufriedenheit: st.zufriedenheit, luft: st.luft.index,
      emission: Math.round(st.emission.kgH), arbeitslose: st.arbeitslose, unterwegs: st.unterwegs,
    };
    this.history.stunden.push(sample);
    if (this.history.stunden.length > 24 * 7) this.history.stunden.shift();
    const acc = this.dayAcc;
    acc.glueck += st.zufriedenheit;
    acc.luft += st.luft.index;
    acc.arbeitslose += st.arbeitslose;
    acc.samples++;
    this.emit({ e: 'hist', stunde: sample });
    if (t % DAY === 0) this.closeDay(t, st);
  }

  closeDay(t, st) {
    const acc = this.dayAcc;
    const n = Math.max(1, acc.samples);
    const trips = Math.max(1, acc.fuss + acc.auto + acc.bahn);
    const lv = st.bebauung.wohngebaeude;
    const day = {
      tag: Math.round(t / DAY),
      datum: new Date().toISOString().slice(0, 10),
      jahr: Math.floor((t - 1) / this.cfg.jahrMs) + 1,
      einwohner: st.einwohner,
      zufriedenheit: Math.round(acc.glueck / n),
      luft: Math.round(acc.luft / n),
      emission_t: Math.round(acc.emissionKg / 100) / 10,
      arbeitslose: Math.round(acc.arbeitslose / n),
      zuzuege: acc.zuzuege || 0,
      tode: acc.tode || 0,
      haeuser: lv[0], mehrfamilienhaeuser: lv[1], hochhaeuser: lv[2],
      fabriken: st.bebauung.industrie,
      bebauung: st.bebauung.prozent,
      tramlinien: this.transit.lines.filter((l) => l.kind === 'tram').length,
      fuss: Math.round((acc.fuss / trips) * 100),
      auto: Math.round((acc.auto / trips) * 100),
      bahn: Math.round((acc.bahn / trips) * 100),
    };
    this.history.tage.push(day);
    while (this.history.tage.length > this.cfg.historieTage) this.history.tage.shift();
    this.dayAcc = this.newDayAcc();
    this.emit({ e: 'hist', tag: day });
  }

  // ======================================================================= Statistik
  computeStats() {
    let arbeit = 0, zuhause = 0, unterwegs = 0, arbeitslose = 0, rentner = 0, azubis = 0, glueck = 0;
    const alter = [0, 0, 0, 0, 0];
    for (const r of this.residents.values()) {
      if (r.ort === 'work') arbeit++;
      else if (r.ort === 'home') zuhause++;
      else unterwegs++;
      const ph = this.phase(r);
      if (ph === 'rente') rentner++;
      else if (!r.job) arbeitslose++;
      else if (ph === 'azubi') azubis++;
      glueck += r.glueck;
      alter[Math.min(4, Math.floor(this.ageDays(r) / 10))]++;
    }
    const lv = [0, 0, 0];
    let industrie = 0, kapazitaet = 0, jobs = 0;
    for (const b of this.buildings.values()) {
      if (b.kind === 'wohnen') {
        lv[b.level - 1]++;
        kapazitaet += CAP[b.level];
      } else {
        industrie++;
        jobs += b.jobs;
      }
    }
    const plotsTotal = this.world.plots.length;
    const used = this.world.plots.filter((p) => p.buildingId !== null).length;
    const pop = this.residents.size;
    const modes = this.modeEma;
    const msum = Math.max(1e-6, modes.fuss + modes.auto + modes.bahn);
    let autos = 0;
    for (const m of this.visible.values()) if (m.k === 'c') autos++;
    const wohnBloecke = lv[0] + lv[1] + lv[2];
    return {
      einwohner: pop,
      arbeit,
      zuhause,
      unterwegs,
      arbeitslose,
      rentner,
      azubis,
      zufriedenheit: pop ? Math.round(glueck / pop) : 0,
      alter,
      luft: this.airQuality(),
      emission: { kgH: Math.round(this.emissionRate), heuteT: Math.round(this.dayAcc.emissionKg / 100) / 10 },
      bebauung: {
        prozent: Math.round((used / plotsTotal) * 100),
        wohngebaeude: lv,
        industrie,
        dichte: wohnBloecke ? Math.round((pop / wohnBloecke) * 10) / 10 : 0,
      },
      verkehr: {
        fuss: Math.round((modes.fuss / msum) * 100),
        auto: Math.round((modes.auto / msum) * 100),
        bahn: Math.round((modes.bahn / msum) * 100),
        autosAktiv: autos,
        linien: this.transit.lines.filter((l) => l.kind === 'tram').length,
      },
      kapazitaet: { wohnen: kapazitaet, jobs },
      zuzug: this.zuzug,
      leistung: {
        cpu: Math.round(this.perf.cpu * 10) / 10,
        limit: this.cfg.cpuLimitProzent,
        maxEinwohner: Math.round(this.perf.limitEinwohner),
        gedrosselt: this.perf.gedrosselt,
      },
      zeit: this.clockInfo(),
      wetter: this.weather,
    };
  }

  // ======================================================================= Client
  clientBuilding(b) {
    const p = this.world.plots[b.plot];
    return { id: b.id, k: b.kind === 'wohnen' ? 'w' : 'i', p: b.plot, l: b.level, m: b.model, r: r2(p.rot) };
  }

  clientInit() {
    return {
      name: this.cfg.stadtName,
      gegruendet: this.founded,
      cfg: {
        zeitraffer: this.cfg.zeitraffer, cycleMs: this.cycleMs, jahrMs: this.cfg.jahrMs, dayMs: DAY,
        clientLimit: this.cfg.clientLimitProzent, clientMaxFps: this.cfg.clientMaxFps,
        historieTage: this.cfg.historieTage,
      },
      clock: { sim: this.simMs, real: Date.now() },
      world: this.world.serialize(),
      districts: DISTRICTS,
      buildings: [...this.buildings.values()].map((b) => this.clientBuilding(b)),
      stations: this.transit.clientStations(),
      lines: this.transit.clientLines(),
      agents: [...this.visible.values()],
      models: { char: CHAR_MODELS, car: CAR_MODELS },
      emotes: Object.fromEntries(Object.entries(EMOTES).map(([k, v]) => [k, v.sym])),
      stats: this.computeStats(),
      history: this.history,
      news: this.news.slice(-5),
    };
  }

  // Detailinfos für Klicks im Browser
  info(typ, id) {
    if (typ === 'gebaeude') return this.buildingInfo(this.buildings.get(id));
    if (typ === 'person') return this.personInfo(this.residents.get(id));
    if (typ === 'fahrzeug') {
      const [lineId, k] = String(id).split(':').map(Number);
      const line = this.transit.lines.find((l) => l.id === lineId);
      if (!line) return null;
      const pass = [...(this.transit.passengers.get(`${lineId}:${k}`) || [])]
        .map((rid) => this.residents.get(rid)).filter(Boolean);
      return {
        typ: 'fahrzeug', titel: line.kind === 'ring' ? 'Ringbahn' : 'Straßenbahn', linie: line.name,
        fahrzeug: k + 1, fahrzeuge: line.vehicles, fahrgaeste: pass.length, kapazitaet: line.capacity,
        haltestellen: line.stations.map((sid) => this.transit.stations[sid].name),
        personen: pass.slice(0, 12).map((r) => this.personShort(r)),
      };
    }
    if (typ === 'station') {
      const st = this.transit.stations[id];
      if (!st) return null;
      let wartend = 0;
      for (const m of this.visible.values()) {
        if (m.k === 'i' && Math.hypot(m.p[0] - st.px, m.p[1] - st.pz) < 0.8) wartend++;
      }
      return {
        typ: 'station', titel: st.name, art: st.kind === 'ring' ? 'Bahnhof (Ringbahn)' : 'Straßenbahn-Haltestelle',
        linien: (st.lines || []).map((lid) => this.transit.lines.find((l) => l.id === lid)?.name).filter(Boolean),
        wartend,
      };
    }
    return null;
  }

  personShort(r) {
    return {
      id: r.id, name: `${r.vn} ${r.nn}`, alter: Math.floor(this.ageDays(r)), beruf: this.berufText(r),
      glueck: Math.round(r.glueck), ort: r.ort,
      gedanke: r.emo && r.emo.until > this.simMs ? r.emo.k : null,
    };
  }

  berufText(r) {
    const ph = this.phase(r);
    if (ph === 'rente') return r.w ? 'Rentnerin' : 'Rentner';
    if (!r.job) return r.w ? 'Arbeitssuchende' : 'Arbeitssuchender';
    if (ph === 'azubi') return `${r.w ? 'Auszubildende' : 'Auszubildender'} (${r.beruf})`;
    return r.beruf;
  }

  buildingInfo(b) {
    if (!b) return null;
    const p = this.world.plots[b.plot];
    const base = {
      typ: 'gebaeude', id: b.id, viertel: DISTRICTS[b.d].name, adresse: b.adresse,
      luft: Math.round(this.aqiAt(p.front)),
    };
    if (b.kind === 'wohnen') {
      const res = b.bewohner.map((id) => this.residents.get(id)).filter(Boolean);
      const working = res.filter((r) => r.job && this.phase(r) !== 'rente');
      return {
        ...base, titel: LEVEL_NAME[b.level], art: 'Wohngebäude', stufe: b.level,
        einwohner: res.length, kapazitaet: CAP[b.level], arbeiter: working.length,
        zuhause: res.filter((r) => r.ort === 'home').length,
        glueck: res.length ? Math.round(res.reduce((s, r) => s + r.glueck, 0) / res.length) : null,
        personen: res.slice(0, 20).map((r) => this.personShort(r)),
      };
    }
    const workers = b.arbeiter.map((id) => this.residents.get(id)).filter(Boolean);
    return {
      ...base, titel: b.name, art: `Industrie (${b.branche})`, branche: b.branche,
      arbeiter: workers.length, jobs: b.jobs, anwesend: b.anwesend,
      emission: Math.round(2 + 1.2 * b.anwesend),
      glueck: workers.length ? Math.round(workers.reduce((s, r) => s + r.glueck, 0) / workers.length) : null,
      personen: workers.slice(0, 20).map((r) => this.personShort(r)),
    };
  }

  personInfo(r) {
    if (!r) return null;
    const home = this.buildings.get(r.home);
    const job = this.buildings.get(r.job);
    const partner = r.partner ? this.residents.get(r.partner) : null;
    const trip = r.trip;
    let taetigkeit = { home: 'Zuhause', work: 'Bei der Arbeit', freizeit: 'Zu Besuch', unterwegs: 'Unterwegs' }[r.ort];
    if (trip) {
      const leg = trip.legs[trip.i];
      const ziel = { work: 'zur Arbeit', home: 'nach Hause', leisure: 'in der Freizeit' }[trip.purpose];
      const wie = { walk: 'zu Fuß', car: 'mit dem Auto', wait: 'wartet auf die Bahn', ride: 'in der Bahn', idle: trip.to.kind === 'park' ? 'im Park' : 'bummelt' }[leg?.k] || '';
      taetigkeit = `${wie} ${leg?.k === 'idle' ? '' : ziel}`.trim();
    }
    return {
      typ: 'person', id: r.id, titel: `${r.vn} ${r.nn}`, weiblich: r.w,
      alter: Math.floor(this.ageDays(r) * 10) / 10,
      lebensphase: { azubi: 'Ausbildung', arbeit: 'Berufsleben', rente: 'Ruhestand' }[this.phase(r)],
      beruf: this.berufText(r),
      arbeitgeber: job ? `${job.name} (${DISTRICTS[job.d].name})` : null,
      wohnort: home ? `${LEVEL_NAME[home.level]}, ${home.adresse} (${DISTRICTS[home.d].name})` : null,
      glueck: Math.round(r.glueck),
      gedanke: r.emo && r.emo.until > this.simMs ? r.emo.k : null,
      taetigkeit,
      verkehrsmittel: (job && this.phase(r) !== 'rente' && { fuss: 'zu Fuß', auto: 'Auto', bahn: 'Bahn' }[r.modus]) || '–',
      pendelzeit: r.pendel ? Math.round(r.pendel) : null,
      partner: partner ? `${partner.vn} ${partner.nn}` : null,
      schicht: r.schicht === 'nacht' ? 'Nachtschicht' : 'Tagschicht',
    };
  }

  // ======================================================================= Speichern
  serialize() {
    return {
      version: STATE_VERSION,
      seed: this.seed,
      rng: this.rng.state,
      blocks: this.blocks,
      founded: this.founded,
      simMs: this.simMs,
      nextRid: this.nextRid,
      nextBid: this.nextBid,
      roads: this.world.roadString(),
      blocked: this.world.plots.filter((p) => p.blocked).map((p) => p.id),
      transit: this.transit.serialize(),
      buildings: [...this.buildings.values()].map((b) => ({ ...b, anwesend: 0 })),
      residents: [...this.residents.values()].map((r) => {
        const { trip, place, atWork, seq, nextAt, nextA, ...rest } = r;
        void trip; void place; void atWork; void seq; void nextAt; void nextA;
        return rest;
      }),
      pollution: Array.from(this.pollution, (v) => Math.round(v * 10) / 10),
      odCar: this.odCar,
      odPrev: this.odPrev,
      tramCooldown: this.tramCooldown,
      history: this.history,
      dayAcc: this.dayAcc,
      modeEma: this.modeEma,
      immigrationAcc: this.immigrationAcc,
      emissionRate: this.emissionRate,
      news: this.news.slice(-20),
    };
  }

  restore(s) {
    this.seed = s.seed;
    this.rng = new Rng(1);
    this.rng.state = s.rng;
    this.blocks = s.blocks;
    if (s.blocks !== this.cfg.stadtBloecke) {
      this.log.warn(`[sim] STADT_BLOECKE=${this.cfg.stadtBloecke} ignoriert – gespeicherte Stadt hat ${s.blocks} Blöcke`);
    }
    this.world = new World(s.blocks, new Rng(this.seed));
    this.simMs = s.simMs;
    this.founded = s.founded;
    this.nextRid = s.nextRid;
    this.nextBid = s.nextBid;
    for (let k = 0; k < s.roads.length; k++) this.world.roadActive[k] = s.roads.charCodeAt(k) === 49 ? 1 : 0;
    for (const id of s.blocked) this.world.plots[id].blocked = true;
    this.transit = new Transit(this.world);
    this.transit.restore(s.transit);
    this.paths = new PathFinder(this.world);
    for (const b of s.buildings) {
      this.buildings.set(b.id, b);
      this.world.plots[b.plot].buildingId = b.id;
    }
    this.pollution = Float32Array.from(s.pollution);
    this.odCar = s.odCar;
    this.odPrev = s.odPrev;
    this.tramCooldown = s.tramCooldown || {};
    this.history = s.history;
    this.dayAcc = s.dayAcc;
    this.modeEma = s.modeEma;
    this.immigrationAcc = s.immigrationAcc;
    this.emissionRate = s.emissionRate;
    this.news = s.news || [];
    this.world.version++;
    this.initRuntime();
    for (const raw of s.residents) {
      const r = { ...raw, seq: 0, trip: null, place: null, atWork: false };
      r.ort = 'home';
      this.residents.set(r.id, r);
    }
    // Wer gerade Schicht hat, ist nach dem Laden direkt bei der Arbeit.
    const h = this.hod();
    for (const r of this.residents.values()) {
      const job = r.job ? this.buildings.get(r.job) : null;
      const into = (((h - r.start) % 24) + 24) % 24;
      if (job && this.phase(r) !== 'rente' && into < 8) {
        r.ort = 'work';
        r.atWork = true;
        job.anwesend++;
        r.place = this.buildingPlace(job);
        this.schedule(r, this.simMs + this.hodMs(8 - into) + this.rng.range(0, 20_000), 'home');
      } else {
        this.planFromHome(r, this.simMs + this.rng.range(0, 30_000));
      }
    }
    this.world.updateRoads();
  }
}
