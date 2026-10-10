// Bereitet die Kenney-Assets und three.js für den Browser vor.
// Liest die ZIP-Dateien aus /Assets direkt (ohne externe Werkzeuge), kopiert nur
// die benötigten Modelle nach build/assets/<kit>/ und legt vorkomprimierte
// .gz-Varianten an, damit der Raspberry Pi beim Ausliefern nichts packen muss.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'Assets');
const outDir = path.join(root, 'build');

// --- Minimaler ZIP-Leser ----------------------------------------------------
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`Kein ZIP-Verzeichnis in ${file}`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Defekter ZIP-Eintrag');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} fehlt in ${file}`);
      const lp = e.local;
      const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Kompressionsverfahren ${e.method} nicht unterstützt`);
    },
  };
}

// --- Auswahl der benötigten Dateien ------------------------------------------
const GLB = 'Models/GLB format/';
const kits = [
  {
    zip: 'kenney_city-kit-suburban_20.zip', dest: 'suburban',
    files: [/^building-type-[a-u]\.glb$/, /^tree-(large|small)\.glb$/, /^planter\.glb$/, /^fence-low\.glb$/],
  },
  {
    zip: 'kenney_city-kit-commercial_2.1.zip', dest: 'commercial',
    files: [/^building-[a-n]\.glb$/, /^building-skyscraper-[a-e]\.glb$/, /^detail-overhang-wide\.glb$/,
      /^detail-parasol-[ab]\.glb$/],
  },
  {
    zip: 'kenney_city-kit-industrial_2.0.zip', dest: 'industrial',
    files: [/^building-[a-t]\.glb$/, /^chimney-(large|medium|small)\.glb$/, /^water-tower\.glb$/,
      /^detail-tank\.glb$/, /^solar-panel-landscape-group\.glb$/],
  },
  {
    zip: 'kenney_city-kit-roads.zip', dest: 'roads',
    files: [/^road-(straight|crossroad|intersection|bend|end|end-round|square|crossing)\.glb$/,
      /^tile-(low|high)\.glb$/, /^light-(square|curved)\.glb$/, /^construction-(cone|barrier)\.glb$/],
  },
  {
    zip: 'kenney_car-kit.zip', dest: 'cars',
    files: [/^(sedan|sedan-sports|suv|suv-luxury|taxi|van|hatchback-sports|delivery|truck|police)\.glb$/],
  },
  {
    zip: 'kenney_train-kit.zip', dest: 'trains',
    files: [/^train-electric-square-[abc]\.glb$/, /^train-tram-classic\.glb$/, /^spline-(segment|track)\.glb$/],
  },
  {
    zip: 'kenney_mini-characters.zip', dest: 'characters',
    files: [/^character-(female|male)-[a-f]\.glb$/],
  },
];

function writeFile(rel, data, compress) {
  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  if (compress) fs.writeFileSync(target + '.gz', zlib.gzipSync(data, { level: 9 }));
  return data.length;
}

fs.rmSync(path.join(outDir, 'assets'), { recursive: true, force: true });
fs.rmSync(path.join(outDir, 'vendor'), { recursive: true, force: true });

let total = 0;
const manifest = {};
for (const kit of kits) {
  const zip = readZip(path.join(assetDir, kit.zip));
  const models = [];
  for (const name of zip.names) {
    if (!name.startsWith(GLB) || name.slice(GLB.length).includes('/')) continue;
    const base = name.slice(GLB.length);
    if (!kit.files.some((re) => re.test(base))) continue;
    total += writeFile(`assets/${kit.dest}/${base}`, zip.read(name), true);
    models.push(base.replace(/\.glb$/, ''));
  }
  total += writeFile(`assets/${kit.dest}/Textures/colormap.png`, zip.read(`${GLB}Textures/colormap.png`), false);
  const license = zip.names.find((n) => /License\.txt$/i.test(n));
  if (license) writeFile(`assets/${kit.dest}/License.txt`, zip.read(license), false);
  models.sort();
  manifest[kit.dest] = models;
  console.log(`${kit.dest.padEnd(11)} ${String(models.length).padStart(3)} Modelle`);
}

// Emotes: Gedankenblasen-Stil (vector_style6) als Spritesheet + Koordinaten.
{
  const zip = readZip(path.join(assetDir, 'kenney_emotes-pack.zip'));
  const png = zip.read('Spritesheets/vector_style6.png');
  const xml = zip.read('Spritesheets/vector_style6.xml').toString('utf8');
  const frames = {};
  for (const m of xml.matchAll(/name="emote_([^".]+)\.png" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
    frames[m[1]] = [+m[2], +m[3], +m[4], +m[5]];
  }
  total += writeFile('assets/emotes/emotes.png', png, false);
  writeFile('assets/emotes/emotes.json', Buffer.from(JSON.stringify({ size: [192, 190], frames })), false);
  writeFile('assets/emotes/License.txt', zip.read('License.txt'), false);
  console.log(`emotes      ${String(Object.keys(frames).length).padStart(3)} Symbole`);
}

writeFile('assets/manifest.json', Buffer.from(JSON.stringify(manifest)), false);

// three.js: nur die benötigten Dateien (Modul-Build + Loader).
const threeDir = path.join(root, 'node_modules', 'three');
const threeFiles = [
  'build/three.module.min.js', 'build/three.core.min.js',
  'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js', 'LICENSE',
];
for (const f of threeFiles) {
  const src = path.join(threeDir, f);
  if (!fs.existsSync(src)) throw new Error(`three.js-Datei fehlt: ${src} (npm install ausführen)`);
  total += writeFile(`vendor/three/${f}`, fs.readFileSync(src), f.endsWith('.js'));
}

console.log(`Fertig: ${(total / 1048576).toFixed(1)} MB nach ${path.relative(root, outDir)}/`);
