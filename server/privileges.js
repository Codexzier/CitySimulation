// Im Docker-Container startet der Server als root, macht das Datenverzeichnis
// für den Benutzer „node“ beschreibbar und gibt danach die Root-Rechte ab.
import fs from 'node:fs';
import path from 'node:path';

export function dropPrivileges(dir, user) {
  if (!user || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
  if (!line) {
    console.warn(`[rechte] Benutzer ${user} nicht gefunden – laufe weiter als root`);
    return false;
  }
  const [uid, gid] = line.split(':').slice(2, 4).map(Number);
  fs.mkdirSync(dir, { recursive: true });
  const walk = (p) => {
    fs.chownSync(p, uid, gid);
    if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  };
  walk(dir);
  process.setgid(gid);
  process.setuid(uid);
  return true;
}
