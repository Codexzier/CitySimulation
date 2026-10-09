// Einstiegspunkt: Webserver, Live-Datenstrom (Server-Sent Events), Simulationstakt,
// Leistungswächter, Speichern und täglicher Export.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Simulation } from './sim/simulation.js';
import { Weather } from './sim/weather.js';
import { writeExport, scheduleExport } from './export.js';
import { dropPrivileges } from './privileges.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_ROOTS = [path.join(root, 'client'), path.join(root, 'build')];
const STATE_FILE = path.join(config.datenVerzeichnis, 'stadt.json.gz');
const SAVE_INTERVAL = 5 * 60_000;

dropPrivileges(config.datenVerzeichnis, process.env.LAUFZEIT_BENUTZER);
fs.mkdirSync(config.datenVerzeichnis, { recursive: true });

// ------------------------------------------------------------------ Simulation laden
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE_FILE)).toString('utf8'));
  } catch (err) {
    console.error('[speichern] Spielstand konnte nicht gelesen werden:', err.message);
    try {
      fs.copyFileSync(STATE_FILE, `${STATE_FILE}.defekt-${Date.now()}`);
    } catch { /* egal */ }
    return null;
  }
}

function saveState() {
  const t0 = Date.now();
  const json = JSON.stringify(sim.serialize());
  const data = zlib.gzipSync(json, { level: 6 });
  fs.writeFileSync(`${STATE_FILE}.tmp`, data);
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  return { bytes: data.length, ms: Date.now() - t0 };
}

const sim = new Simulation(config);
sim.init(loadState());

const weather = new Weather(config);
weather.start((w) => {
  sim.weather = w;
  broadcast('w', w);
});

// ------------------------------------------------------------------ Live-Datenstrom
const clients = new Set();

function sseWrite(res, event, data) {
  if (res.writableLength > 4 * 1024 * 1024) {
    // Client zu langsam – lieber neu verbinden lassen
    res.end();
    clients.delete(res);
    return;
  }
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  if (!clients.size) return;
  const payload = JSON.stringify(data);
  for (const res of clients) sseWrite(res, event, payload);
}

// ------------------------------------------------------------------ Leistungswächter
// Misst die CPU-Zeit des Prozesses im Verhältnis zur gesamten Rechenleistung des
// Rechners. Wird die Grenze (Standard 30 %) erreicht, drosselt sich die Simulation
// und es ziehen keine weiteren Einwohner zu – so ergibt sich die maximale Stadtgröße.
const perf = {
  lastCpu: process.cpuUsage(),
  lastWall: process.hrtime.bigint(),
  ema: 0,
  tickMs: 500,
};

function measureCpu() {
  const cpu = process.cpuUsage(perf.lastCpu);
  const wall = process.hrtime.bigint();
  const wallUs = Number(wall - perf.lastWall) / 1000;
  perf.lastCpu = process.cpuUsage();
  perf.lastWall = wall;
  if (wallUs <= 0) return;
  const share = ((cpu.user + cpu.system) / wallUs / config.cpuKerne) * 100; // % der Gesamtleistung
  perf.ema += (share - perf.ema) * 0.1;
  const limit = config.cpuLimitProzent;
  const pop = sim.residents.size;
  sim.perf.cpu = perf.ema;
  sim.perf.gedrosselt = perf.ema > limit * 0.85;
  perf.tickMs = sim.perf.gedrosselt ? 1000 : 500;
  // geschätzte Einwohnerzahl, die noch in das Budget passt
  let est = config.maxEinwohner;
  if (pop >= 30 && perf.ema > 0.05) est = Math.min(config.maxEinwohner, (pop * (limit * 0.8)) / perf.ema);
  if (sim.perf.gedrosselt) est = Math.min(est, pop);
  sim.perf.limitEinwohner += (est - sim.perf.limitEinwohner) * 0.05;
  if (sim.perf.gedrosselt) sim.perf.limitEinwohner = Math.min(sim.perf.limitEinwohner, pop);
}

// ------------------------------------------------------------------ Takt
let lastTick = Date.now();
let lastStats = 0;
let lastSave = Date.now();
let lastHeartbeat = Date.now();

function tick() {
  const now = Date.now();
  let dtSim = Math.min(now - lastTick, 60_000) * config.zeitraffer;
  lastTick = now;
  try {
    // große Zeitsprünge in Teilschritten rechnen
    while (dtSim > 0) {
      const step = Math.min(dtSim, 30_000);
      sim.step(step);
      dtSim -= step;
    }
  } catch (err) {
    console.error('[sim] Fehler im Takt:', err);
  }
  if (sim.outbox.length) {
    const events = sim.outbox;
    sim.outbox = [];
    broadcast('d', { sim: Math.round(sim.simMs), real: now, ev: events });
    lastHeartbeat = now;
  }
  if (now - lastStats >= 2000) {
    lastStats = now;
    measureCpu();
    broadcast('s', { sim: Math.round(sim.simMs), real: now, stats: sim.computeStats() });
    lastHeartbeat = now;
  }
  if (now - lastHeartbeat > 15_000) {
    for (const res of clients) res.write(': ping\n\n');
    lastHeartbeat = now;
  }
  if (now - lastSave > SAVE_INTERVAL) {
    lastSave = now;
    try {
      saveState();
    } catch (err) {
      console.error('[speichern] Fehler:', err);
    }
  }
  setTimeout(tick, perf.tickMs).unref?.();
}
// Der Server hält den Prozess am Leben; der Takt darf ihn nicht blockieren.
setTimeout(tick, perf.tickMs);

scheduleExport(sim, config.datenVerzeichnis, config.exportZeit);

// ------------------------------------------------------------------ HTTP
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' };
  if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body, { level: 4 }));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  rel = path.normalize(rel).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) return false;
  for (const base of STATIC_ROOTS) {
    const file = path.join(base, rel);
    if (!file.startsWith(base)) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(file).toLowerCase();
    const isAsset = rel.startsWith('assets/') || rel.startsWith('vendor/');
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(stat.mtime.toUTCString())) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const gz = `${file}.gz`;
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(gz)) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      fs.createReadStream(gz).pipe(res);
      return true;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseWrite(res, 'init', sim.clientInit());
      sseWrite(res, 'w', sim.weather);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/info') {
      const typ = url.searchParams.get('typ');
      const raw = url.searchParams.get('id');
      const id = typ === 'fahrzeug' ? raw : Number(raw);
      const info = sim.info(typ, id);
      return sendJson(req, res, info ? 200 : 404, info || { fehler: 'nicht gefunden' });
    }
    if (p === '/api/status') {
      return sendJson(req, res, 200, {
        stadt: config.stadtName, einwohner: sim.residents.size, gebaeude: sim.buildings.size,
        tag: sim.dayIndex() + 1, clients: clients.size, cpuProzent: Math.round(perf.ema * 100) / 100,
        cpuLimitProzent: config.cpuLimitProzent, zeitraffer: config.zeitraffer, laufzeitS: Math.round(process.uptime()),
      });
    }
    if (p === '/api/statistik') {
      return sendJson(req, res, 200, { stats: sim.computeStats(), historie: sim.history });
    }
    if (p === '/api/export') {
      const result = writeExport(sim, config.datenVerzeichnis);
      return sendJson(req, res, 200, { ok: true, ...result });
    }
    if (p.startsWith('/export/')) {
      const name = path.basename(p);
      const file = path.join(config.datenVerzeichnis, 'export', name);
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    if (req.method === 'GET' && serveStatic(req, res, p)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Interner Fehler');
  }
});

server.listen(config.port, () => {
  console.log(`[http] ${config.stadtName} läuft auf http://localhost:${config.port}`
    + ` (CPU-Grenze ${config.cpuLimitProzent} % von ${config.cpuKerne} Kernen, Zeitraffer ${config.zeitraffer}x)`);
});

// ------------------------------------------------------------------ Beenden
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[sim] ${signal} empfangen – speichere Stadt …`);
  try {
    const r = saveState();
    console.log(`[speichern] ${(r.bytes / 1024).toFixed(0)} KB in ${r.ms} ms`);
  } catch (err) {
    console.error('[speichern] Fehler:', err);
  }
  weather.stop();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
