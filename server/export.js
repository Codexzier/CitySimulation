// Täglicher Export der Ergebnisse (JSON + SVG-Karte) für die GitHub-Seite.
import fs from 'node:fs';
import path from 'node:path';
import { DISTRICTS } from './sim/world.js';

const BUILD_COLORS = {
  w1: '#7cc47a', w2: '#5b9bd5', w3: '#2f5f9e', i: '#9a8f7e',
};

export function buildSvg(sim) {
  const w = sim.world;
  const s = w.size;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s * 10}" height="${s * 10}">`);
  out.push(`<title>${escapeXml(sim.cfg.stadtName)} – Tag ${sim.dayIndex() + 1}</title>`);
  out.push(`<rect width="${s}" height="${s}" fill="#a7d08c"/>`);
  // Viertel leicht einfärben
  for (const p of w.plots) {
    const typ = DISTRICTS[p.district].typ;
    out.push(`<rect x="${p.x + s / 2 - 1}" y="${p.z + s / 2 - 1}" width="2" height="2" fill="${typ === 'wohnen' ? '#b9dc9f' : '#c9c4b5'}"/>`);
  }
  for (const k of w.parkTiles) out.push(`<rect x="${k % s}" y="${Math.floor(k / s)}" width="1" height="1" fill="#6fb35f"/>`);
  // Straßen
  const roads = [];
  for (let k = 0; k < w.roadActive.length; k++) {
    if (w.roadActive[k]) roads.push(`M${k % s} ${Math.floor(k / s)}h1v1h-1z`);
  }
  if (roads.length) out.push(`<path d="${roads.join('')}" fill="#5d6470"/>`);
  // Gebäude
  for (const b of sim.buildings.values()) {
    const p = w.plots[b.plot];
    const key = b.kind === 'wohnen' ? `w${b.level}` : 'i';
    const size = b.kind === 'wohnen' ? [1.2, 1.35, 1.5][b.level - 1] : 1.6;
    const x = p.x + s / 2 - size / 2;
    const z = p.z + s / 2 - size / 2;
    out.push(`<rect x="${x.toFixed(2)}" y="${z.toFixed(2)}" width="${size}" height="${size}" rx="0.15" fill="${BUILD_COLORS[key]}"/>`);
  }
  // Gleise und Haltestellen
  for (const line of sim.transit.lines) {
    for (const tr of line.tracks) {
      const pts = [];
      for (let i = 0; i < tr.length; i += 2) pts.push(`${(tr[i] + s / 2).toFixed(2)},${(tr[i + 1] + s / 2).toFixed(2)}`);
      out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${line.color}" stroke-width="0.25"/>`);
    }
  }
  for (const st of sim.transit.stations) {
    out.push(`<circle cx="${(st.x + s / 2).toFixed(2)}" cy="${(st.z + s / 2).toFixed(2)}" r="0.55" fill="#fff" stroke="#222" stroke-width="0.15"/>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

function escapeXml(t) {
  return String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

export function writeExport(sim, baseDir) {
  const dir = path.join(baseDir, 'export');
  fs.mkdirSync(dir, { recursive: true });
  const stats = sim.computeStats();
  const aktuell = {
    stadt: sim.cfg.stadtName,
    aktualisiert: new Date().toISOString(),
    gegruendet: sim.founded,
    tag: stats.zeit.tag,
    jahr: stats.zeit.jahr,
    jahreszeit: stats.zeit.jahreszeit,
    einwohner: stats.einwohner,
    bei_der_arbeit: stats.arbeit,
    zuhause: stats.zuhause,
    unterwegs: stats.unterwegs,
    arbeitslose: stats.arbeitslose,
    rentner: stats.rentner,
    zufriedenheit: stats.zufriedenheit,
    luftqualitaet: stats.luft.index,
    luftqualitaet_text: stats.luft.text,
    emission_kg_h: stats.emission.kgH,
    altersstruktur_tage: { '0-9': stats.alter[0], '10-19': stats.alter[1], '20-29': stats.alter[2], '30-39': stats.alter[3], '40+': stats.alter[4] },
    gebaeude: {
      einfamilienhaeuser: stats.bebauung.wohngebaeude[0],
      mehrfamilienhaeuser: stats.bebauung.wohngebaeude[1],
      hochhaeuser: stats.bebauung.wohngebaeude[2],
      fabriken: stats.bebauung.industrie,
      bebauung_prozent: stats.bebauung.prozent,
      einwohner_je_gebaeude: stats.bebauung.dichte,
    },
    verkehr_prozent: { zu_fuss: stats.verkehr.fuss, auto: stats.verkehr.auto, bahn: stats.verkehr.bahn },
    strassenbahnlinien: sim.transit.lines.filter((l) => l.kind === 'tram').map((l) => l.name),
    wetter: {
      ort: stats.wetter.ort, temperatur: stats.wetter.temp, beschreibung: stats.wetter.text, quelle: stats.wetter.quelle,
    },
    leistung: stats.leistung,
  };
  const historie = {
    stadt: sim.cfg.stadtName,
    aktualisiert: aktuell.aktualisiert,
    tage: sim.history.tage,
  };
  const files = {
    'stadt_aktuell.json': JSON.stringify(aktuell, null, 1),
    'stadt_historie.json': JSON.stringify(historie, null, 1),
    'stadt_ereignisse.json': JSON.stringify({ aktualisiert: aktuell.aktualisiert, ereignisse: sim.news.slice(-50).reverse() }, null, 1),
    'stadt_karte.svg': buildSvg(sim),
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.writeFileSync(`${target}.tmp`, content);
    fs.renameSync(`${target}.tmp`, target);
  }
  return { dir, files: Object.keys(files) };
}

// Prüft jede Minute, ob die Exportzeit (lokale Uhrzeit) erreicht ist.
export function scheduleExport(sim, baseDir, time, log = console) {
  const [hh, mm] = time.split(':').map((x) => parseInt(x, 10));
  let lastDate = null;
  const timer = setInterval(() => {
    const now = new Date();
    const date = now.toDateString();
    if (now.getHours() === hh && now.getMinutes() === mm && lastDate !== date) {
      lastDate = date;
      try {
        const res = writeExport(sim, baseDir);
        log.log(`[export] ${res.files.length} Dateien nach ${res.dir} geschrieben`);
      } catch (err) {
        log.error('[export] fehlgeschlagen:', err);
      }
    }
  }, 30_000);
  timer.unref?.();
  return timer;
}

