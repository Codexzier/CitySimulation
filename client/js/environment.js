// Tag/Nacht, Licht, Himmel, Nebel/Smog, Regen/Schnee, Rauch der Fabriken, Lichter in der Nacht.
import * as THREE from 'three';
import { Billboards, glowTexture, puffTexture } from './instanced.js';
import { clamp, lerp } from './util.js';

const C = (hex) => new THREE.Color(hex);
const SKY_DAY = C('#9fd2ef');
const SKY_DUSK = C('#f0a877');
const SKY_NIGHT = C('#0c1630');
const CLOUD_DAY = C('#a9b2bb');
const CLOUD_NIGHT = C('#161b26');
const SMOG = C('#b4a585');
const SUN_WARM = C('#ffcf96');
const SUN_WHITE = C('#fff6e8');

export class Environment {
  constructor(scene, renderer, assets) {
    this.scene = scene;
    this.renderer = renderer;
    this.assets = assets;
    this.sky = new THREE.Color();
    scene.background = this.sky;
    scene.fog = new THREE.Fog(this.sky, 60, 300);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 1.2);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.moon = new THREE.DirectionalLight(0x8fa6ff, 0);
    scene.add(this.moon);

    this.glowTex = glowTexture('rgba(255,214,140,1)', 'rgba(255,170,70,0)');
    this.lampGlow = new Billboards(scene, this.glowTex, {
      capacity: 2048, blending: THREE.AdditiveBlending, worldSize: 0.45, pixelSize: 3, anchorBottom: false,
    });
    this.smoke = new Billboards(scene, puffTexture(), {
      capacity: 600, worldSize: 0.45, pixelSize: 2, anchorBottom: false, color: true,
    });
    this.smoke.mesh.renderOrder = 5;
    this.precip = null;
    this.precipType = null;
    this.shadowTimer = 0;
    this.night = 0;
    this.weather = { typ: 'klar', wolken: 20, temp: 15, wind: 8, windRichtung: 240 };
    this.air = 100;
  }

  setCity(size) {
    this.citySize = size;
    const sc = this.sun.shadow.camera;
    const h = size * 0.62;
    sc.left = -h; sc.right = h; sc.top = h; sc.bottom = -h;
    sc.near = 1; sc.far = size * 3;
    sc.updateProjectionMatrix();
  }

  setWeather(w) {
    this.weather = { ...this.weather, ...w };
  }

  setShadows(on) {
    this.sun.castShadow = on;
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.needsUpdate = true;
  }

  // Tageszeit in Stunden (0–24) aus der Simulationszeit
  static hod(simNow, cycleMs) {
    return (((simNow / cycleMs + 0.25) % 1) + 1) % 1 * 24;
  }

  update(simNow, realNow, dt, ctx) {
    const hod = ctx.fixedHod ?? Environment.hod(simNow, ctx.cycleMs);
    const w = this.weather;
    const clouds = clamp((w.wolken ?? 30) / 100, 0, 1);
    const wet = ['regen', 'gewitter', 'niesel'].includes(w.typ);
    const snow = w.typ === 'schnee';
    const fog = w.typ === 'nebel';

    // Sonnenstand: Aufgang 6 Uhr, Untergang 18 Uhr
    const dayPos = (hod - 6) / 12;
    const elev = Math.sin(dayPos * Math.PI);
    const day = clamp(elev * 3 + 0.15, 0, 1);
    this.night = 1 - clamp(elev * 4 + 0.5, 0, 1);
    const dusk = clamp(1 - Math.abs(elev) * 4, 0, 1) * (hod > 4 && hod < 20 ? 1 : 0);

    // Himmel
    const sky = this.sky;
    sky.copy(SKY_NIGHT).lerp(SKY_DAY, day);
    sky.lerp(SKY_DUSK, dusk * 0.55);
    const cloudCol = CLOUD_NIGHT.clone().lerp(CLOUD_DAY, day);
    sky.lerp(cloudCol, clouds * 0.65 + (wet ? 0.2 : 0));
    const smog = clamp((65 - this.air) / 60, 0, 0.6);
    sky.lerp(SMOG, smog * day * 0.7);

    // Licht
    const az = dayPos * Math.PI; // Osten → Westen
    const c = ctx.center;
    const R = this.citySize || 60;
    if (elev > -0.05) {
      this.sun.position.set(c.x + Math.cos(az) * R, Math.max(0.1, elev) * R * 1.2 + 4, c.z - R * 0.45);
    } else {
      this.sun.position.set(c.x, R, c.z - R * 0.3);
    }
    this.sun.target.position.set(c.x, 0, c.z);
    this.sun.color.copy(SUN_WHITE).lerp(SUN_WARM, dusk);
    this.sun.intensity = Math.max(0, elev) * 2.4 * (1 - clouds * 0.55) * (wet ? 0.7 : 1);
    this.moon.position.set(c.x - R * 0.5, R, c.z + R * 0.4);
    this.moon.target = this.sun.target;
    this.moon.intensity = this.night * 0.35;
    this.hemi.color.copy(sky).lerp(new THREE.Color(1, 1, 1), 0.35 * day);
    this.hemi.groundColor.set(day > 0.2 ? 0x6f7d5c : 0x1c2235);
    this.hemi.intensity = (0.55 + day * 1.05 - clouds * 0.1) * (wet ? 0.75 : 1);

    // Nebel / Smog
    const dist = ctx.cameraDistance;
    this.scene.fog.color.copy(sky);
    if (fog) {
      this.scene.fog.near = 2;
      this.scene.fog.far = Math.max(25, dist * 1.6);
    } else {
      const haze = 1 - smog * 0.6 - (wet ? 0.25 : 0);
      this.scene.fog.near = dist * 1.4 * haze;
      this.scene.fog.far = dist * 5 * haze + 40;
    }

    // Fenster leuchten nachts
    const glow = this.night * 0.95;
    for (const kit of ['suburban', 'commercial', 'industrial']) {
      const m = this.assets.materials[kit];
      if (m) m.emissiveIntensity = glow;
    }

    // Schnee am Boden bei Schneefall bzw. Frost
    ctx.snowUniform.value = lerp(ctx.snowUniform.value, snow ? 0.75 : w.temp < -2 ? 0.25 : 0, Math.min(1, dt * 0.2));

    // Schatten nur selten neu berechnen (spart Leistung)
    if (this.sun.castShadow) {
      this.shadowTimer -= dt;
      if (this.shadowTimer <= 0) {
        this.renderer.shadowMap.needsUpdate = true;
        this.shadowTimer = 0.8;
      }
    }

    this.updateGlows(ctx);
    this.updateSmoke(realNow, ctx, hod);
    this.updatePrecip(realNow, ctx, wet ? (w.typ === 'niesel' ? 'niesel' : 'regen') : snow ? 'schnee' : null);
  }

  updateGlows(ctx) {
    const g = this.lampGlow;
    g.setPixelFactor(ctx.camera, ctx.height);
    g.begin();
    if (this.night > 0.05) {
      const a = this.night;
      for (const [x, y, z] of ctx.lamps) g.push(x, y, z, 0, 0, 1, 1, a, 1.3);
      const cf = ctx.carFronts;
      for (let i = 0; i < cf.length; i += 2) g.push(cf[i], 0.1, cf[i + 1], 0, 0, 1, 1, a * 0.9, 0.7);
    }
    g.end();
  }

  updateSmoke(now, ctx, hod) {
    const s = this.smoke;
    s.setPixelFactor(ctx.camera, ctx.height);
    s.begin();
    if (ctx.quality >= 1) {
      const busy = hod >= 6 && hod < 18 ? 1 : 0.45;
      const w = this.weather;
      const rad = ((w.windRichtung ?? 240) * Math.PI) / 180;
      const wind = clamp((w.wind ?? 10) / 30, 0.1, 1.2);
      const dx = -Math.sin(rad) * wind, dz = Math.cos(rad) * wind;
      const dark = clamp((70 - this.air) / 70, 0, 0.5);
      const shade = 0.82 - dark - this.night * 0.45;
      const t = now / 1000;
      for (const f of ctx.factoryTops) {
        for (let p = 0; p < 3; p++) {
          const life = 6;
          const age = ((t + f.id * 1.7 + p * (life / 3)) % life) / life;
          if (busy < 1 && p === 2) continue;
          const alpha = Math.sin(age * Math.PI) * 0.55 * busy;
          s.push(f.x + dx * age * 1.6, f.y + age * 1.4, f.z + dz * age * 1.6, 0, 0, 1, 1, alpha, 0.6 + age * 1.6, shade, shade, shade * 1.02);
        }
      }
    }
    s.end();
  }

  updatePrecip(now, ctx, type) {
    if (type !== this.precipType) {
      if (this.precip) {
        this.scene.remove(this.precip);
        this.precip.geometry.dispose();
        this.precip.material.dispose();
        this.precip = null;
      }
      this.precipType = type;
      if (type) this.precip = this.makePrecip(type, ctx.quality);
    }
    if (!this.precip) return;
    const u = this.precip.material.uniforms;
    u.uTime.value = now / 1000;
    u.uCenter.value.set(ctx.center.x, 0, ctx.center.z);
    u.uBox.value = Math.max(8, Math.min(ctx.cameraDistance * 0.7, this.citySize || 60));
    u.uFog.value.copy(this.sky);
  }

  makePrecip(type, quality) {
    const count = Math.round([1500, 3000, 6000][clamp(quality, 0, 2)] * (type === 'niesel' ? 0.5 : 1));
    const isSnow = type === 'schnee';
    const seeds = new Float32Array(count * 3 * (isSnow ? 1 : 2));
    const ends = new Float32Array(count * (isSnow ? 1 : 2));
    for (let i = 0; i < count; i++) {
      const sx = Math.random(), sy = Math.random(), sz = Math.random();
      if (isSnow) {
        seeds.set([sx, sy, sz], i * 3);
      } else {
        seeds.set([sx, sy, sz, sx, sy, sz], i * 6);
        ends[i * 2 + 1] = 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uBox: { value: 40 },
        uSpeed: { value: isSnow ? 0.8 : 14 }, uFog: { value: new THREE.Color() },
      },
      vertexShader: /* glsl */`
        attribute float aEnd;
        uniform float uTime; uniform vec3 uCenter; uniform float uBox; uniform float uSpeed;
        varying float vA;
        void main() {
          float h = 18.0;
          float y = mod(position.y * h - uTime * uSpeed * (0.8 + position.x * 0.4), h);
          vec3 p = vec3(uCenter.x + (position.x - 0.5) * uBox * 2.0, y, uCenter.z + (position.z - 0.5) * uBox * 2.0);
          p.x += sin(uTime * 0.7 + position.z * 30.0) * ${isSnow ? '0.6' : '0.0'};
          p.y += aEnd * 0.45;
          p.x += aEnd * 0.06;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = ${isSnow ? 'clamp(140.0 / -mv.z, 1.5, 6.0)' : '1.0'};
          vA = clamp(y / 3.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          ${isSnow ? 'vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard;' : ''}
          gl_FragColor = vec4(${isSnow ? '0.96, 0.97, 1.0, 0.9' : '0.78, 0.85, 0.97, 0.7'} * vec4(1.0, 1.0, 1.0, vA));
        }`,
      transparent: true,
      depthWrite: false,
    });
    const obj = isSnow ? new THREE.Points(geo, mat) : new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    obj.renderOrder = 20;
    this.scene.add(obj);
    return obj;
  }
}
