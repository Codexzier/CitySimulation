// Echtes Wetter vom eigenen Ort über Open-Meteo (kostenlos, ohne API-Schlüssel).
// Ohne Internet wird ein plausibles Wetter simuliert.

const WMO = [
  [[0], 'klar', 'Klar'],
  [[1], 'heiter', 'Heiter'],
  [[2], 'bewoelkt', 'Teilweise bewölkt'],
  [[3], 'bedeckt', 'Bedeckt'],
  [[45, 48], 'nebel', 'Nebel'],
  [[51, 53, 55, 56, 57], 'niesel', 'Nieselregen'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'regen', 'Regen'],
  [[71, 73, 75, 77, 85, 86], 'schnee', 'Schnee'],
  [[95, 96, 99], 'gewitter', 'Gewitter'],
];

function classify(code) {
  for (const [codes, typ, text] of WMO) if (codes.includes(code)) return { typ, text };
  return { typ: 'bewoelkt', text: 'Bewölkt' };
}

export class Weather {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.lat = cfg.breitengrad;
    this.lon = cfg.laengengrad;
    this.ortName = cfg.ort;
    this.current = {
      quelle: 'start', ort: cfg.ort, temp: 14, code: 2, typ: 'bewoelkt', text: 'Teilweise bewölkt',
      wolken: 50, wind: 10, windRichtung: 240, niederschlag: 0, feuchte: 60, aktualisiert: null,
    };
    this.timer = null;
    this.failures = 0;
  }

  async start(onChange) {
    this.onChange = onChange;
    await this.update();
    this.timer = setInterval(() => this.update(), this.cfg.wetterIntervallMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async fetchJson(url) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'CitySimulation/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(to);
    }
  }

  async locate() {
    if (Number.isFinite(this.lat) && Number.isFinite(this.lon)) return true;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(this.cfg.ort)}&count=1&language=de&format=json`;
    const data = await this.fetchJson(url);
    const r = data?.results?.[0];
    if (!r) throw new Error(`Ort "${this.cfg.ort}" nicht gefunden`);
    this.lat = r.latitude;
    this.lon = r.longitude;
    this.ortName = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
    this.log.log(`[wetter] Ort: ${this.ortName} (${this.lat.toFixed(3)}, ${this.lon.toFixed(3)})`);
    return true;
  }

  async update() {
    try {
      await this.locate();
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${this.lat}&longitude=${this.lon}`
        + '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day'
        + '&timezone=auto';
      const data = await this.fetchJson(url);
      const c = data.current;
      const cls = classify(c.weather_code);
      this.current = {
        quelle: 'open-meteo', ort: this.ortName, temp: c.temperature_2m, code: c.weather_code, ...cls,
        wolken: c.cloud_cover, wind: c.wind_speed_10m, windRichtung: c.wind_direction_10m,
        niederschlag: c.precipitation, feuchte: c.relative_humidity_2m, aktualisiert: new Date().toISOString(),
      };
      this.failures = 0;
    } catch (err) {
      this.failures++;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.log.warn(`[wetter] Open-Meteo nicht erreichbar (${err.message}) – simuliere Wetter`);
      }
      this.simulate();
    }
    this.onChange?.(this.current);
  }

  // Einfaches Ersatzwetter: Jahresgang nach Kalendermonat + Zufall
  simulate() {
    const now = new Date();
    const month = now.getMonth();
    const base = [1, 2, 6, 10, 14, 18, 20, 19, 15, 10, 5, 2][month];
    const hour = now.getHours() + now.getMinutes() / 60;
    const daily = -3 * Math.cos(((hour - 3) / 24) * Math.PI * 2);
    const prev = this.current;
    const r = Math.random();
    let code = prev.code ?? 2;
    if (r < 0.25) code = [0, 1, 2, 3, 3, 61, 63, 45, base < 3 ? 71 : 80][Math.floor(Math.random() * 9)];
    const cls = classify(code);
    this.current = {
      quelle: 'simuliert', ort: this.ortName || this.cfg.ort, temp: Math.round((base + daily + (Math.random() - 0.5) * 2) * 10) / 10,
      code, ...cls, wolken: code <= 1 ? 10 : code === 2 ? 50 : 90, wind: Math.round(5 + Math.random() * 20),
      windRichtung: 240, niederschlag: ['regen', 'schnee', 'niesel', 'gewitter'].includes(cls.typ) ? 1.2 : 0,
      feuchte: 70, aktualisiert: new Date().toISOString(),
    };
  }
}
