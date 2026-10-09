// Bedienoberfläche: Kopfleiste mit Stadtinfos, Verlauf, Infofenster, Meldungen.
import { fmt, fmt1, escapeHtml } from './util.js';
import { lineChart, sparkline, columns, stackedBar } from './charts.js';

const $ = (id) => document.getElementById(id);

export const EMOTE_TEXT = {
  verliebt: 'Verliebt', liebeskummer: 'Liebeskummer', enttaeuscht: 'Enttäuscht', singen: 'Singt',
  freuen: 'Freut sich', boese: 'Böse', schlafend: 'Schläft', schwitzend: 'Schwitzt', sorglos: 'Sorglos',
  entsetzt: 'Entsetzt', fragend: 'Fragend', abweisend: 'Abweisend', benommen: 'Benommen',
};

const ORT_TEXT = { home: 'Zuhause', work: 'Bei der Arbeit', unterwegs: 'Unterwegs', freizeit: 'Zu Besuch' };

function glueckText(g) {
  if (g >= 75) return 'sehr glücklich';
  if (g >= 60) return 'zufrieden';
  if (g >= 45) return 'geht so';
  if (g >= 30) return 'unzufrieden';
  return 'unglücklich';
}

function airStatus(index) {
  if (index >= 60) return { cls: 'good', icon: '✓', text: index >= 80 ? 'sehr gut' : 'gut' };
  if (index >= 40) return { cls: 'warning', icon: '!', text: 'mäßig' };
  if (index >= 20) return { cls: 'serious', icon: '▲', text: 'schlecht' };
  return { cls: 'critical', icon: '✕', text: 'sehr schlecht' };
}

export class UI {
  constructor({ onInfoPerson, onInfoBuilding, onFollow, onOverview, onQuality }) {
    this.cb = { onInfoPerson, onInfoBuilding, onFollow, onOverview, onQuality };
    this.history = { stunden: [], tage: [] };
    this.emoteFrames = null;
    this.infoTimer = null;
    this.current = null;
    $('historieBtn').addEventListener('click', () => this.toggleHistory());
    $('historieClose').addEventListener('click', () => this.toggleHistory(false));
    $('infoClose').addEventListener('click', () => this.closeInfo());
    $('btnOverview').addEventListener('click', () => this.cb.onOverview());
    $('quality').addEventListener('change', (e) => this.cb.onQuality(e.target.value));
    $('tabelleBtn').addEventListener('click', () => {
      const t = $('historieTabelle');
      t.hidden = !t.hidden;
      $('tabelleBtn').textContent = t.hidden ? 'Als Tabelle zeigen' : 'Tabelle ausblenden';
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeInfo();
        this.toggleHistory(false);
      }
    });
  }

  setEmotes(assets) {
    this.emoteFrames = assets.emotes.frames;
    this.emoteSyms = null;
  }

  setInit(init) {
    $('stadtname').textContent = init.name;
    document.title = `${init.name} – Stadtsimulation`;
    this.emoteSyms = init.emotes;
    this.history = init.history || { stunden: [], tage: [] };
    this.historyDays = init.cfg.historieTage;
    $('historieTitel').textContent = `Entwicklung der letzten ${init.cfg.historieTage} Tage`;
    this.updateStats(init.stats);
    this.renderHistory();
    for (const n of init.news || []) this.news(n.text, true);
  }

  // ------------------------------------------------------------------ Kopfleiste
  updateClock(z) {
    if (!z) return;
    $('uhr').textContent = z.uhr;
    $('tagphase').textContent = z.nacht ? '☾' : '☀';
    $('tagphase').title = z.nacht ? 'Nacht' : 'Tag';
    $('tag').textContent = fmt(z.tag);
    $('jahr').textContent = fmt(z.jahr);
    $('jahreszeit').textContent = z.jahreszeit;
  }

  updateWeather(w) {
    if (!w) return;
    const icon = { klar: '☀', heiter: '🌤', bewoelkt: '⛅', bedeckt: '☁', nebel: '🌫', niesel: '🌦', regen: '🌧', schnee: '🌨', gewitter: '⛈' }[w.typ] || '☁';
    const src = w.quelle === 'open-meteo' ? '' : ' (simuliert)';
    $('wetter').innerHTML = `<span aria-hidden="true">${icon}</span> ${fmt1(w.temp)} °C · ${escapeHtml(w.text)} · ${escapeHtml((w.ort || '').split(',')[0])}${src}`;
    $('wetter').title = `Wetter am eigenen Ort${src ? ' – Open-Meteo nicht erreichbar, Wetter wird simuliert' : ' (Open-Meteo)'}\n`
      + `Wind ${fmt(w.wind)} km/h · Bewölkung ${fmt(w.wolken)} % · Niederschlag ${fmt1(w.niederschlag)} mm`;
  }

  updateStats(s) {
    if (!s) return;
    this.stats = s;
    $('einwohner').textContent = fmt(s.einwohner);
    $('zuzug').textContent = s.zuzug.aktiv ? `+1 je Stunde · max. ${fmt(s.leistung.maxEinwohner)}` : `Zuzug pausiert: ${s.zuzug.grund}`;
    $('zuzug').classList.toggle('warn', !s.zuzug.aktiv);
    $('arbeit').textContent = fmt(s.arbeit);
    $('zuhause').textContent = fmt(s.zuhause);
    $('unterwegs').textContent = fmt(s.unterwegs);
    $('arbeitSub').textContent = s.arbeitslose ? `${fmt(s.arbeitslose)} arbeitssuchend` : `${fmt(s.rentner)} in Rente`;
    const st = airStatus(s.luft.index);
    $('luft').className = `status ${st.cls}`;
    $('luft').innerHTML = `<i aria-hidden="true">${st.icon}</i><b>${st.text}</b><span>${fmt(s.luft.index)}/100</span>`;
    $('emission').textContent = `${fmt(s.emission.kgH)} kg/h`;
    $('emissionHeute').textContent = `heute ${fmt1(s.emission.heuteT)} t CO₂`;
    columns($('alter'), [
      { label: '0–9 Tage', short: '0', value: s.alter[0] },
      { label: '10–19 Tage', short: '10', value: s.alter[1] },
      { label: '20–29 Tage', short: '20', value: s.alter[2] },
      { label: '30–39 Tage', short: '30', value: s.alter[3] },
      { label: '40+ Tage', short: '40+', value: s.alter[4] },
    ], { unit: 'Einwohner' });
    $('zufriedenheit').textContent = `${fmt(s.zufriedenheit)} %`;
    $('zufriedenheitMeter').style.width = `${s.zufriedenheit}%`;
    $('zufriedenheitSub').textContent = glueckText(s.zufriedenheit);
    $('dichte').textContent = `${fmt(s.bebauung.prozent)} % bebaut`;
    const [h, m, hh] = s.bebauung.wohngebaeude;
    $('gebaeude').textContent = `${fmt1(s.bebauung.dichte)} Einw. je Wohnhaus`;
    $('gebaeudeArten').textContent = `${h} Häuser · ${m} MFH · ${hh} Hochh. · ${s.bebauung.industrie} Fabr.`;
    $('gebaeudeArten').title = `${h} Einfamilienhäuser, ${m} Mehrfamilienhäuser, ${hh} Hochhäuser, ${s.bebauung.industrie} Fabriken`;
    this.updateClock(s.zeit);
    this.updateWeather(s.wetter);
    // Verkehrsmittel im Verlaufsfenster
    stackedBar($('modal'), [
      { label: 'Zu Fuß', value: s.verkehr.fuss, color: 'var(--series-1)' },
      { label: 'Auto', value: s.verkehr.auto, color: 'var(--series-2)' },
      { label: 'Bahn', value: s.verkehr.bahn, color: 'var(--series-3)' },
    ]);
    $('modalLegende').innerHTML = `<span><i style="background:var(--series-1)"></i>Zu Fuß ${fmt(s.verkehr.fuss)} %</span>`
      + `<span><i style="background:var(--series-2)"></i>Auto ${fmt(s.verkehr.auto)} %</span>`
      + `<span><i style="background:var(--series-3)"></i>Bahn ${fmt(s.verkehr.bahn)} %</span>`;
    $('verkehrSub').textContent = `${s.verkehr.linien} Straßenbahnlinie${s.verkehr.linien === 1 ? '' : 'n'} · ${fmt(s.verkehr.autosAktiv)} Autos gerade unterwegs`;
    $('serverCpu').textContent = `${fmt1(s.leistung.cpu)} % (Grenze ${fmt(s.leistung.limit)} %)`;
  }

  // ------------------------------------------------------------------ Verlauf
  addHistory(ev) {
    if (ev.stunde) {
      this.history.stunden.push(ev.stunde);
      if (this.history.stunden.length > 168) this.history.stunden.shift();
    }
    if (ev.tag) {
      this.history.tage.push(ev.tag);
      while (this.history.tage.length > this.historyDays) this.history.tage.shift();
    }
    this.renderHistory();
  }

  series() {
    const tage = this.history.tage;
    if (tage.length >= 2) {
      const lab = (d) => `Tag ${d.tag}${d.datum ? ` (${new Date(`${d.datum}T12:00:00`).toLocaleDateString('de-DE')})` : ''}`;
      return {
        mode: 'tage',
        einwohner: tage.map((d) => ({ x: d.tag, y: d.einwohner, label: lab(d) })),
        glueck: tage.map((d) => ({ x: d.tag, y: d.zufriedenheit, label: lab(d) })),
        luft: tage.map((d) => ({ x: d.tag, y: d.luft, label: lab(d) })),
        emission: tage.map((d) => ({ x: d.tag, y: d.emission_t, label: lab(d) })),
        axis: (x) => `Tag ${fmt(x)}`,
        rows: tage,
      };
    }
    const st = this.history.stunden;
    const dayMs = 86400000;
    const lab = (d) => `Tag ${Math.floor(d.t / dayMs) + 1}, ${Math.floor((d.t % dayMs) / 3600000)}:00 Uhr`;
    return {
      mode: 'stunden',
      einwohner: st.map((d) => ({ x: d.t / 3600000, y: d.einwohner, label: lab(d) })),
      glueck: st.map((d) => ({ x: d.t / 3600000, y: d.zufriedenheit, label: lab(d) })),
      luft: st.map((d) => ({ x: d.t / 3600000, y: d.luft, label: lab(d) })),
      emission: st.map((d) => ({ x: d.t / 3600000, y: d.emission, label: lab(d) })),
      axis: (x) => `${fmt(x)} h`,
      rows: st,
    };
  }

  renderHistory() {
    const s = this.series();
    sparkline($('spark'), s.einwohner.map((p) => p.y));
    const n = s.mode === 'tage' ? s.rows.length : 0;
    $('historieSub').textContent = s.mode === 'tage' ? `${n} Tage` : 'Stundenwerte';
    if ($('historiePanel').hidden) return;
    lineChart($('chartEinwohner'), s.einwohner, { unit: 'Einwohner', axisLabel: s.axis, compactAxis: true });
    lineChart($('chartGlueck'), s.glueck, { unit: '%', min: 0, max: 100, axisLabel: s.axis });
    lineChart($('chartLuft'), s.luft, { unit: 'von 100', min: 0, max: 100, axisLabel: s.axis });
    lineChart($('chartEmission'), s.emission, { unit: s.mode === 'tage' ? 't CO₂ pro Tag' : 'kg/h', decimals: s.mode === 'tage' ? 1 : 0, axisLabel: s.axis });
    $('emissionTitel').textContent = s.mode === 'tage' ? 'Emission (t CO₂ pro Tag)' : 'Emission (kg/h)';
    // Tabellenansicht
    const rows = s.rows.slice(-60).reverse();
    const head = s.mode === 'tage'
      ? '<tr><th>Tag</th><th>Einwohner</th><th>Zufriedenheit</th><th>Luft</th><th>Emission (t)</th><th>Hochhäuser</th><th>Bahn %</th></tr>'
      : '<tr><th>Zeit</th><th>Einwohner</th><th>Zufriedenheit</th><th>Luft</th><th>Emission (kg/h)</th></tr>';
    const body = rows.map((d) => (s.mode === 'tage'
      ? `<tr><td>${d.tag}</td><td>${fmt(d.einwohner)}</td><td>${fmt(d.zufriedenheit)} %</td><td>${fmt(d.luft)}</td><td>${fmt1(d.emission_t)}</td><td>${fmt(d.hochhaeuser)}</td><td>${fmt(d.bahn)}</td></tr>`
      : `<tr><td>${Math.floor(d.t / 3600000)} h</td><td>${fmt(d.einwohner)}</td><td>${fmt(d.zufriedenheit)} %</td><td>${fmt(d.luft)}</td><td>${fmt(d.emission)}</td></tr>`)).join('');
    $('historieTabelle').innerHTML = `<table>${head}${body}</table>`;
  }

  toggleHistory(force) {
    const p = $('historiePanel');
    const open = force ?? p.hidden;
    p.hidden = !open;
    $('historieBtn').setAttribute('aria-expanded', String(open));
    if (open) this.renderHistory();
  }

  // ------------------------------------------------------------------ Info-Fenster
  emoteIcon(key) {
    const sym = this.emoteSyms?.[key];
    const f = sym && this.emoteFrames?.[sym];
    if (!f) return '';
    return `<span class="emote" style="background-position:-${f[0]}px -${f[1]}px" role="img" aria-label="${EMOTE_TEXT[key] || ''}"></span>`;
  }

  personRow(p) {
    const thought = p.gedanke ? this.emoteIcon(p.gedanke) : '';
    return `<li><button class="person" data-id="${p.id}">
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="meta">${fmt(p.alter)} Tage · ${escapeHtml(p.beruf)} · ${ORT_TEXT[p.ort] || ''}</span>
      <span class="glueck" title="Glück ${fmt(p.glueck)} %"><span style="width:${p.glueck}%"></span></span>${thought}
    </button></li>`;
  }

  showInfo(info, kind) {
    this.current = { info, kind };
    const box = $('infoInhalt');
    let html = '';
    const row = (k, v) => (v === null || v === undefined || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
    if (info.typ === 'person') {
      html += `<h2>${escapeHtml(info.titel)}</h2><p class="untertitel">${escapeHtml(info.beruf)}</p>`;
      html += `<div class="stimmung">${info.gedanke ? this.emoteIcon(info.gedanke) : ''}<div><b>${glueckText(info.glueck)}</b> (${fmt(info.glueck)} %)<div class="meter"><span style="width:${info.glueck}%"></span></div>${info.gedanke ? `<small>Gedanke: ${EMOTE_TEXT[info.gedanke]}</small>` : ''}</div></div>`;
      html += '<dl>';
      html += row('Alter', `${fmt1(info.alter)} Tage (${info.lebensphase})`);
      html += row('Tätigkeit', escapeHtml(info.taetigkeit));
      html += row('Arbeitgeber', info.arbeitgeber ? escapeHtml(info.arbeitgeber) : null);
      html += row('Schicht', info.arbeitgeber ? info.schicht : null);
      html += row('Wohnort', info.wohnort ? escapeHtml(info.wohnort) : 'ohne Wohnung');
      html += row('Arbeitsweg', info.verkehrsmittel !== '–' ? `${info.verkehrsmittel}${info.pendelzeit ? `, ${fmt(info.pendelzeit)} s` : ''}` : null);
      html += row('Partner/in', info.partner ? `${escapeHtml(info.partner)} ${this.emoteIcon('verliebt')}` : null);
      html += '</dl>';
      html += '<button id="followBtn" class="knopf">Folgen</button>';
    } else if (info.typ === 'gebaeude') {
      html += `<h2>${escapeHtml(info.titel)}</h2><p class="untertitel">${escapeHtml(info.art)} · ${escapeHtml(info.adresse)} · ${escapeHtml(info.viertel)}</p><dl>`;
      if (info.art === 'Wohngebäude') {
        html += row('Einwohner', `${fmt(info.einwohner)} von ${fmt(info.kapazitaet)}`);
        html += row('Davon berufstätig', fmt(info.arbeiter));
        html += row('Gerade zuhause', fmt(info.zuhause));
      } else {
        html += row('Arbeiter', `${fmt(info.arbeiter)} von ${fmt(info.jobs)} Stellen`);
        html += row('Gerade anwesend', fmt(info.anwesend));
        html += row('Emission', `${fmt(info.emission)} kg/h`);
      }
      html += row('Ø Glück', info.glueck !== null ? `${fmt(info.glueck)} % (${glueckText(info.glueck)})` : null);
      html += row('Luftqualität', `${fmt(info.luft)}/100 (${airStatus(info.luft).text})`);
      html += '</dl>';
      if (info.personen?.length) html += `<h3>${info.art === 'Wohngebäude' ? 'Bewohner' : 'Belegschaft'}</h3><ul class="personen">${info.personen.map((p) => this.personRow(p)).join('')}</ul>`;
    } else if (info.typ === 'fahrzeug') {
      html += `<h2>${escapeHtml(info.titel)}</h2><p class="untertitel">${escapeHtml(info.linie)} · Zug ${info.fahrzeug} von ${info.fahrzeuge}</p><dl>`;
      html += row('Fahrgäste', `${fmt(info.fahrgaeste)} von ${fmt(info.kapazitaet)}`);
      html += row('Halte', info.haltestellen.map(escapeHtml).join(' · '));
      html += '</dl>';
      if (info.personen?.length) html += `<h3>Fahrgäste</h3><ul class="personen">${info.personen.map((p) => this.personRow(p)).join('')}</ul>`;
    } else if (info.typ === 'station') {
      html += `<h2>${escapeHtml(info.titel)}</h2><p class="untertitel">${escapeHtml(info.art)}</p><dl>`;
      html += row('Linien', info.linien.map(escapeHtml).join('<br>'));
      html += row('Wartende', fmt(info.wartend));
      html += '</dl>';
    }
    box.innerHTML = html;
    $('info').hidden = false;
    box.querySelectorAll('button.person').forEach((b) => b.addEventListener('click', () => this.cb.onInfoPerson(Number(b.dataset.id))));
    $('followBtn')?.addEventListener('click', () => this.cb.onFollow(info.id));
  }

  closeInfo() {
    $('info').hidden = true;
    this.current = null;
    this.onClose?.();
  }

  // ------------------------------------------------------------------ Sonstiges
  news(text, quiet = false) {
    const box = $('news');
    const item = document.createElement('div');
    item.className = 'meldung';
    item.textContent = text;
    box.prepend(item);
    while (box.children.length > 3) box.lastChild.remove();
    setTimeout(() => item.classList.add('weg'), quiet ? 4000 : 10000);
    setTimeout(() => item.remove(), quiet ? 4600 : 10600);
  }

  connection(ok, text) {
    const c = $('verbindung');
    c.hidden = ok;
    if (text) c.textContent = text;
  }

  perf(p, settings, level) {
    $('perfFps').textContent = `${fmt(p.fps)} fps`;
    $('perfLast').textContent = `${fmt(p.load * 100)} %`;
    $('perfStufe').textContent = settings.name;
    void level;
  }

  loading(done, total, text) {
    const l = $('loading');
    if (done === null) {
      l.classList.add('fertig');
      setTimeout(() => (l.hidden = true), 600);
      return;
    }
    $('ladeText').textContent = text || `Lade Modelle … ${done}/${total}`;
    $('ladeBalken').style.width = `${(done / Math.max(1, total)) * 100}%`;
  }
}
