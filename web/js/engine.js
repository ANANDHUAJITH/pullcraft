// PullCraft engine: THREE.js glue (texture atlas, chunk manager, fly controls). Uses global THREE.
import { RENDER, generateChunk, meshChunk, atlasSize, hash2 } from './core.js';

const THREE = window.THREE;

// ---------------------------------------------------------------- procedural texture atlas (no external assets)
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const clamp8 = (v) => Math.max(0, Math.min(255, v | 0));

function paintTile(ctx, x0, y0, def, kind) {
  const hex = kind === 0 ? def.top || def.color : kind === 2 ? def.bottom || def.color : def.side || def.color;
  const base = rgb(hex);
  const rnd = mulberry32(strHash(def.id) + kind * 7919);
  const rowShade = Array.from({ length: 16 }, () => 0.92 + rnd() * 0.16);
  const cell = Array.from({ length: 16 }, () => 0.82 + rnd() * 0.36);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let f = 1 + (rnd() - 0.5) * 0.12, a = 1, c = base;
    switch (def.pattern) {
      case 'grass':
        if (kind === 1) { const g = rgb(def.top); if (y < 3 || (y === 3 && rnd() < 0.5)) c = g; f = 1 + (rnd() - 0.5) * 0.2; }
        else f = 1 + (rnd() - 0.5) * 0.2;
        break;
      case 'cobble': f = cell[((x >> 2) + (y >> 2) * 4) % 16] * (x % 4 === 0 || y % 4 === 0 ? 0.82 : 1); break;
      case 'bricks': { const row = y >> 2, off = (row % 2) * 4; if (y % 4 === 0 || (x + off) % 8 === 0) { c = [185, 180, 168]; f = 1; } else f = 1 + (rnd() - 0.5) * 0.1; break; }
      case 'planks': f = rowShade[y >> 2] * (y % 4 === 0 ? 0.78 : 1) * ((x + (y >> 2) * 5) % 16 === 0 ? 0.85 : 1) * (1 + (rnd() - 0.5) * 0.05); break;
      case 'log':
        if (kind === 1) f = (x % 4 === 0 ? 0.82 : 1) * (1 + (rnd() - 0.5) * 0.18);
        else { const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)); f = d > 6.5 ? 0.62 : Math.floor(d) % 2 ? 0.9 : 1.05; if (d > 6.5) c = rgb(def.side); }
        break;
      case 'leaves': if (rnd() < 0.16) a = 0; f = 0.75 + rnd() * 0.5; break;
      case 'glass': a = x === 0 || y === 0 || x === 15 || y === 15 ? 0.85 : (x + y === 6 || x + y === 7 ? 0.7 : 0.26); f = 1; break;
      case 'water': a = 0.62; f = 1 + (rnd() - 0.5) * 0.08; break;
      case 'plate': f = x === 0 || y === 0 || x === 15 || y === 15 ? 0.82 : 1.06 + (rnd() - 0.5) * 0.04; break;
      case 'lamp': f = (x % 8 === 0 || y % 8 === 0 ? 0.8 : 1.05) * (1 + (rnd() - 0.5) * 0.06); break;
      case 'concrete': f = 1 + (rnd() - 0.5) * 0.04; break;
      default: break;
    }
    if (a === 0) continue;
    ctx.fillStyle = `rgba(${clamp8(c[0] * f)},${clamp8(c[1] * f)},${clamp8(c[2] * f)},${a})`;
    ctx.fillRect(x0 + x, y0 + y, 1, 1);
  }
}

export function paintAtlas(reg) {
  const a = atlasSize(reg.list.length);
  const canvas = document.createElement('canvas');
  canvas.width = a.w; canvas.height = a.h;
  const ctx = canvas.getContext('2d');
  reg.list.forEach((def, i) => {
    for (let kind = 0; kind < 3; kind++) {
      const t = i * 3 + kind;
      paintTile(ctx, (t % a.cols) * a.tile, Math.floor(t / a.cols) * a.tile, def, kind);
    }
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return { texture, atlas: a, canvas };
}

/** Draw one block as a 2D icon (for the hotbar / palette). */
export function blockIcon(atlasCanvas, atlas, index, size = 40) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const t = (index - 1) * 3 + 1;
  ctx.drawImage(atlasCanvas, (t % atlas.cols) * atlas.tile, Math.floor(t / atlas.cols) * atlas.tile, atlas.tile, atlas.tile, 0, 0, size, size);
  return c;
}

// ---------------------------------------------------------------- stage
export function createStage(canvas, { sky = 0x9fd0f5, fogNear = 90, fogFar = 220 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, fogNear, fogFar);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
  camera.rotation.order = 'YXZ';
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  return { renderer, scene, camera, resize };
}

// ---------------------------------------------------------------- chunk manager
export class VoxelWorld {
  constructor({ scene, reg, texture, atlas, world, terrain, store, viewDistance = 7, ensure = () => true }) {
    Object.assign(this, { scene, reg, atlas, world, terrain, store, viewDistance, ensure });
    this.S = world.chunk;
    this.meshes = new Map();
    this.dirty = new Set();
    this.group = new THREE.Group();
    scene.add(this.group);
    const common = { map: texture, vertexColors: true };
    this.materials = {
      opaque: new THREE.MeshBasicMaterial(common),
      cutout: new THREE.MeshBasicMaterial({ ...common, alphaTest: 0.5, side: THREE.DoubleSide }),
      blend: new THREE.MeshBasicMaterial({ ...common, transparent: true, depthWrite: false }),
    };
    this.stats = { chunks: 0, triangles: 0 };
  }
  key(cx, cz) { return cx + '_' + cz; }
  getBlock(x, y, z) { return y < 0 || y >= this.world.height ? 0 : this.store.get(x, y, z) || this.terrain.blockAt(x, y, z); }
  isSolid(x, y, z) { const id = this.getBlock(x, y, z); return id !== 0 && id !== this.terrain.ids.water; }
  invalidate(cx, cz) { this.dirty.add(this.key(cx, cz)); }
  invalidateAround(cx, cz) { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const k = this.key(cx + dx, cz + dz); if (this.meshes.has(k)) this.dirty.add(k); } }
  setBlock(x, y, z, id) {
    const S = this.S, [cx, cz] = this.store.set(x, y, z, id);
    this.invalidate(cx, cz);
    const lx = x - cx * S, lz = z - cz * S;
    if (lx === 0) this.invalidate(cx - 1, cz); if (lx === S - 1) this.invalidate(cx + 1, cz);
    if (lz === 0) this.invalidate(cx, cz - 1); if (lz === S - 1) this.invalidate(cx, cz + 1);
  }
  remeshAll() { for (const k of this.meshes.keys()) this.dirty.add(k); }
  buildChunk(cx, cz) {
    const k = this.key(cx, cz);
    const data = generateChunk(cx, cz, { world: this.world, terrain: this.terrain, store: this.store });
    const parts = meshChunk(data, this.reg, this.atlas, cx, cz, this.world.seed);
    this.dispose(k);
    const group = new THREE.Group();
    group.position.set(cx * this.S, 0, cz * this.S);
    let tris = 0;
    for (const [name, arr] of Object.entries(parts)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr.pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(arr.uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(arr.col, 3));
      g.setIndex(new THREE.BufferAttribute(arr.idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.materials[name]);
      if (name === 'blend') m.renderOrder = 2;
      group.add(m);
      tris += arr.idx.length / 3;
    }
    this.group.add(group);
    this.meshes.set(k, { group, tris, cx, cz });
    this.dirty.delete(k);
  }
  dispose(k) {
    const m = this.meshes.get(k);
    if (!m) return;
    this.group.remove(m.group);
    m.group.children.forEach((c) => c.geometry.dispose());
    this.meshes.delete(k);
  }
  /** Mesh missing/dirty chunks near the camera within a time budget; unload far ones. */
  update(cam, budgetMs = 7) {
    const S = this.S, ccx = Math.floor(cam.x / S), ccz = Math.floor(cam.z / S), R = this.viewDistance;
    const t0 = performance.now();
    const want = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R + 1) continue;
      const k = this.key(ccx + dx, ccz + dz);
      if (!this.meshes.has(k) || this.dirty.has(k)) want.push([d2, ccx + dx, ccz + dz, k]);
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz, k] of want) {
      if (performance.now() - t0 > budgetMs && this.meshes.size > 0) break;
      if (!this.ensure(cx, cz)) continue;
      this.buildChunk(cx, cz);
      this.dirty.delete(k);
    }
    for (const [k, m] of this.meshes) {
      if (Math.abs(m.cx - ccx) > R + 2 || Math.abs(m.cz - ccz) > R + 2) { this.dispose(k); this.dirty.delete(k); this.onUnload?.(m.cx, m.cz); }
    }
    let tris = 0;
    for (const m of this.meshes.values()) tris += m.tris;
    this.stats = { chunks: this.meshes.size, triangles: tris, pending: want.length };
  }
  destroy() {
    for (const k of [...this.meshes.keys()]) this.dispose(k);
    this.scene.remove(this.group);
    Object.values(this.materials).forEach((m) => m.dispose());
  }
}

// ---------------------------------------------------------------- creative-mode fly camera
export class FlyControls {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.yaw = 0; this.pitch = 0; this.keys = new Set();
    this.speed = 14; this.locked = false; this.tween = null;
    this.onLockChange = () => {};
    this.enabled = true;
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === dom; this.keys.clear(); this.onLockChange(this.locked); });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0022));
    });
    window.addEventListener('keydown', (e) => { if (this.locked && !e.metaKey && !e.ctrlKey) { this.keys.add(e.code); if (e.code === 'Space') e.preventDefault(); } });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('wheel', (e) => { if (this.locked && this.wheelSpeed) { this.speed = Math.max(4, Math.min(60, this.speed * (e.deltaY < 0 ? 1.15 : 0.87))); } }, { passive: true });
    this.wheelSpeed = true;
  }
  lock() { this.dom.requestPointerLock?.(); }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  place(pos, lookAt) {
    this.camera.position.copy(pos);
    if (lookAt) this.lookAt(lookAt);
    this.apply();
  }
  lookAt(p) {
    const d = new THREE.Vector3().subVectors(p, this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }
  flyTo(pos, lookAt, ms = 1100) {
    this.tween = { t: 0, ms, from: this.camera.position.clone(), to: pos.clone(), yaw0: this.yaw, pitch0: this.pitch };
    const save = { y: this.yaw, p: this.pitch, pos: this.camera.position.clone() };
    this.camera.position.copy(pos); this.lookAt(lookAt);
    this.tween.yaw1 = this.yaw; this.tween.pitch1 = this.pitch;
    this.camera.position.copy(save.pos); this.yaw = save.y; this.pitch = save.p;
  }
  apply() { this.camera.rotation.set(this.pitch, this.yaw, 0); }
  forward() { return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }
  update(dt) {
    const tw = this.tween;
    if (tw) {
      tw.t += dt * 1000;
      const k = Math.min(1, tw.t / tw.ms), e = k * k * (3 - 2 * k);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      let dy = tw.yaw1 - tw.yaw0; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw = tw.yaw0 + dy * e; this.pitch = tw.pitch0 + (tw.pitch1 - tw.pitch0) * e;
      if (k >= 1) this.tween = null;
    } else if (this.locked && this.enabled) {
      const k = this.keys, boost = k.has('KeyQ') ? 3 : 1;
      let f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const v = (k.has('Space') ? 1 : 0) - (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyC') ? 1 : 0);
      const len = Math.hypot(f, s) || 1, sp = this.speed * boost * dt;
      this.camera.position.x += (-Math.sin(this.yaw) * f + Math.cos(this.yaw) * s) / len * sp;
      this.camera.position.z += (-Math.cos(this.yaw) * f - Math.sin(this.yaw) * s) / len * sp;
      this.camera.position.y += v * sp;
    }
    this.apply();
  }
}

export function makeHighlight() {
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
  const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x111111 }));
  m.visible = false;
  return m;
}

export function makeLabel(text, sub = '') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(19,22,32,0.82)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#f2b134'; ctx.fillRect(0, 0, 8, 128);
  ctx.fillStyle = '#f4f6fb'; ctx.font = '600 48px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 22), 28, sub ? 44 : 64);
  if (sub) { ctx.fillStyle = '#a9b3c9'; ctx.font = '32px system-ui, sans-serif'; ctx.fillText(sub.slice(0, 30), 28, 94); }
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, transparent: true }));
  sprite.scale.set(10, 2.5, 1);
  return sprite;
}

export { RENDER, hash2 };
