import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Registry, Layout, Terrain, BlockStore, generateChunk, meshChunk, atlasSize, raycast, hash2, fbm, validatePlot } from '../web/js/core.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const blocks = JSON.parse(fs.readFileSync(new URL('../data/blocks.json', import.meta.url))).blocks;
const reg = new Registry(blocks);
const W = cfg.world;

test('noise is deterministic and bounded', () => {
  assert.equal(hash2(5, -9, 1), hash2(5, -9, 1));
  for (let i = 0; i < 500; i++) { const v = fbm(i * 0.37, -i * 0.11, 7); assert.ok(v >= 0 && v <= 1); }
});

test('layout matches the Python builder', () => {
  const L = new Layout(W);
  assert.deepEqual(L.origin(0, 0), [-16, -16]);
  assert.equal(L.origin(1, 0)[0], 20);
  assert.deepEqual(L.cellOf(-16, -16), [0, 0]);
  assert.deepEqual(L.cellOf(-19, 0), [-1, 0]);
  assert.equal(L.columnKind(-18, 0), 0);
  assert.equal(L.columnKind(-16, 0), 1);
  assert.equal(L.columnKind(0, 0), 2);
  assert.equal(L.columnKind(15, 0), 1);
  assert.equal(L.columnKind(16, 0), 0);
});

test('terrain is flat in the city and varies outside', () => {
  const t = new Terrain(W, reg, { ring: 2 });
  assert.equal(t.surface(0, 0), W.ground);
  assert.equal(t.surface(t.max, t.max), W.ground);
  const hs = new Set();
  for (let i = 0; i < 40; i++) hs.add(t.surface(t.max + 60 + i * 9, 31 + i * 7));
  assert.ok(hs.size > 5);
  assert.equal(t.blockAt(0, W.ground, 0), reg.id('grass'));
  assert.equal(t.blockAt(-18, W.ground, 0), reg.id('asphalt'));
  assert.equal(t.blockAt(0, W.ground + 1, 0), 0);
});

test('block store handles negative coordinates', () => {
  const s = new BlockStore(16);
  for (const [x, y, z] of [[-1, 5, -1], [-16, 0, 17], [15, 127, -17], [100, 3, 100]]) {
    s.set(x, y, z, 9);
    assert.equal(s.get(x, y, z), 9);
  }
  assert.equal(s.all().length, 4);
  s.set(-1, 5, -1, 0);
  assert.equal(s.get(-1, 5, -1), 0);
});

test('meshing a single block on a flat plane emits exactly its visible faces', () => {
  const flat = new Terrain(W, reg, { mode: 'flat' });
  const store = new BlockStore(16);
  store.set(3, W.ground + 1, 3, reg.id('stone'));
  const data = generateChunk(0, 0, { world: W, terrain: flat, store });
  const mesh = meshChunk(data, reg, atlasSize(blocks.length), 0, 0, 1);
  const quads = mesh.opaque.pos.length / 12;
  assert.equal(quads, 16 * 16 - 1 + 5); // 255 visible ground tops (one is covered) + 5 block faces
  assert.equal(mesh.blend, undefined);
  assert.ok(mesh.opaque.uv.every((v) => v >= 0 && v <= 1));
});

test('glass between blocks keeps neighbouring faces; water only shows surface', () => {
  const flat = new Terrain(W, reg, { mode: 'flat' });
  const store = new BlockStore(16);
  store.set(2, W.ground + 1, 2, reg.id('glass'));
  store.set(3, W.ground + 1, 2, reg.id('stone'));
  const mesh = meshChunk(generateChunk(0, 0, { world: W, terrain: flat, store }), reg, atlasSize(blocks.length), 0, 0);
  assert.equal(mesh.blend.pos.length / 12, 4); // glass: top and three sides (bottom on grass, +X touches stone)
  assert.equal(mesh.opaque.pos.length / 12, 256 - 1 + 5); // stone still shows the face that touches glass
});

test('raycast hits the first solid voxel and reports the face normal', () => {
  const solid = (x, y, z) => y === 10 && x === 2 && z === 2;
  const hit = raycast({ x: 2.5, y: 15.5, z: 2.5 }, { x: 0, y: -1, z: 0 }, 20, solid);
  assert.deepEqual(hit.pos, [2, 10, 2]);
  assert.deepEqual(hit.normal, [0, 1, 0]);
  assert.equal(raycast({ x: 0.5, y: 15.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20, solid), null);
});

test('plot validation mirrors server rules', () => {
  const placeable = new Set(reg.placeable.map((b) => b.id));
  const ok = { version: 1, title: 'Hi', blocks: [[0, 0, 0, 'stone']] };
  assert.deepEqual(validatePlot(ok, W, cfg.rules, placeable), []);
  for (const bad of [
    { ...ok, blocks: [[32, 0, 0, 'stone']] }, { ...ok, blocks: [[0, 0, 0, 'water']] },
    { ...ok, blocks: [[0, 0, 0, 'stone'], [0, 0, 0, 'dirt']] }, { ...ok, title: '<b>' }, { ...ok, version: 2 },
  ]) assert.ok(validatePlot(bad, W, cfg.rules, placeable).length > 0);
});

test('client decodes what the Python builder wrote', { skip: !process.env.SITE }, () => {
  const site = process.env.SITE;
  const m = JSON.parse(fs.readFileSync(`${site}/world/manifest.json`));
  assert.deepEqual(m.palette, blocks.map((b) => b.id));
  const store = new BlockStore(m.world.chunk);
  let n = 0;
  for (const [key, hash] of Object.entries(m.chunks)) {
    const c = JSON.parse(fs.readFileSync(`${site}/world/chunks/${key}.${hash}.json`));
    store.loadChunk(c.cx, c.cz, c.b);
    n += c.b.length / 4;
    const terrain = new Terrain(m.world, reg, { ring: m.city_ring });
    const mesh = meshChunk(generateChunk(c.cx, c.cz, { world: m.world, terrain, store }), reg, atlasSize(blocks.length), c.cx, c.cz);
    assert.ok(mesh.opaque.pos.length > 0);
  }
  assert.equal(store.all().length, n);
  assert.ok(n >= m.stats.blocks);
});
