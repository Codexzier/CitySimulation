// Startpunkt im Browser: lädt Modelle, verbindet sich mit dem Live-Datenstrom
// der Simulation und zeichnet die Stadt.
import * as THREE from 'three';
import { Assets } from './assets.js';
import { CityView } from './world.js';
import { AgentView } from './agents.js';
import { Environment } from './environment.js';
import { CameraRig } from './camera.js';
import { PerfGovernor } from './perf.js';
import { UI } from './ui.js';

const canvas = document.getElementById('szene');
const probe = new PerfGovernor({});
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !probe.weakDevice, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.5, 2000);

let initData = null;
let city = null;
let agents = null;
let env = null;
let perf = null;
const clock = { simAt: 0, perfAt: performance.now(), rate: 1 };
const simNow = () => clock.simAt + (performance.now() - clock.perfAt) * clock.rate;
let selection = null;
let infoTimer = null;
// ?tageszeit=12 hält die Beleuchtung auf einer festen Uhrzeit (z. B. für Bildschirmfotos)
const params = new URLSearchParams(location.search);
const fixedHod = params.has('tageszeit') ? Number(params.get('tageszeit')) : null;
// ?wetter=regen|schnee|nebel|klar zeigt ein bestimmtes Wetter (nur Darstellung)
const weatherOverride = params.has('wetter') ? { typ: params.get('wetter'), wolken: params.get('wetter') === 'klar' ? 5 : 90 } : null;

const ui = new UI({
  onInfoPerson: (id) => openInfo('person', id, true),
  onInfoBuilding: (id) => openInfo('gebaeude', id, true),
  onFollow: (id) => {
    if (!agents.positionOf(id)) {
      ui.news('Diese Person ist gerade in einem Gebäude oder in der Bahn – Folgen startet, sobald sie wieder sichtbar ist.', true);
    }
    rig.follow = id;
    rig.focus(...(agents.positionOf(id) || [rig.target.x, rig.target.z]).slice(0, 2), 10);
  },
  onOverview: () => {
    rig.userMoved = false;
    rig.overview(initData.world.size, camera.aspect, perf.cropped ? 0.55 : 1, true);
  },
  onQuality: (v) => perf.setManual(v === 'auto' ? 'auto' : Number(v)),
});
ui.onClose = () => {
  selection = null;
  rig.follow = null;
  clearInterval(infoTimer);
};

const rig = new CameraRig(camera, canvas, onClick);

// ------------------------------------------------------------------ Auswahlmarkierung
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.42, 0.52, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x3987e5, transparent: true, opacity: 0.9, depthWrite: false }),
);
marker.renderOrder = 30;
marker.visible = false;
scene.add(marker);

function selectionPosition() {
  if (!selection) return null;
  if (selection.typ === 'person') {
    const p = agents.positionOf(selection.id);
    return p ? { x: p[0], z: p[1], r: p[2] === 'c' ? 0.6 : 0.45 } : null;
  }
  if (selection.typ === 'gebaeude') {
    const e = city.buildings.get(selection.id);
    return e ? { x: e.plot.x, z: e.plot.z, r: 2 } : null;
  }
  if (selection.typ === 'fahrzeug') {
    const [line, k] = String(selection.id).split(':').map(Number);
    const t = agents.trainPositions.find((p) => p.line === line && p.k === k);
    return t ? { x: t.x, z: t.z, r: 1.1 } : null;
  }
  if (selection.typ === 'station') {
    const st = city.stations?.[selection.id];
    return st ? { x: st.px, z: st.pz, r: 1.3 } : null;
  }
  return null;
}

// ------------------------------------------------------------------ Klicks
function onClick(cx, cy) {
  if (!initData) return;
  const r = canvas.getBoundingClientRect();
  const hit = agents.pick(cx - r.left, cy - r.top, camera, r.width, r.height);
  if (hit) return openInfo(hit.typ, hit.id);
  const ray = rig.rayAt(cx, cy);
  const b = city.pickBuilding(ray);
  const st = city.pickStation(ray);
  if (st && (!b || st.dist < b.dist)) return openInfo('station', st.id);
  if (b) return openInfo('gebaeude', b.id);
  ui.closeInfo();
}

async function openInfo(typ, id, focus = false) {
  selection = { typ, id };
  clearInterval(infoTimer);
  const load = async () => {
    if (!selection || selection.typ !== typ || selection.id !== id) return;
    try {
      const res = await fetch(`api/info?typ=${encodeURIComponent(typ)}&id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        if (res.status === 404) ui.closeInfo();
        return;
      }
      const info = await res.json();
      if (selection && selection.typ === typ && selection.id === id) ui.showInfo(info);
    } catch { /* nächster Versuch */ }
  };
  await load();
  infoTimer = setInterval(load, 2500);
  if (focus) {
    const p = selectionPosition();
    if (p) rig.focus(p.x, p.z, typ === 'person' ? 10 : 18);
  }
}

// ------------------------------------------------------------------ Datenstrom
function sync(sim) {
  const err = sim - simNow();
  if (Math.abs(err) > 3000 * clock.rate) {
    clock.simAt = sim;
    clock.perfAt = performance.now();
  } else {
    clock.simAt += err * 0.1;
  }
}

function onInit(init) {
  const first = !initData;
  initData = init;
  clock.simAt = init.clock.sim;
  clock.perfAt = performance.now();
  clock.rate = init.cfg.zeitraffer;
  if (!perf) {
    perf = new PerfGovernor({ limitPercent: init.cfg.clientLimit, maxFps: init.cfg.clientMaxFps, onChange: applyQuality });
  }
  if (!env) env = new Environment(scene, renderer, assets);
  if (weatherOverride) env.setWeather(weatherOverride);
  if (!city) city = new CityView(scene, assets);
  city.build(init);
  env.setCity(init.world.size);
  if (!agents) agents = new AgentView(scene, assets, init);
  agents.reset(init);
  ui.setInit(init);
  env.air = init.stats.luft.index;
  rig.setBounds(init.world.size);
  if (first) rig.overview(init.world.size, camera.aspect);
  applyQuality(perf.settings, perf.level);
  ui.loading(null);
}

function onDelta(msg) {
  if (!initData) return;
  sync(msg.sim);
  const now = performance.now();
  for (const ev of msg.ev) {
    switch (ev.e) {
      case 'a': agents.upsert(ev); break;
      case 'h': agents.hide(ev.id); break;
      case 'm': agents.emote(ev.id, ev.k, ev.d, now); break;
      case 'bm': agents.buildingEmote(ev.id, ev.k, ev.d, now); break;
      case 'b': city.setBuilding(ev.b, true); break;
      case 'bx': city.removeBuilding(ev.id); break;
      case 'roads': city.setRoads(ev.roads); break;
      case 'line':
        city.setBlocked(ev.plots);
        city.setLines(ev.lines, ev.stations);
        agents.setLines(ev.lines);
        break;
      case 'news': ui.news(ev.text); break;
      case 'hist': ui.addHistory(ev); break;
      default: break;
    }
  }
}

function connect() {
  const es = new EventSource('events');
  es.addEventListener('init', (e) => onInit(JSON.parse(e.data)));
  es.addEventListener('d', (e) => onDelta(JSON.parse(e.data)));
  es.addEventListener('s', (e) => {
    const msg = JSON.parse(e.data);
    if (!initData) return;
    sync(msg.sim);
    ui.updateStats(msg.stats);
    env.air = msg.stats.luft.index;
  });
  es.addEventListener('w', (e) => {
    const w = JSON.parse(e.data);
    env?.setWeather({ ...w, ...weatherOverride });
    ui.updateWeather(w);
  });
  es.onopen = () => ui.connection(true);
  es.onerror = () => ui.connection(false);
}

// ------------------------------------------------------------------ Qualität
function applyQuality(settings, level, mode) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
  env?.setShadows(settings.shadows);
  city?.setShadows(settings.shadows);
  if (env?.precip) env.precipType = '__neu'; // Partikelzahl neu anlegen
  if (mode === 'ausschnitt' && initData && !rig.userMoved) {
    rig.overview(initData.world.size, camera.aspect, 0.55, true);
    ui.news('Leistungsgrenze erreicht: Statt der ganzen Stadt wird ein Ausschnitt gezeigt.');
  }
}

// ------------------------------------------------------------------ Darstellung
let lastFrame = performance.now();
let lastUi = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!initData || !perf.shouldRender(now)) return;
  const t0 = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const sim = simNow();
  const follow = rig.follow ? agents.positionOf(rig.follow) : null;
  rig.update(dt, follow);
  const settings = perf.settings;
  const height = canvas.clientHeight;
  const far = rig.distance > settings.farDist;
  agents.update(sim, now, camera, {
    far, dt, height, night: env.night > 0.3, emotes: !far || settings.emotesFar,
    buildingTop: (id) => city.buildingTop(id),
  });
  city.update(dt);
  env.update(sim, now, dt, {
    cycleMs: initData.cfg.cycleMs, center: rig.target, cameraDistance: rig.distance, camera, height,
    lamps: city.lamps, carFronts: agents.carFronts, factoryTops: city.factoryTops, quality: perf.level,
    snowUniform: city.snowUniform, fixedHod,
  });
  const sp = selectionPosition();
  marker.visible = !!sp;
  if (sp) {
    const pulse = 1 + Math.sin(now / 250) * 0.06;
    marker.position.set(sp.x, 0.05, sp.z);
    marker.scale.setScalar(sp.r * pulse);
  }
  renderer.render(scene, camera);
  perf.record(performance.now() - t0);
  if (now - lastUi > 1000) {
    lastUi = now;
    ui.perf(perf, settings, perf.level);
  }
}

// Für Tests im Headless-Browser
window.__screenOf = (x, z, y = 0.5) => {
  const v = new THREE.Vector3(x, y, z).project(camera);
  const r = canvas.getBoundingClientRect();
  return [Math.round((v.x * 0.5 + 0.5) * r.width + r.left), Math.round((-v.y * 0.5 + 0.5) * r.height + r.top)];
};
window.__someBuilding = (kind) => {
  for (const e of city.buildings.values()) if (e.b.k === kind) return [e.b.id, e.plot.x, e.plot.z];
  return null;
};
window.__debug = () => ({
  cam: camera.position.toArray().map((v) => +v.toFixed(2)), dist: rig.distance, calls: renderer.info.render.calls,
  tris: renderer.info.render.triangles, fps: perf?.fps, level: perf?.level, agents: agents?.agents.size,
  buildings: city?.buildings.size, children: scene.children.length,
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------------ Start
const assets = new Assets((done, total) => ui.loading(done, total));
try {
  await assets.load();
  ui.setEmotes(assets);
  ui.loading(1, 1, 'Verbinde mit der Simulation …');
  connect();
  requestAnimationFrame(frame);
} catch (err) {
  console.error(err);
  ui.loading(0, 1, `Fehler beim Laden: ${err.message}`);
}
