// Leistungswächter im Browser: misst die Rechenzeit pro Sekunde und passt Bildrate
// und Detailstufe an, damit das Darstellen höchstens das eingestellte Budget
// (Standard 30 %) eines Kerns belegt. Reicht auch die niedrigste Stufe nicht,
// zeigt die Startansicht nur einen Ausschnitt statt der ganzen Stadt.
export const LEVELS = [
  { name: 'Minimal', pixelRatio: 0.6, shadows: false, fps: 15, farDist: 18, emotesFar: false, precip: 0 },
  { name: 'Niedrig', pixelRatio: 0.8, shadows: false, fps: 24, farDist: 26, emotesFar: true, precip: 0 },
  { name: 'Mittel', pixelRatio: 1, shadows: false, fps: 30, farDist: 36, emotesFar: true, precip: 1 },
  { name: 'Hoch', pixelRatio: 1.5, shadows: true, fps: 60, farDist: 46, emotesFar: true, precip: 2 },
];

export class PerfGovernor {
  constructor({ limitPercent = 30, maxFps = 30, onChange }) {
    this.limit = limitPercent / 100;
    this.maxFps = maxFps;
    this.onChange = onChange;
    this.auto = true;
    const ua = navigator.userAgent || '';
    this.weakDevice = /aarch64|armv7|armv8|Raspbian|CrOS armv/i.test(ua) || (navigator.hardwareConcurrency || 4) <= 4 && /Linux arm/i.test(navigator.platform || '');
    this.level = this.weakDevice ? 1 : 2;
    this.work = 0;
    this.frames = 0;
    this.windowStart = performance.now();
    this.load = 0;
    this.fps = 0;
    this.goodWindows = 0;
    this.badAtMin = 0;
    this.cropped = false;
  }

  get settings() {
    return LEVELS[this.level];
  }

  get targetFps() {
    return Math.min(this.maxFps, this.settings.fps);
  }

  setManual(level) {
    if (level === 'auto') {
      this.auto = true;
    } else {
      this.auto = false;
      this.level = level;
      this.onChange?.(this.settings, this.level);
    }
  }

  // Liefert true, wenn in diesem Animationsschritt gerendert werden soll
  shouldRender(now) {
    const interval = 1000 / this.targetFps;
    if (this.last && now - this.last < interval - 2) return false;
    this.last = this.last && now - this.last < interval * 2 ? this.last + interval : now;
    return true;
  }

  record(workMs) {
    this.work += workMs;
    this.frames++;
    const now = performance.now();
    const span = now - this.windowStart;
    if (span < 3000) return;
    this.load = this.work / span;
    this.fps = (this.frames * 1000) / span;
    this.work = 0;
    this.frames = 0;
    this.windowStart = now;
    if (!this.auto) return;
    const tooSlow = this.load > this.limit || this.fps < this.targetFps * 0.7;
    if (tooSlow) {
      this.goodWindows = 0;
      if (this.level > 0) {
        this.level--;
        this.onChange?.(this.settings, this.level);
      } else if (++this.badAtMin >= 2 && !this.cropped) {
        this.cropped = true;
        this.onChange?.(this.settings, this.level, 'ausschnitt');
      }
    } else if (this.load < this.limit * 0.45 && this.fps >= this.targetFps * 0.9) {
      this.badAtMin = 0;
      if (++this.goodWindows >= 4 && this.level < LEVELS.length - 1) {
        this.goodWindows = 0;
        this.level++;
        this.onChange?.(this.settings, this.level);
      }
    } else {
      this.goodWindows = 0;
    }
  }
}
