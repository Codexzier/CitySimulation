// Alle Einstellungen kommen aus Umgebungsvariablen (siehe docker-compose.yml).
import os from 'node:os';
import path from 'node:path';

const env = process.env;

function num(name, def, min = -Infinity, max = Infinity) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(v)) {
    console.warn(`[config] ${name}="${raw}" ist keine Zahl, verwende ${def}`);
    return def;
  }
  return Math.min(max, Math.max(min, v));
}

function str(name, def) {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? def : raw.trim();
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const config = {
  port: num('PORT', 8080, 1, 65535),
  stadtName: str('STADT_NAME', 'Neustadt'),
  datenVerzeichnis: path.resolve(str('DATEN_VERZEICHNIS', './data')),

  // Wetter: Ortsname (wird über Open-Meteo gesucht) oder feste Koordinaten.
  ort: str('ORT', 'Berlin'),
  breitengrad: env.BREITENGRAD ? num('BREITENGRAD', NaN, -90, 90) : NaN,
  laengengrad: env.LAENGENGRAD ? num('LAENGENGRAD', NaN, -180, 180) : NaN,
  wetterIntervallMs: num('WETTER_INTERVALL_MIN', 15, 5, 240) * 60_000,

  // Leistung: Anteil der gesamten CPU des Rechners (Raspberry Pi 4 = 4 Kerne).
  cpuLimitProzent: num('CPU_LIMIT_PROZENT', 30, 5, 100),
  clientLimitProzent: num('CLIENT_LIMIT_PROZENT', num('CPU_LIMIT_PROZENT', 30, 5, 100), 5, 100),
  clientMaxFps: num('CLIENT_MAX_FPS', 30, 5, 60),
  cpuKerne: os.cpus().length || 1,
  maxEinwohner: num('MAX_EINWOHNER', 5000, 20, 100000),

  // Stadt
  stadtBloecke: Math.round(num('STADT_BLOECKE', 10, 6, 16)),
  startEinwohner: Math.round(num('START_EINWOHNER', 8, 0, 200)),
  seed: env.SEED ? Math.round(num('SEED', 1, 1, 2 ** 31)) : null,

  // Zeit (alle Angaben in echter Zeit, ZEITRAFFER beschleunigt alles gleichmäßig)
  zeitraffer: num('ZEITRAFFER', 1, 0.1, 100000),
  tagNachtWechselMs: num('TAG_NACHT_WECHSEL_STUNDEN', 3, 0.05, 24) * HOUR,
  einwohnerProStunde: num('EINWOHNER_PRO_STUNDE', 1, 0, 1000),
  lebensdauerMinMs: num('LEBENSDAUER_MIN_TAGE', 30, 0.1, 10000) * DAY,
  lebensdauerMaxMs: num('LEBENSDAUER_MAX_TAGE', 50, 0.1, 10000) * DAY,
  jahrMs: num('JAHR_TAGE', 7, 0.1, 3650) * DAY,
  historieTage: Math.round(num('HISTORIE_TAGE', 300, 7, 3650)),

  // Verkehr
  zuFussBloecke: num('ZU_FUSS_BLOECKE', 4, 0, 50),
  tramSchwelle: Math.round(num('TRAM_SCHWELLE', 30, 1, 10000)),
  maxTramLinien: Math.round(num('MAX_TRAM_LINIEN', 6, 0, 12)),

  // Export für die GitHub-Seite
  exportZeit: str('EXPORT_ZEIT', '00:05'),
};

if (config.lebensdauerMaxMs < config.lebensdauerMinMs) {
  config.lebensdauerMaxMs = config.lebensdauerMinMs;
}

export const TIME = { HOUR, DAY };
