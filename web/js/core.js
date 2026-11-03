// PullCraft core: pure logic (no DOM, no THREE) so it can be unit-tested in Node.

export const RENDER = { OPAQUE: 1, CUTOUT: 2, BLEND: 3 };
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- noise
export function hash2(x, z, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed), c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  const u = smooth(xf), v = smooth(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z, seed, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) { sum += valueNoise(x * f, z * f, seed + i * 101) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}

// ---------------------------------------------------------------- blocks
export class Registry {
  constructor(list) {
    this.list = list;
    this.defs = [null, ...list];
    this.index = {};
    list.forEach((b, i) => { this.index[b.id] = i + 1; });
    this.render = new Uint8Array(list.length + 1);
    this.emissive = new Uint8Array(list.length + 1);
    list.forEach((b, i) => {
      this.render[i + 1] = b.render === 'blend' ? RENDER.BLEND : b.render === 'cutout' ? RENDER.CUTOUT : RENDER.OPAQUE;
      this.emissive[i + 1] = b.emissive ? 1 : 0;
    });
  }
  id(name) { return this.index[name] || 0; }
  get placeable() { return this.list.filter((b) => b.placeable); }
}

// ---------------------------------------------------------------- layout (mirrors scripts/pullcraft.py)
export class Layout {
  constructor(w) {
    this.w = w;
    this.cell = w.plot_size + w.road;
    this.half = this.cell >> 1;
    this.pad = w.road >> 1;
  }
  cellOf(x, z) { return [Math.floor((x + this.half) / this.cell), Math.floor((z + this.half) / this.cell)]; }
  origin(gx, gz) { return [gx * this.cell - this.half + this.pad, gz * this.cell - this.half + this.pad]; }
  /** 0 = road, 1 = plot edge, 2 = plot interior */
  columnKind(x, z) {
    const lx = mod(x + this.half, this.cell), lz = mod(z + this.half, this.cell);
    const a = this.pad, b = this.pad + this.w.plot_size - 1;
    if (lx < a || lx > b || lz < a || lz > b) return 0;
    return lx === a || lx === b || lz === a || lz === b ? 1 : 2;
  }
}

// ---------------------------------------------------------------- terrain
export class Terrain {
  /** mode "world": flat city of (2*ring+1)^2 cells surrounded by hills/ocean. mode "flat": editor platform. */
  constructor(world, reg, { ring = 2, mode = 'world' } = {}) {
    this.w = world; this.reg = reg; this.mode = mode; this.layout = new Layout(world);
    this.ids = Object.fromEntries(['grass', 'dirt', 'stone', 'sand', 'snow', 'water', 'asphalt', 'plot_marker', 'oak_log', 'leaves'].map((n) => [n, reg.id(n)]));
    const L = this.layout;
    this.min = -ring * L.cell - L.half;
    this.max = ring * L.cell + L.half - 1;
  }
  cityDistance(x, z) {
    return Math.hypot(Math.max(this.min - x, 0, x - this.max), Math.max(this.min - z, 0, z - this.max));
  }
  surface(x, z) {
    const w = this.w;
    if (this.mode === 'flat') return w.ground;
    const d = this.cityDistance(x, z);
    if (d <= 0) return w.ground;
    const t = smooth(Math.min(1, d / 40));
    const n = fbm(x / 90, z / 90, w.seed, 4) * 0.7 + fbm(x / 23 + 50, z / 23, w.seed + 1, 2) * 0.3;
    return Math.round(w.ground + (w.ground + (n - 0.46) * 110 - w.ground) * t);
  }
  top(x, z, h) {
    const I = this.ids, w = this.w;
    if (this.mode === 'flat') {
      const inside = x >= 0 && x < w.plot_size && z >= 0 && z < w.plot_size;
      const ring = x >= -1 && x <= w.plot_size && z >= -1 && z <= w.plot_size;
      return !inside && ring ? I.plot_marker : I.grass;
    }
    if (this.cityDistance(x, z) <= 0) {
      const k = this.layout.columnKind(x, z);
      return k === 0 ? I.asphalt : k === 1 ? I.plot_marker : I.grass;
    }
    if (h <= w.sea + 1) return I.sand;
    if (h >= 64) return I.snow;
    if (h >= 54) return I.stone;
    return I.grass;
  }
  /** Block id at a world position (terrain only, no trees). */
  blockAt(x, y, z) {
    const h = this.surface(x, z), I = this.ids;
    if (y > h) return y <= this.w.sea ? I.water : 0;
    if (y === h) return this.top(x, z, h);
    if (y >= h - 3) return this.top(x, z, h) === I.sand ? I.sand : I.dirt;
    return I.stone;
  }
  /** Tree trunk height at (x,z), or 0. */
  treeAt(x, z) {
    if (this.mode !== 'world' || hash2(x, z, this.w.seed + 77) >= 0.012) return 0;
    if (this.cityDistance(x, z) < 10) return 0;
    const h = this.surface(x, z);
    if (h <= this.w.sea + 1 || h >= 54) return 0;
    return 4 + Math.floor(hash2(x, z, this.w.seed + 9) * 3);
  }
}

// ---------------------------------------------------------------- player block storage
export class BlockStore {
  constructor(S = 16) { this.S = S; this.chunks = new Map(); }
  static key(cx, cz) { return cx + '_' + cz; }
  pack(lx, y, lz) { return (y * this.S + lz) * this.S + lx; }
  get(x, y, z) {
    const S = this.S, cx = Math.floor(x / S), cz = Math.floor(z / S);
    const m = this.chunks.get(BlockStore.key(cx, cz));
    return m ? m.get(this.pack(x - cx * S, y, z - cz * S)) || 0 : 0;
  }
  set(x, y, z, id) {
    const S = this.S, cx = Math.floor(x / S), cz = Math.floor(z / S), k = BlockStore.key(cx, cz);
    let m = this.chunks.get(k);
    if (!m) { if (!id) return [cx, cz]; m = new Map(); this.chunks.set(k, m); }
    const p = this.pack(x - cx * S, y, z - cz * S);
    if (id) m.set(p, id); else m.delete(p);
    return [cx, cz];
  }
  loadChunk(cx, cz, flat) {
    const m = new Map();
    for (let i = 0; i < flat.length; i += 4) m.set(this.pack(flat[i], flat[i + 1], flat[i + 2]), flat[i + 3]);
    this.chunks.set(BlockStore.key(cx, cz), m);
  }
  dropChunk(cx, cz) { this.chunks.delete(BlockStore.key(cx, cz)); }
  forEachNear(cx, cz, fn) {
    const S = this.S;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const m = this.chunks.get(BlockStore.key(cx + dx, cz + dz));
      if (!m) continue;
      for (const [k, id] of m) {
        const lx = k % S, lz = Math.floor(k / S) % S, y = Math.floor(k / (S * S));
        fn((cx + dx) * S + lx, y, (cz + dz) * S + lz, id);
      }
    }
  }
  /** All blocks as [x,y,z,id] (world coordinates). */
  all() {
    const out = [], S = this.S;
    for (const [key, m] of this.chunks) {
      const [cx, cz] = key.split('_').map(Number);
      for (const [k, id] of m) out.push([cx * S + (k % S), Math.floor(k / (S * S)), cz * S + (Math.floor(k / S) % S), id]);
    }
    return out;
  }
  clear() { this.chunks.clear(); }
}

// ---------------------------------------------------------------- chunk generation
/** Fill a padded (S+2)x H x (S+2) voxel array for chunk (cx,cz): terrain, trees, player blocks. */
export function generateChunk(cx, cz, { world, terrain, store }) {
  const S = world.chunk, H = world.height, W = S + 2, I = terrain.ids;
  const vox = new Uint8Array(W * H * W);
  const at = (lx, y, lz) => (y * W + (lz + 1)) * W + (lx + 1);
  let maxY = 0;
  for (let lz = -1; lz <= S; lz++) for (let lx = -1; lx <= S; lx++) {
    const x = cx * S + lx, z = cz * S + lz, h = Math.min(terrain.surface(x, z), H - 1);
    const top = terrain.top(x, z, h), under = top === I.sand ? I.sand : I.dirt;
    for (let y = 0; y <= h; y++) vox[at(lx, y, lz)] = y === h ? top : y >= h - 3 ? under : I.stone;
    if (h < world.sea) { for (let y = h + 1; y <= world.sea; y++) vox[at(lx, y, lz)] = I.water; maxY = Math.max(maxY, world.sea); }
    maxY = Math.max(maxY, h);
  }
  const put = (lx, y, lz, id, onlyAir) => {
    if (lx < -1 || lx > S || lz < -1 || lz > S || y < 0 || y >= H) return;
    const i = at(lx, y, lz);
    if (onlyAir && vox[i]) return;
    vox[i] = id;
    if (y > maxY) maxY = y;
  };
  for (let lz = -3; lz <= S + 2; lz++) for (let lx = -3; lx <= S + 2; lx++) {
    const th = terrain.treeAt(cx * S + lx, cz * S + lz);
    if (!th) continue;
    const h = terrain.surface(cx * S + lx, cz * S + lz);
    for (let y = 1; y <= th; y++) put(lx, h + y, lz, I.oak_log, false);
    for (let dy = th - 2; dy <= th + 1; dy++) {
      const r = dy >= th ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        put(lx + dx, h + dy, lz + dz, I.leaves, true);
      }
    }
  }
  store.forEachNear(cx, cz, (wx, y, wz, id) => put(wx - cx * S, y, wz - cz * S, id, false));
  return { vox, maxY: Math.min(maxY, H - 1), S, H, W };
}

// ---------------------------------------------------------------- meshing
const FACES = [
  { d: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], s: 0.82, t: 1 },
  { d: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], s: 0.82, t: 1 },
  { d: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], s: 1.0, t: 0 },
  { d: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], s: 0.55, t: 2 },
  { d: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], s: 0.68, t: 1 },
  { d: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], s: 0.68, t: 1 },
];
export const ATLAS_COLS = 16;
export function atlasSize(blockCount, tile = 16) {
  const tiles = blockCount * 3;
  return { cols: ATLAS_COLS, rows: Math.ceil(tiles / ATLAS_COLS), tile, w: ATLAS_COLS * tile, h: Math.ceil(tiles / ATLAS_COLS) * tile };
}

class Buf {
  constructor() { this.pos = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
  quad(face, x, y, z, uv, shade) {
    for (let i = 0; i < 4; i++) {
      const c = face.c[i];
      this.pos.push(x + c[0], y + c[1], z + c[2]);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(shade, shade, shade);
    }
    this.idx.push(this.n, this.n + 1, this.n + 2, this.n, this.n + 2, this.n + 3);
    this.n += 4;
  }
  get empty() { return this.n === 0; }
  arrays() {
    return { pos: new Float32Array(this.pos), uv: new Float32Array(this.uv), col: new Float32Array(this.col),
      idx: this.n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx) };
  }
}

export function meshChunk(data, reg, atlas, cx, cz, seed = 0) {
  const { vox, maxY, S, H, W } = data;
  const at = (lx, y, lz) => (y * W + (lz + 1)) * W + (lx + 1);
  const bufs = { [RENDER.OPAQUE]: new Buf(), [RENDER.CUTOUT]: new Buf(), [RENDER.BLEND]: new Buf() };
  const e = 0.2 / atlas.w;
  const uvCache = new Map();
  const tileUV = (block, kind) => {
    const key = block * 3 + kind;
    let uv = uvCache.get(key);
    if (!uv) {
      const t = (block - 1) * 3 + kind, col = t % atlas.cols, row = Math.floor(t / atlas.cols);
      const u0 = col * atlas.tile / atlas.w + e, u1 = (col + 1) * atlas.tile / atlas.w - e;
      const v1 = 1 - (row * atlas.tile / atlas.h) - e, v0 = 1 - ((row + 1) * atlas.tile / atlas.h) + e;
      uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      uvCache.set(key, uv);
    }
    return uv;
  };
  for (let lz = 0; lz < S; lz++) for (let lx = 0; lx < S; lx++) for (let y = 0; y <= maxY; y++) {
    const b = vox[at(lx, y, lz)];
    if (!b) continue;
    const mode = reg.render[b];
    let shadeVar = null;
    for (const f of FACES) {
      const ny = y + f.d[1];
      if (ny < 0) continue;
      const n = ny >= H ? 0 : vox[at(lx + f.d[0], ny, lz + f.d[2])];
      if (n === b && mode !== RENDER.OPAQUE) continue;
      if (n && reg.render[n] === RENDER.OPAQUE) continue;
      if (n && mode === RENDER.OPAQUE && n === b) continue;
      if (shadeVar === null) shadeVar = 0.95 + 0.1 * hash2(cx * S + lx + y * 7, cz * S + lz - y * 3, seed);
      const shade = reg.emissive[b] ? 1 : f.s * shadeVar;
      bufs[mode].quad(f, lx, y, lz, tileUV(b, f.t), shade);
    }
  }
  const out = {};
  for (const [mode, key] of [[RENDER.OPAQUE, 'opaque'], [RENDER.CUTOUT, 'cutout'], [RENDER.BLEND, 'blend']]) {
    if (!bufs[mode].empty) out[key] = bufs[mode].arrays();
  }
  return out;
}

// ---------------------------------------------------------------- picking
/** Voxel DDA. isSolid(x,y,z) -> bool. Returns { pos, normal } or null. */
export function raycast(o, d, maxDist, isSolid) {
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const td = (v) => (v === 0 ? Infinity : Math.abs(1 / v));
  const tdx = td(d.x), tdy = td(d.y), tdz = td(d.z);
  const first = (p, c, s, dv) => (dv === 0 ? Infinity : (s > 0 ? c + 1 - p : p - c) * Math.abs(1 / dv));
  let tx = first(o.x, x, sx, d.x), ty = first(o.y, y, sy, d.y), tz = first(o.z, z, sz, d.z);
  let normal = [0, 0, 0], t = 0;
  while (t <= maxDist) {
    if ((normal[0] || normal[1] || normal[2]) && isSolid(x, y, z)) return { pos: [x, y, z], normal };
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; normal = [-sx, 0, 0]; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; normal = [0, -sy, 0]; }
    else { z += sz; t = tz; tz += tdz; normal = [0, 0, -sz]; }
  }
  return null;
}

// ---------------------------------------------------------------- plot document rules (mirrors Python)
const TEXT_RE = /^[\p{L}\p{N}_ .,'!&()\-:+#/?]*$/u;
export function validatePlot(doc, world, rules, placeable) {
  const errors = [];
  const err = (m) => { if (errors.length < 10) errors.push(m); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['Plot must be an object.'];
  if (doc.version !== 1) err('version must be 1');
  for (const [k, lim] of [['title', rules.max_title_length], ['description', rules.max_description_length]]) {
    const v = doc[k] ?? '';
    if (typeof v !== 'string' || v.length > lim || !TEXT_RE.test(v)) err(`${k}: plain text up to ${lim} characters`);
  }
  if (!Array.isArray(doc.blocks)) return [...errors, 'blocks must be a list'];
  if (doc.blocks.length > rules.max_blocks) return [...errors, `Too many blocks (${doc.blocks.length} > ${rules.max_blocks})`];
  const seen = new Set();
  doc.blocks.forEach((b, i) => {
    if (!Array.isArray(b) || b.length !== 4 || !b.slice(0, 3).every(Number.isInteger)) return err(`block #${i} malformed`);
    const [x, y, z, id] = b;
    if (x < 0 || z < 0 || y < 0 || x >= world.plot_size || z >= world.plot_size || y >= world.plot_height) err(`block #${i} outside plot`);
    if (!placeable.has(id)) err(`block #${i}: unknown block ${String(id).slice(0, 20)}`);
    const k = `${x},${y},${z}`;
    if (seen.has(k)) err(`block #${i}: duplicate position`);
    seen.add(k);
  });
  return errors;
}
