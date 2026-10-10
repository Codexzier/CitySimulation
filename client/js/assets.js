// Lädt die Kenney-Modelle und bereitet sie für Instanced Rendering vor:
// alle Teilmeshes eines Modells werden zu einer Geometrie verschmolzen, jede
// Modellfamilie (Kit) teilt sich ein Material. Die Lauf-Animation der Figuren
// wird in wenige Einzelbilder „gebacken“, damit auch Figuren instanziert werden können.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// Maßstab je Kit (1 Kachel = 1 Einheit). Gebäude werden zusätzlich auf das Grundstück eingepasst.
const KIT_SCALE = {
  suburban: 1.18, commercial: 1.22, industrial: 1.0, roads: 1, cars: 0.2, trains: 0.42, characters: 0.38,
};
const FIT = { suburban: 1.85, commercial: 1.8, industrial: 1.9 };
const RECENTER = new Set(['suburban', 'commercial', 'industrial']);
export const WALK_FRAMES = 4;

export class Assets {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.models = new Map();
    this.materials = {};
    this.characters = [];
    const manager = new THREE.LoadingManager();
    // Die Texturen der GLB-Dateien werden nicht gebraucht (eigenes Material je Kit)
    manager.setURLModifier((url) => (url.endsWith('colormap.png') ? EMPTY_PNG : url));
    this.loader = new GLTFLoader(manager);
    this.texLoader = new THREE.TextureLoader();
  }

  async load() {
    const manifest = await (await fetch('assets/manifest.json')).json();
    const kits = Object.keys(manifest);
    const jobs = [];
    for (const kit of kits) for (const m of manifest[kit]) jobs.push([kit, m]);
    let done = 0;
    const total = jobs.length + kits.length + 1;
    const tick = () => this.onProgress(++done, total);

    await Promise.all(kits.map(async (kit) => {
      this.materials[kit] = await this.makeMaterial(kit);
      tick();
    }));

    const queue = jobs.slice();
    const worker = async () => {
      while (queue.length) {
        const [kit, name] = queue.shift();
        try {
          if (kit === 'characters') await this.loadCharacter(name);
          else await this.loadModel(kit, name);
        } catch (err) {
          console.warn('Modell konnte nicht geladen werden:', kit, name, err);
        }
        tick();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));

    const [emoteTex, emoteInfo] = await Promise.all([
      this.texLoader.loadAsync('assets/emotes/emotes.png'),
      fetch('assets/emotes/emotes.json').then((r) => r.json()),
    ]);
    emoteTex.colorSpace = THREE.SRGBColorSpace;
    emoteTex.magFilter = THREE.LinearFilter;
    emoteTex.minFilter = THREE.LinearFilter;
    emoteTex.generateMipmaps = false;
    this.emotes = { texture: emoteTex, ...emoteInfo };
    tick();
    return this;
  }

  async makeMaterial(kit) {
    const tex = await this.texLoader.loadAsync(`assets/${kit}/Textures/colormap.png`);
    tex.flipY = false; // glTF-Konvention
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    if (kit === 'suburban' || kit === 'commercial' || kit === 'industrial') {
      // Fenster (hellblaue Farbfelder) leuchten nachts warm
      mat.emissiveMap = this.windowMap(tex.image);
      mat.emissive = new THREE.Color(1, 1, 1);
      mat.emissiveIntensity = 0;
    }
    mat.name = kit;
    return mat;
  }

  windowMap(img) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const glass = b > 0.78 && r > 0.55 && g > 0.72 && b > r + 0.06;
      d[i] = glass ? 255 : 0;
      d[i + 1] = glass ? 200 : 0;
      d[i + 2] = glass ? 110 : 0;
      d[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  static cleanGeometry(g) {
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    if (g.attributes.normal) out.setAttribute('normal', g.attributes.normal);
    if (g.attributes.uv) out.setAttribute('uv', g.attributes.uv);
    if (g.index) out.setIndex(g.index);
    else out.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    if (!out.attributes.normal) out.computeVertexNormals();
    if (!out.attributes.uv) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    return out;
  }

  async loadModel(kit, name) {
    const gltf = await this.loader.loadAsync(`assets/${kit}/${name}.glb`);
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = Assets.cleanGeometry(o.geometry.clone());
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    });
    if (!parts.length) return;
    const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = new THREE.Vector3();
    bb.getSize(size);
    let scale = KIT_SCALE[kit] ?? 1;
    if (RECENTER.has(kit)) {
      const center = new THREE.Vector3();
      bb.getCenter(center);
      geometry.translate(-center.x, -bb.min.y, -center.z);
      const fit = FIT[kit] / Math.max(size.x, size.z);
      if (name.startsWith('building')) scale = Math.min(scale, fit);
    }
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const finalSize = new THREE.Vector3();
    geometry.boundingBox.getSize(finalSize);
    this.models.set(`${kit}/${name}`, { geometry, material: this.materials[kit], size: finalSize, kit });
  }

  async loadCharacter(name) {
    const gltf = await this.loader.loadAsync(`assets/characters/${name}.glb`);
    const root = gltf.scene;
    const mixer = new THREE.AnimationMixer(root);
    const bake = () => {
      root.updateMatrixWorld(true);
      const parts = [];
      const v = new THREE.Vector3();
      root.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.geometry;
        const pos = src.attributes.position;
        const out = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
          v.applyMatrix4(o.matrixWorld);
          out[3 * i] = v.x;
          out[3 * i + 1] = v.y;
          out[3 * i + 2] = v.z;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(out, 3));
        g.setAttribute('uv', src.attributes.uv);
        g.setIndex(src.index);
        g.computeVertexNormals();
        parts.push(g);
      });
      const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
      merged.scale(KIT_SCALE.characters, KIT_SCALE.characters, KIT_SCALE.characters);
      merged.computeBoundingSphere();
      return merged;
    };
    const clip = (n) => gltf.animations.find((a) => a.name === n);
    const frames = [];
    const walk = clip('walk');
    if (walk) {
      const action = mixer.clipAction(walk);
      action.play();
      for (let f = 0; f < WALK_FRAMES; f++) {
        mixer.setTime((walk.duration * f) / WALK_FRAMES);
        frames.push(bake());
      }
      action.stop();
    }
    const idleClip = clip('idle') || clip('static');
    let idle;
    if (idleClip) {
      const action = mixer.clipAction(idleClip);
      action.play();
      mixer.setTime(0.1);
      idle = bake();
      action.stop();
    } else {
      idle = bake();
    }
    while (frames.length < WALK_FRAMES) frames.push(idle);
    this.characters.push({ name: `characters/${name}`, frames, idle });
    this.models.set(`characters/${name}`, { geometry: idle, material: null, kit: 'characters' });
  }

  get(name) {
    return this.models.get(name);
  }

  character(name) {
    return this.characters.find((c) => c.name === name);
  }
}
