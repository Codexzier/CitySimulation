// Kamera: Vogelperspektive, Zoom zur Mausposition, Verschieben, Drehen, Touch.
import * as THREE from 'three';
import { clamp, lerp } from './util.js';

const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class CameraRig {
  constructor(camera, dom, onClick) {
    this.camera = camera;
    this.dom = dom;
    this.onClick = onClick;
    this.target = new THREE.Vector3();
    this.distance = 80;
    this.yaw = -0.6;
    this.pitch = 1.0;
    this.minDist = 3;
    this.maxDist = 200;
    this.bounds = 40;
    this.anim = null;
    this.follow = null;
    this.ray = new THREE.Raycaster();
    this.pointers = new Map();
    this.userMoved = false;
    this.bind();
  }

  setBounds(citySize) {
    this.bounds = citySize * 0.6;
    this.maxDist = citySize * 2.6;
  }

  // Ganze Stadt aus der Vogelperspektive
  overview(citySize, aspect, scale = 1, animate = false) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = (citySize * 0.62) / Math.tan(fov / 2) / Math.min(1, aspect * 0.95);
    const goal = { target: new THREE.Vector3(0, 0, 0), distance: fit * scale, yaw: -0.6, pitch: 0.98 };
    this.follow = null;
    if (animate) this.anim = { from: this.state(), to: goal, t: 0 };
    else this.apply(goal);
  }

  state() {
    return { target: this.target.clone(), distance: this.distance, yaw: this.yaw, pitch: this.pitch };
  }

  apply(s) {
    this.target.copy(s.target);
    this.distance = s.distance;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.updateCamera();
  }

  focus(x, z, distance = 14) {
    this.anim = {
      from: this.state(),
      to: { target: new THREE.Vector3(x, 0, z), distance: Math.min(this.distance, distance), yaw: this.yaw, pitch: Math.min(this.pitch, 0.9) },
      t: 0,
    };
  }

  updateCamera() {
    this.distance = clamp(this.distance, this.minDist, this.maxDist);
    this.pitch = clamp(this.pitch, 0.35, 1.52);
    this.target.x = clamp(this.target.x, -this.bounds, this.bounds);
    this.target.z = clamp(this.target.z, -this.bounds, this.bounds);
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(0.1, this.distance * 0.02);
    this.camera.far = this.distance * 12 + 200;
    this.camera.updateProjectionMatrix();
  }

  update(dt, followPos) {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / 0.9);
      const e = 1 - (1 - a.t) ** 3;
      this.target.lerpVectors(a.from.target, a.to.target, e);
      this.distance = lerp(a.from.distance, a.to.distance, e);
      this.yaw = lerp(a.from.yaw, a.to.yaw, e);
      this.pitch = lerp(a.from.pitch, a.to.pitch, e);
      if (a.t >= 1) this.anim = null;
    } else if (this.follow && followPos) {
      this.target.x = lerp(this.target.x, followPos[0], Math.min(1, dt * 4));
      this.target.z = lerp(this.target.z, followPos[1], Math.min(1, dt * 4));
    }
    this.updateCamera();
  }

  groundAt(clientX, clientY, out = new THREE.Vector3()) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.intersectPlane(ground, out);
  }

  rayAt(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray;
  }

  // Zoomt so, dass der Punkt unter dem Mauszeiger an derselben Stelle bleibt.
  zoomAt(clientX, clientY, factor) {
    this.anim = null;
    this.userMoved = true;
    const before = this.groundAt(clientX, clientY);
    this.distance = clamp(this.distance * factor, this.minDist, this.maxDist);
    this.updateCamera();
    const after = this.groundAt(clientX, clientY);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
      this.updateCamera();
    }
  }

  bind() {
    const d = this.dom;
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomAt(e.clientX, e.clientY, Math.exp(clamp(delta, -300, 300) * 0.0015));
    }, { passive: false });

    d.addEventListener('pointerdown', (e) => {
      d.setPointerCapture(e.pointerId);
      const mode = e.button === 2 || e.shiftKey || e.ctrlKey ? 'rotate' : 'pan';
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, mode, grab: this.groundAt(e.clientX, e.clientY) });
      this.anim = null;
      if (this.pointers.size === 2) this.pinch = this.pinchState();
    });
    d.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 4) p.dragged = true;
      if (this.pointers.size === 2) {
        const now = this.pinchState();
        if (this.pinch && now) {
          const mid = now.mid;
          this.zoomAt(mid.x, mid.y, this.pinch.dist / Math.max(10, now.dist));
          this.yaw -= now.angle - this.pinch.angle;
          this.updateCamera();
        }
        this.pinch = now;
        return;
      }
      if (!p.dragged) return;
      this.userMoved = true;
      this.follow = null;
      if (p.mode === 'rotate') {
        this.yaw -= dx * 0.006;
        this.pitch += dy * 0.005;
        this.updateCamera();
      } else if (p.grab) {
        const now = this.groundAt(e.clientX, e.clientY);
        if (now) {
          this.target.x += p.grab.x - now.x;
          this.target.z += p.grab.z - now.z;
          this.updateCamera();
        }
      }
    });
    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (p && !p.dragged && e.type === 'pointerup' && e.button !== 2) this.onClick?.(e.clientX, e.clientY);
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const step = this.distance * 0.06;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      let used = true;
      switch (e.key) {
        case 'ArrowUp': case 'w': this.target.x += fx * step; this.target.z += fz * step; break;
        case 'ArrowDown': case 's': this.target.x -= fx * step; this.target.z -= fz * step; break;
        case 'ArrowLeft': case 'a': this.target.x -= rx * step; this.target.z -= rz * step; break;
        case 'ArrowRight': case 'd': this.target.x += rx * step; this.target.z += rz * step; break;
        case 'q': this.yaw += 0.08; break;
        case 'e': this.yaw -= 0.08; break;
        case '+': this.distance *= 0.88; break;
        case '-': this.distance *= 1.12; break;
        default: used = false;
      }
      if (used) {
        this.userMoved = true;
        this.follow = null;
        this.anim = null;
        this.updateCamera();
      }
    });
  }

  pinchState() {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return null;
    const [a, b] = ps;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
}
