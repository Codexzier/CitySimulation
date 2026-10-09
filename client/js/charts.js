// Kleine SVG-Diagramme (Liniendiagramm mit Fadenkreuz, Säulen, gestapelter Balken).
// Farben kommen aus CSS-Variablen; Beschriftungen nutzen Textfarben, nie Serienfarben.
import { fmt, fmt1, escapeHtml } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

let tooltip = null;
function tip() {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.hidden = true;
    document.body.append(tooltip);
  }
  return tooltip;
}

export function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y + 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 10;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  if (tooltip) tooltip.hidden = true;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Liniendiagramm einer Größe. points: [{x, y, label}]
export function lineChart(container, points, { width = 300, height = 120, unit = '', min = null, max = null, decimals = 0, color = 'var(--series-1)', axisLabel = (x) => x, compactAxis = false } = {}) {
  container.innerHTML = '';
  if (!points.length) {
    container.innerHTML = '<p class="leer">Noch keine Daten – die Historie füllt sich mit der Zeit.</p>';
    return;
  }
  const pad = { l: 34, r: 10, t: 8, b: 20 };
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' });
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = min ?? Math.min(0, ...ys);
  const hi = max ?? niceMax(Math.max(...ys) * 1.05);
  const X = (x) => pad.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (width - pad.l - pad.r);
  const Y = (y) => height - pad.b - ((y - lo) / Math.max(1e-9, hi - lo)) * (height - pad.t - pad.b);
  // Raster
  for (let i = 0; i <= 2; i++) {
    const v = lo + ((hi - lo) * i) / 2;
    svg.append(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: Y(v), y2: Y(v), class: i === 0 ? 'axis' : 'grid' }));
    const t = svgEl('text', { x: pad.l - 5, y: Y(v) + 3.5, class: 'tick', 'text-anchor': 'end' });
    t.textContent = compactAxis && v >= 1000 ? `${fmt(v / 1000)}k` : decimals ? fmt1(v) : fmt(v);
    svg.append(t);
  }
  const xt0 = svgEl('text', { x: pad.l, y: height - 5, class: 'tick' });
  xt0.textContent = axisLabel(x0);
  const xt1 = svgEl('text', { x: width - pad.r, y: height - 5, class: 'tick', 'text-anchor': 'end' });
  xt1.textContent = axisLabel(x1);
  svg.append(xt0, xt1);
  // Fläche + Linie
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  if (points.length > 1) {
    svg.append(svgEl('path', { d: `${d}L${X(x1)},${Y(lo)}L${X(x0)},${Y(lo)}Z`, fill: color, opacity: 0.1 }));
  }
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = points[points.length - 1];
  svg.append(svgEl('circle', { cx: X(last.x), cy: Y(last.y), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));
  // Fadenkreuz + Tooltip
  const cross = svgEl('line', { y1: pad.t, y2: height - pad.b, class: 'crosshair', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = svgEl('rect', { x: pad.l, y: 0, width: width - pad.l - pad.r, height, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * width;
    let best = points[0];
    for (const p of points) if (Math.abs(X(p.x) - mx) < Math.abs(X(best.x) - mx)) best = p;
    cross.setAttribute('x1', X(best.x));
    cross.setAttribute('x2', X(best.x));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(best.x));
    dot.setAttribute('cy', Y(best.y));
    dot.setAttribute('visibility', 'visible');
    const val = decimals ? fmt1(best.y) : fmt(best.y);
    showTip(`<b>${escapeHtml(best.label)}</b><br>${val}${unit ? ` ${unit}` : ''}`, e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  });
  container.append(svg);
}

// Mini-Linie ohne Achsen (Verlauf in der Kopfleiste)
export function sparkline(container, values, { width = 120, height = 30, color = 'var(--series-1)' } = {}) {
  container.innerHTML = '';
  if (values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = (i) => 2 + (i / (values.length - 1)) * (width - 6);
  const Y = (v) => height - 3 - ((v - lo) / Math.max(1e-9, hi - lo)) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(svgEl('circle', { cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 3, fill: color }));
  container.append(svg);
}

// Säulen (z. B. Altersstruktur). bars: [{label, value}]
export function columns(container, bars, { width = 130, height = 46, color = 'var(--series-1)', unit = '' } = {}) {
  container.innerHTML = '';
  const max = Math.max(1, ...bars.map((b) => b.value));
  const gap = 4;
  const bw = Math.min(18, (width - gap * (bars.length - 1)) / bars.length);
  const total = bars.length * bw + (bars.length - 1) * gap;
  const x0 = (width - total) / 2;
  const base = height - 12;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'cols' });
  svg.append(svgEl('line', { x1: 0, x2: width, y1: base + 0.5, y2: base + 0.5, class: 'axis' }));
  bars.forEach((b, i) => {
    const h = Math.max(b.value ? 2 : 0, (b.value / max) * (base - 4));
    const x = x0 + i * (bw + gap);
    const r = Math.min(4, h / 2, bw / 2);
    const y = base - h;
    const path = h > 0
      ? `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z`
      : '';
    if (path) svg.append(svgEl('path', { d: path, fill: color }));
    const t = svgEl('text', { x: x + bw / 2, y: height - 2, class: 'tick', 'text-anchor': 'middle' });
    t.textContent = b.short ?? b.label;
    svg.append(t);
    const hit = svgEl('rect', { x: x - gap / 2, y: 0, width: bw + gap, height, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => showTip(`<b>${escapeHtml(b.label)}</b><br>${fmt(b.value)}${unit ? ` ${unit}` : ''}`, e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hideTip);
    svg.append(hit);
  });
  container.append(svg);
}

// Gestapelter Balken mit 2px Lücken. parts: [{label, value, color}]
export function stackedBar(container, parts, { width = 260, height = 14 } = {}) {
  container.innerHTML = '';
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'stack', preserveAspectRatio: 'none' });
  let x = 0;
  const visible = parts.filter((p) => p.value > 0);
  const gaps = Math.max(0, visible.length - 1) * 2;
  visible.forEach((p, i) => {
    const w = (p.value / total) * (width - gaps);
    const rect = svgEl('rect', { x, y: 0, width: Math.max(0, w), height, fill: p.color, rx: i === 0 || i === visible.length - 1 ? 3 : 0 });
    rect.addEventListener('pointermove', (e) => showTip(`<b>${escapeHtml(p.label)}</b><br>${fmt(p.value)} %`, e.clientX, e.clientY));
    rect.addEventListener('pointerleave', hideTip);
    svg.append(rect);
    x += w + 2;
  });
  container.append(svg);
}
