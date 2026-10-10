// Kleiner deterministischer Zufallsgenerator (mulberry32), Zustand speicherbar.
export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) {
    return a + (b - a) * this.next();
  }

  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  chance(p) {
    return this.next() < p;
  }

  // Gewichtete Auswahl: items = [[wert, gewicht], ...]
  weighted(items) {
    let sum = 0;
    for (const [, w] of items) sum += Math.max(0, w);
    if (sum <= 0) return null;
    let r = this.next() * sum;
    for (const [v, w] of items) {
      r -= Math.max(0, w);
      if (r <= 0) return v;
    }
    return items[items.length - 1][0];
  }
}
