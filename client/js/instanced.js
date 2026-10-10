// Hilfsklassen: wachsende InstancedMeshes und Billboards (Emotes, Lichter, Rauch).
import * as THREE from 'three';

// Verwaltet Instanzen eines Modells über frei wählbare Schlüssel.
export class InstancedGroup {
  constructor(parent, geometry, material, { capacity = 8, castShadow = false, receiveShadow = false } = {}) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.castShadow = castShadow;
    this.receiveShadow = receiveShadow;
    this.keys = [];
    this.index = new Map();
    this.mesh = null;
    this.dirtyBounds = true;
    this.alloc(capacity);
  }

  alloc(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.dirtyBounds = true;
    mesh.count = this.keys.length;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.keys.length * 16));
      this.parent.remove(old);
      old.dispose();
    }
    mesh.visible = mesh.count > 0;
    this.mesh = mesh;
    this.parent.add(mesh);
  }

  set(key, matrix) {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keys.length;
      if (i >= this.mesh.instanceMatrix.count) this.alloc(Math.max(8, i * 2));
      this.keys.push(key);
      this.index.set(key, i);
      this.mesh.count = this.keys.length;
      this.mesh.visible = true;
    }
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyBounds = true;
    return i;
  }

  // Hüllkugel aller Instanzen neu berechnen → Gruppen außerhalb des Bildes werden übersprungen
  refreshBounds() {
    if (!this.dirtyBounds) return;
    this.dirtyBounds = false;
    if (!this.keys.length) return;
    this.mesh.computeBoundingSphere();
    this.mesh.frustumCulled = true;
  }

  remove(key) {
    const i = this.index.get(key);
    if (i === undefined) return;
    const last = this.keys.length - 1;
    if (i !== last) {
      const lastKey = this.keys[last];
      const arr = this.mesh.instanceMatrix.array;
      arr.copyWithin(i * 16, last * 16, last * 16 + 16);
      this.keys[i] = lastKey;
      this.index.set(lastKey, i);
    }
    this.keys.pop();
    this.index.delete(key);
    this.mesh.count = this.keys.length;
    this.mesh.visible = this.keys.length > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyBounds = true;
  }

  clear() {
    this.keys.length = 0;
    this.index.clear();
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

// Schnell neu befüllbare Instanzen (z. B. Figuren je Bild): pro Frame begin/push/end.
export class InstancedBatch {
  constructor(parent, geometry, material, capacity = 32) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.n = 0;
    this.mesh = null;
    this.alloc(capacity);
  }

  alloc(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, old.instanceMatrix.array.length));
      this.parent.remove(old);
      old.dispose();
    }
    this.mesh = mesh;
    this.parent.add(mesh);
  }

  begin() {
    this.n = 0;
  }

  push(matrix) {
    if (this.n >= this.mesh.instanceMatrix.count) this.alloc(this.mesh.instanceMatrix.count * 2);
    this.mesh.setMatrixAt(this.n++, matrix);
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// Kamera-zugewandte Quads mit Texturatlas. Größe in Pixeln (min.) bzw. Welteinheiten.
export class Billboards {
  constructor(parent, texture, { capacity = 256, blending = THREE.NormalBlending, worldSize = 0.4, pixelSize = 26, aspect = 1, anchorBottom = true, color = null } = {}) {
    this.capacity = capacity;
    const base = new THREE.PlaneGeometry(1, aspect);
    if (anchorBottom) base.translate(0, aspect / 2, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.pos = new Float32Array(capacity * 3);
    this.uv = new Float32Array(capacity * 4);
    this.alpha = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.tint = new Float32Array(capacity * 3);
    this.attrs = {
      iPos: new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
      iUv: new THREE.InstancedBufferAttribute(this.uv, 4).setUsage(THREE.DynamicDrawUsage),
      iAlpha: new THREE.InstancedBufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
      iScale: new THREE.InstancedBufferAttribute(this.scale, 1).setUsage(THREE.DynamicDrawUsage),
      iTint: new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage),
    };
    for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a);
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uWorld: { value: worldSize },
        uPixel: { value: pixelSize },
        uPxFactor: { value: 0.001 },
        uUseTint: { value: color ? 1 : 0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec4 iUv; attribute float iAlpha; attribute float iScale; attribute vec3 iTint;
        uniform float uWorld; uniform float uPixel; uniform float uPxFactor;
        varying vec2 vUv; varying float vAlpha; varying vec3 vTint;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float dist = max(0.1, -mv.z);
          float size = max(uWorld, uPixel * dist * uPxFactor) * iScale;
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
          vUv = iUv.xy + uv * iUv.zw;
          vAlpha = iAlpha;
          vTint = iTint;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform float uUseTint;
        varying vec2 vUv; varying float vAlpha; varying vec3 vTint;
        void main() {
          vec4 c = texture2D(map, vUv);
          if (uUseTint > 0.5) c.rgb *= vTint;
          float a = c.a * vAlpha;
          if (a < 0.02) discard;
          gl_FragColor = vec4(c.rgb, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.geo = geo;
    this.n = 0;
    parent.add(this.mesh);
  }

  setPixelFactor(camera, heightPx) {
    this.material.uniforms.uPxFactor.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, heightPx);
  }

  begin() {
    this.n = 0;
  }

  push(x, y, z, u0, v0, uw, vh, alpha = 1, scale = 1, r = 1, g = 1, b = 1) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
    this.uv[4 * i] = u0; this.uv[4 * i + 1] = v0; this.uv[4 * i + 2] = uw; this.uv[4 * i + 3] = vh;
    this.alpha[i] = alpha;
    this.scale[i] = scale;
    this.tint[3 * i] = r; this.tint[3 * i + 1] = g; this.tint[3 * i + 2] = b;
  }

  end() {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (!this.n) return;
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges?.();
      a.needsUpdate = true;
    }
  }
}

// Weicher runder Lichtpunkt als Textur
export function glowTexture(inner = 'rgba(255,230,170,1)', outer = 'rgba(255,190,90,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.6)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
