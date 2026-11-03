// PullCraft client: world viewer + plot editor + GitHub PR submission.
import { Registry, Terrain, Layout, BlockStore, raycast, validatePlot } from './core.js';
import { paintAtlas, blockIcon, createStage, VoxelWorld, FlyControls, makeHighlight, makeLabel } from './engine.js';
import { submitPlot, uploadPageUrl } from './github.js';
import { compileBlueprint, AI_PROMPT } from './blueprint.js';

const THREE = window.THREE;
const $ = (s) => document.querySelector(s);
const store_ls = {
  get(k, d) { try { const v = localStorage.getItem('pullcraft.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pullcraft.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/** Tiny DOM builder. Only textContent is ever used for data, so titles can't inject markup. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
const ago = (ts) => {
  if (!ts) return 'new';
  const s = Math.max(1, Date.now() / 1000 - ts);
  for (const [n, u] of [[86400 * 365, 'y'], [86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
};
const avatar = (user) => h('img', { src: `https://github.com/${encodeURIComponent(user)}.png?size=68`, alt: '', width: 34, height: 34, loading: 'lazy' });

async function getJSON(path, fresh = false) {
  const res = await fetch(path, fresh ? { cache: 'no-cache' } : undefined);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
function toast(msg, err = false, ms = 4200) {
  const t = h('div', { class: 'toast' + (err ? ' err' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
function fatal(msg) {
  const f = $('#fatal');
  f.hidden = false;
  f.replaceChildren(h('div', {}, h('h1', { text: 'PullCraft can’t start' }), h('p', { class: 'muted', text: msg })));
}

// ------------------------------------------------------------------ boot
let M, reg, W, rules, stage, controls, atlasInfo, highlight, layout;
let current = null; // { name, vw, store, terrain, ... }
const cams = {};

async function boot() {
  if (!window.THREE) return fatal('three.js failed to load.');
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return fatal('This browser does not support WebGL.');
  const canvas = $('#view');
  let blocksDoc;
  try {
    [M, blocksDoc] = await Promise.all([getJSON('world/manifest.json', true), getJSON('world/blocks.json')]);
  } catch (e) {
    return fatal('World data was not found. If you are running locally, build it first: python scripts/build_world.py --out site && python -m http.server -d site');
  }
  reg = new Registry(blocksDoc.blocks);
  if (JSON.stringify(M.palette) !== JSON.stringify(reg.list.map((b) => b.id))) return fatal('World data and block list are out of sync. Rebuild the site.');
  W = M.world; rules = M.rules; layout = new Layout(W);
  atlasInfo = paintAtlas(reg);
  stage = createStage(canvas);
  controls = new FlyControls(stage.camera, canvas);
  highlight = makeHighlight();
  stage.scene.add(highlight);
  controls.onLockChange = onLockChange;
  if ('ontouchstart' in window && !matchMedia('(pointer:fine)').matches) $('#touch-note').hidden = false;
  buildHotbar();
  wireUI();
  indexPlots();
  enterWorld();
  const hash = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  if (hash && plotByUser.has(hash)) setTimeout(() => flyToPlot(plotByUser.get(hash), false), 400);
  setInterval(poll, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ plots index
let plotByUser = new Map(), plotByCell = new Map();
function indexPlots() {
  plotByUser = new Map(M.plots.map((p) => [p.user.toLowerCase(), p]));
  plotByCell = new Map(M.plots.map((p) => [p.cell.join(','), p]));
  const s = $('#stats');
  s.hidden = false;
  s.textContent = `${M.stats.players.toLocaleString()} builders · ${M.stats.blocks.toLocaleString()} blocks`;
}

// ------------------------------------------------------------------ mode switching
function teardown() {
  if (!current) return;
  cams[current.name] = { pos: stage.camera.position.clone(), yaw: controls.yaw, pitch: controls.pitch };
  current.vw.destroy();
  current.extra?.forEach((o) => stage.scene.remove(o));
  highlight.visible = false;
  current = null;
}
function setFog(far) { stage.scene.fog.near = far * 0.55; stage.scene.fog.far = far; stage.camera.far = far + 40; stage.camera.updateProjectionMatrix(); }
function setMode(name) {
  document.body.classList.toggle('mode-world', name === 'world');
  document.body.classList.toggle('mode-build', name === 'build');
  $('#btn-world').classList.toggle('on', name === 'world');
  $('#btn-build').classList.toggle('on', name === 'build');
  $('#hotbar').hidden = $('#buildbar').hidden = name !== 'build';
  $('#hover').hidden = true;
  $('#start-title').textContent = name === 'world' ? 'Every building is a pull request.' : 'Build your plot.';
  $('#start-sub').textContent = name === 'world'
    ? 'Fly around the shared world. Build your own plot, open a pull request, and GitHub Actions adds it for everyone.'
    : `Your plot is ${W.plot_size}×${W.plot_height}×${W.plot_size} blocks. Left-click breaks, right-click places, middle-click picks, scroll or 1–9 changes block.`;
  $('#btn-play').textContent = name === 'world' ? 'Click to fly' : 'Click to build';
}

const loaded = new Set(), loading = new Set();
function enterWorld() {
  if (current?.name === 'world') return;
  teardown();
  const view = store_ls.get('view', 7);
  const store = new BlockStore(W.chunk);
  const terrain = new Terrain(W, reg, { ring: M.city_ring });
  const vw = new VoxelWorld({
    scene: stage.scene, reg, texture: atlasInfo.texture, atlas: atlasInfo.atlas, world: W, terrain, store, viewDistance: view,
    ensure: (cx, cz) => {
      const k = cx + '_' + cz, hash = M.chunks[k];
      if (!hash || loaded.has(k)) return true;
      if (!loading.has(k)) {
        loading.add(k);
        getJSON(`world/chunks/${k}.${hash}.json`)
          .then((c) => { store.loadChunk(c.cx, c.cz, c.b); loaded.add(k); })
          .catch(() => loaded.add(k))
          .finally(() => { loading.delete(k); vw.invalidateAround(cx, cz); });
      }
      return false;
    },
  });
  vw.onUnload = (cx, cz) => { store.dropChunk(cx, cz); loaded.delete(cx + '_' + cz); };
  loaded.clear(); loading.clear();
  const labels = new THREE.Group();
  stage.scene.add(labels);
  current = { name: 'world', vw, store, terrain, labels, labelMap: new Map(), extra: [labels] };
  setFog(view * W.chunk);
  setMode('world');
  const c = cams.world;
  if (c) { stage.camera.position.copy(c.pos); controls.yaw = c.yaw; controls.pitch = c.pitch; }
  else controls.place(new THREE.Vector3(0, W.ground + 24, 64), new THREE.Vector3(0, W.ground + 6, 0));
  controls.wheelSpeed = true;
}

// ------------------------------------------------------------------ editor
const HOTBAR_DEFAULT = ['stone_bricks', 'oak_planks', 'bricks', 'glass', 'quartz', 'oak_log', 'white_concrete', 'glowstone', 'leaves'];
let hotbar = store_ls.get('hotbar', HOTBAR_DEFAULT);
if (!Array.isArray(hotbar) || hotbar.length !== 9) hotbar = [...HOTBAR_DEFAULT];
let sel = 0, meta = store_ls.get('meta', { title: '', description: '', username: '' });
let undo = [], redo = [], batch = [], saveTimer = 0, blockCount = 0;
let code = null; // { format, source } while the plot is exactly what a blueprint compiled to
const EXAMPLES = [['Hilltop Castle (CSS)', 'examples/castle.css'], ['Tiny Cottage (CSS)', 'examples/cottage.css'], ['Glass Needle (XML)', 'examples/needle.xml'], ['Five-Tier Pagoda (XML)', 'examples/pagoda.xml']];
const icons = new Map();
const iconFor = (name) => { if (!icons.has(name)) icons.set(name, blockIcon(atlasInfo.canvas, atlasInfo.atlas, reg.id(name), 48)); const c = icons.get(name); const copy = document.createElement('canvas'); copy.width = copy.height = 48; copy.getContext('2d').drawImage(c, 0, 0); return copy; };

function buildHotbar() {
  hotbar = hotbar.map((n, i) => (reg.index[n] ? n : HOTBAR_DEFAULT[i]));
  const bar = $('#hotbar');
  bar.replaceChildren(...hotbar.map((name, i) => h('button', { class: 'slot' + (i === sel ? ' sel' : ''), title: reg.defs[reg.id(name)].name, onclick: () => selectSlot(i) }, h('i', { text: String(i + 1) }), iconFor(name))));
}
function selectSlot(i) { sel = (i + 9) % 9; buildHotbar(); }

const toWorldY = (y) => W.ground + 1 + y;
const inBounds = (x, y, z) => x >= 0 && z >= 0 && x < W.plot_size && z < W.plot_size && y >= W.ground + 1 && y < W.ground + 1 + W.plot_height;

function docToStore(doc) {
  const st = current.store;
  st.clear(); blockCount = 0;
  for (const [x, y, z, name] of doc.blocks) { const id = reg.id(name); if (id) { st.set(x, toWorldY(y), z, id); blockCount++; } }
  current.vw.remeshAll();
  updateMeter();
}
function exportDoc() {
  const blocks = current.store.all().filter(([x, y, z]) => inBounds(x, y, z))
    .map(([x, y, z, id]) => [x, y - W.ground - 1, z, reg.list[id - 1].id])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return { version: 1, title: meta.title, description: meta.description, blocks };
}
function updateMeter() {
  const used = blockCount / rules.max_blocks, m = $('#meter');
  m.style.setProperty('--used', Math.min(1, used));
  m.classList.toggle('warn', used > 0.8 && used <= 1); m.classList.toggle('over', used > 1);
  $('#meter-text').textContent = `${blockCount.toLocaleString()} / ${rules.max_blocks.toLocaleString()}`;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (current?.name === 'build') store_ls.set('draft', { ...exportDoc(), username: meta.username, code }); }, 700);
}
function edit(x, y, z, id) {
  const st = current.store, old = st.get(x, y, z);
  if (old === id) return false;
  code = null; // hand edits make the plot differ from its blueprint
  st.set(x, y, z, id); current.vw.setBlock(x, y, z, id);
  blockCount += (id ? 1 : 0) - (old ? 1 : 0);
  batch.push([x, y, z, old, id]);
  updateMeter(); scheduleSave();
  return true;
}
function commitBatch() { if (batch.length) { undo.push(batch); redo = []; batch = []; } }
function applyHistory(from, to, idx) {
  const b = from.pop();
  if (!b) return;
  code = null;
  for (const op of (idx === 3 ? [...b].reverse() : b)) {
    const [x, y, z] = op, id = op[idx], st = current.store, old = st.get(x, y, z);
    st.set(x, y, z, id); current.vw.setBlock(x, y, z, id);
    blockCount += (id ? 1 : 0) - (old ? 1 : 0);
  }
  to.push(b); updateMeter(); scheduleSave();
}
const doUndo = () => current?.name === 'build' && applyHistory(undo, redo, 3);
const doRedo = () => current?.name === 'build' && applyHistory(redo, undo, 4);

function actOnTarget(button) {
  const hit = pickEditor();
  if (!hit) return;
  if (button === 0) { if (current.store.get(...hit.pos)) edit(...hit.pos, 0); }
  else if (button === 1) { const id = current.store.get(...hit.pos); if (id) { hotbar[sel] = reg.list[id - 1].id; store_ls.set('hotbar', hotbar); buildHotbar(); } }
  else if (button === 2) {
    const p = hit.pos.map((v, i) => v + hit.normal[i]);
    if (!inBounds(...p)) { toast('That’s outside your plot.', true, 1200); return; }
    const c = stage.camera.position;
    if (Math.floor(c.x) === p[0] && Math.floor(c.z) === p[2] && (Math.floor(c.y) === p[1] || Math.floor(c.y - 1) === p[1])) return;
    edit(...p, reg.id(hotbar[sel]));
  }
}
function pickEditor() {
  return raycast(stage.camera.position, controls.forward(), 28, (x, y, z) => current.vw.isSolid(x, y, z));
}

async function enterBuild(remixUser) {
  if (current?.name === 'build' && !remixUser) return;
  teardown();
  const store = new BlockStore(W.chunk);
  const terrain = new Terrain(W, reg, { mode: 'flat' });
  const vw = new VoxelWorld({ scene: stage.scene, reg, texture: atlasInfo.texture, atlas: atlasInfo.atlas, world: W, terrain, store, viewDistance: 6 });
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W.plot_size, W.plot_height, W.plot_size)),
    new THREE.LineBasicMaterial({ color: 0xf2b134, transparent: true, opacity: 0.35 }));
  box.position.set(W.plot_size / 2, W.ground + 1 + W.plot_height / 2, W.plot_size / 2);
  stage.scene.add(box);
  current = { name: 'build', vw, store, terrain, extra: [box] };
  undo = []; redo = []; batch = [];
  setFog(120); setMode('build');
  const c = cams.build;
  if (c) { stage.camera.position.copy(c.pos); controls.yaw = c.yaw; controls.pitch = c.pitch; }
  else controls.place(new THREE.Vector3(W.plot_size / 2, W.ground + 18, W.plot_size + 22), new THREE.Vector3(W.plot_size / 2, W.ground + 6, W.plot_size / 2));
  controls.wheelSpeed = false;
  const draft = store_ls.get('draft', null);
  try {
    if (remixUser) { await loadPublished(remixUser); toast(`Loaded ${remixUser}’s plot as a starting point.`); }
    else if (draft?.blocks) { meta.title = draft.title || ''; meta.description = draft.description || ''; docToStore(draft); code = draft.code || null; if (draft.blocks.length) toast('Restored your unsaved draft.'); }
    else if (meta.username && plotByUser.has(meta.username.toLowerCase())) await loadPublished(meta.username);
  } catch { toast('Could not load that plot.', true); }
  updateMeter();
}
async function loadPublished(user) {
  const doc = await getJSON(`world/plots/${encodeURIComponent(user)}.json`, true);
  meta.title = doc.title || ''; meta.description = doc.description || '';
  docToStore(doc); undo = []; redo = []; code = null; scheduleSave();
}

// ------------------------------------------------------------------ world interactions
let hovered = null;
function pickWorld() {
  const hit = raycast(stage.camera.position, controls.forward(), 220, (x, y, z) => current.vw.isSolid(x, y, z));
  if (!hit) return null;
  const [x, , z] = hit.pos;
  if (current.terrain.cityDistance(x, z) > 0 || layout.columnKind(x, z) === 0) return null;
  const cell = layout.cellOf(x, z);
  if (cell[0] === 0 && cell[1] === 0) return { spawn: true, cell };
  return { cell, plot: plotByCell.get(cell.join(',')) || null };
}
function updateHover() {
  if (current?.name !== 'world' || !controls.locked) return;
  hovered = pickWorld();
  const card = $('#hover');
  if (!hovered) { card.hidden = true; return; }
  card.hidden = false;
  if (hovered.spawn) card.replaceChildren(h('b', { text: M.spawn.title }), h('span', { text: 'The shared plaza where every road begins.' }));
  else if (hovered.plot) {
    const p = hovered.plot;
    card.replaceChildren(h('b', { text: p.title || `${p.user}’s plot` }), h('span', { text: `by ${p.user} · ${p.blocks.toLocaleString()} blocks · ${ago(p.updated)}` }), h('br'), h('span', { text: 'Click to see its history' }));
  } else card.replaceChildren(h('b', { text: 'Free plot' }), h('span', { text: 'Submit a build and you’ll get the next free plot automatically.' }));
}
function updateLabels() {
  if (current?.name !== 'world') return;
  const { labels, labelMap } = current, cam = stage.camera.position;
  const want = [...M.plots.map((p) => ({ key: p.user, text: p.title || p.user, sub: p.title ? `by ${p.user}` : '', x: p.origin[0] + W.plot_size / 2, z: p.origin[1] - 2 })),
    { key: '__spawn', text: M.spawn.title, sub: '', x: 0, z: -W.plot_size / 2 - 2 }];
  for (const w of want) {
    const near = Math.hypot(w.x - cam.x, w.z - cam.z) < 120;
    let s = labelMap.get(w.key);
    if (near && !s) { s = makeLabel(w.text, w.sub); s.position.set(w.x, W.ground + 4.5, w.z); labels.add(s); labelMap.set(w.key, s); }
    if (s) s.visible = near;
  }
}
function flyToPlot(p, openCard = true) {
  if (current?.name !== 'world') enterWorld();
  const cx = p.origin[0] + W.plot_size / 2, cz = p.origin[1] + W.plot_size / 2;
  controls.flyTo(new THREE.Vector3(cx + 10, W.ground + 30, cz + 58), new THREE.Vector3(cx, W.ground + 12, cz));
  closeDrawer();
  if (openCard) openProfile(p.user);
  history.replaceState(null, '', '#' + encodeURIComponent(p.user));
}

// ------------------------------------------------------------------ drawers
function openDrawer(title, ...content) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').replaceChildren(...content);
  $('#drawer').hidden = false;
  document.body.classList.add('panel');
  controls.unlock();
}
function closeDrawer() { $('#drawer').hidden = true; document.body.classList.remove('panel'); }

function openBuilders() {
  const list = h('ul', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Search builders…', 'aria-label': 'Search builders' });
  const sort = h('select', { 'aria-label': 'Sort' }, h('option', { value: 'new', text: 'Newest' }), h('option', { value: 'size', text: 'Most blocks' }), h('option', { value: 'name', text: 'Name' }));
  const kind = h('select', { 'aria-label': 'Filter' }, h('option', { value: '', text: 'All builds' }), h('option', { value: 'blocks', text: 'Blocks' }), h('option', { value: 'css', text: 'CSS' }), h('option', { value: 'xml', text: 'XML' }));
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const items = M.plots.filter((p) => (!q || p.user.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)) && (!kind.value || (p.format || 'blocks') === kind.value));
    items.sort(sort.value === 'size' ? (a, b) => b.blocks - a.blocks : sort.value === 'name' ? (a, b) => a.user.localeCompare(b.user) : (a, b) => (b.updated || 0) - (a.updated || 0));
    list.replaceChildren(...items.slice(0, 200).map((p) => h('li', {}, h('button', { class: 'row', onclick: () => flyToPlot(p) }, avatar(p.user),
      h('span', { class: 't' }, h('b', { text: p.title || p.user }), h('small', { text: `${p.user} · ${p.blocks.toLocaleString()} blocks${p.format && p.format !== 'blocks' ? ' · ' + p.format.toUpperCase() : ''} · ${ago(p.updated)}` }))))));
    if (!items.length) list.replaceChildren(h('li', { class: 'muted', text: M.plots.length ? 'No builders match.' : 'No builders yet. Be the first!' }));
  };
  search.addEventListener('input', render); sort.addEventListener('change', render); kind.addEventListener('change', render);
  render();
  openDrawer(`Builders (${M.plots.length})`, search, h('div', { class: 'row-actions' }, sort, kind), list);
}
async function openRecent() {
  const list = h('ul', { class: 'list' }, h('li', { class: 'muted', text: 'Loading…' }));
  openDrawer('Recent builds', list);
  try {
    const events = await getJSON('world/metadata/recent.json', true);
    if (!events.length) return list.replaceChildren(h('li', { class: 'muted', text: 'Nothing merged yet.' }));
    list.replaceChildren(...events.map((e) => {
      const p = plotByUser.get(e.user.toLowerCase());
      return h('li', {}, h('button', { class: 'row', disabled: !p, onclick: () => p && flyToPlot(p) }, avatar(e.user),
        h('span', { class: 't' }, h('b', { text: `${e.user} ${e.status === 'A' ? 'claimed a plot' : 'updated their plot'}` }), h('small', { text: `${e.subject} · ${ago(e.ts)}` }))));
    }));
  } catch { list.replaceChildren(h('li', { class: 'muted', text: 'Could not load recent builds.' })); }
}
async function openProfile(user) {
  const body = h('div', {}, h('p', { class: 'muted', text: 'Loading…' }));
  openDrawer(user, body);
  let d;
  try { d = await getJSON(`world/players/${encodeURIComponent(user)}.json`, true); } catch { body.replaceChildren(h('p', { text: 'Could not load this profile.' })); return; }
  const repoUrl = `https://github.com/${M.repo}`;
  body.replaceChildren(
    h('div', { class: 'profile-head' }, avatar(user), h('div', {}, h('h3', { text: d.title || `${user}’s plot` }), h('a', { href: `https://github.com/${encodeURIComponent(user)}`, target: '_blank', rel: 'noopener', text: `@${user}` }))),
    d.description ? h('p', { text: d.description }) : null,
    h('dl', { class: 'kv' }, h('dt', { text: 'Blocks' }), h('dd', { text: d.blocks.toLocaleString() }), h('dt', { text: 'Plot' }), h('dd', { text: `cell ${d.cell[0]}, ${d.cell[1]}` }),
      h('dt', { text: 'Stored in' }), h('dd', { text: d.source === 'repo' ? 'their own repository (pinned)' : 'this repository' }), h('dt', { text: 'Last change' }), h('dd', { text: ago(d.updated) })),
    d.format && d.format !== 'blocks' ? h('p', {}, h('span', { class: 'badge', text: `BUILT WITH ${d.format.toUpperCase()}` })) : null,
    d.format && d.format !== 'blocks' ? sourceViewer(user) : null,
    h('div', { class: 'stack' },
      h('button', { class: 'primary', onclick: () => flyToPlot(plotByUser.get(user.toLowerCase()), false) }, 'Fly to plot'),
      h('button', { onclick: () => { closeDrawer(); enterBuild(user); } }, 'Remix in the editor'),
      M.repo ? h('a', { href: `${repoUrl}/commits/${M.branch}/plots/${encodeURIComponent(user)}.json`, target: '_blank', rel: 'noopener', text: 'Full history on GitHub' }) : null),
    h('h3', { text: 'Build history' }),
    d.history.length ? h('ol', { class: 'timeline' }, d.history.map((e) => h('li', {},
      h('span', { text: e.subject }), h('small', {}, `${new Date(e.ts * 1000).toLocaleDateString()} by ${e.author} `,
        M.repo ? h('a', { href: `${repoUrl}/commit/${e.sha}`, target: '_blank', rel: 'noopener', text: e.sha.slice(0, 7) }) : null,
        e.pr && M.repo ? [' · ', h('a', { href: `${repoUrl}/pull/${e.pr}`, target: '_blank', rel: 'noopener', text: `PR #${e.pr}` })] : null)))) : h('p', { class: 'muted', text: 'No history recorded.' }),
  );
}
function sourceViewer(user) {
  const box = h('div', {});
  const btn = h('button', { onclick: async () => {
    if (box.firstChild) { box.replaceChildren(); btn.textContent = 'View source'; return; }
    try { const doc = await getJSON(`world/plots/${encodeURIComponent(user)}.json`, true); box.replaceChildren(h('pre', { class: 'src', text: doc.source || '' })); btn.textContent = 'Hide source'; }
    catch { toast('Could not load the source.', true); }
  } }, 'View source');
  const remix = h('button', { onclick: async () => {
    try {
      const doc = await getJSON(`world/plots/${encodeURIComponent(user)}.json`, true);
      closeDrawer(); await enterBuild(user); code = { format: doc.format, source: doc.source }; openCode({ format: doc.format, source: doc.source });
    } catch { toast('Could not open the source.', true); }
  } }, 'Edit in the code editor');
  return h('div', {}, h('div', { class: 'row-actions' }, btn, remix), box);
}
function openHelp() {
  const view = h('input', { type: 'range', min: 3, max: 12, value: store_ls.get('view', 7), 'aria-label': 'View distance' });
  view.addEventListener('change', () => {
    store_ls.set('view', +view.value);
    if (current) { current.vw.viewDistance = Math.min(+view.value, current.name === 'build' ? 6 : 99); setFog(+view.value * W.chunk); }
  });
  openDrawer('How PullCraft works',
    h('p', { text: 'Every plot in this world is a JSON file in a GitHub repository. Building means opening a pull request that changes your file. A GitHub Actions workflow validates it, merges it, and rebuilds this site.' }),
    h('h3', { text: 'Controls' }),
    h('dl', { class: 'kv' }, h('dt', { text: 'Move' }), h('dd', { text: 'W A S D, Space up, Shift down, Q boost, scroll changes speed' }),
      h('dt', { text: 'Build' }), h('dd', { text: 'Left click break · right click place · middle click pick · 1–9 or scroll to switch · E opens the block palette · Ctrl+Z undo' }),
      h('dt', { text: 'Menu' }), h('dd', { text: 'Esc releases the mouse. F3 shows debug info.' })),
    h('label', { text: 'View distance' }), view,
    h('p', { class: 'hint', text: 'Lower it if the world feels slow. Applies to new chunks.' }),
    M.repo ? h('p', {}, h('a', { href: `https://github.com/${M.repo}`, target: '_blank', rel: 'noopener', text: 'Source and world data on GitHub' })) : null,
    h('p', { class: 'hint', text: `World revision ${M.revision} · built ${new Date(M.generated_at).toLocaleString()}. Textures are generated in your browser; three.js (MIT) is bundled.` }));
}

function openSubmit() {
  const doc = exportDoc();
  const errors = validatePlot(doc, W, rules, new Set(reg.placeable.map((b) => b.id)));
  const title = h('input', { type: 'text', maxlength: rules.max_title_length, value: meta.title, placeholder: 'Name your build' });
  const desc = h('input', { type: 'text', maxlength: rules.max_description_length, value: meta.description, placeholder: 'One line about it (optional)' });
  const user = h('input', { type: 'text', maxlength: 39, value: meta.username, placeholder: 'your-github-username', autocomplete: 'off' });
  const token = h('input', { type: 'password', placeholder: 'ghp_… (optional)', autocomplete: 'off' });
  const own = h('input', { type: 'checkbox' });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const out = h('div', {});
  const sync = () => { meta.title = title.value.trim(); meta.description = desc.value.trim(); meta.username = user.value.trim(); store_ls.set('meta', meta); scheduleSave(); };
  [title, desc, user].forEach((i) => i.addEventListener('input', sync));
  const fileDoc = () => { sync(); return { ...exportDoc() }; };
  const showErr = (msgs) => out.replaceChildren(h('ul', { class: 'errors' }, msgs.map((m) => h('li', { text: m }))));

  const create = h('button', { class: 'primary', onclick: async () => {
    const d = fileDoc(), errs = validatePlot(d, W, rules, new Set(reg.placeable.map((b) => b.id)));
    if (errs.length) return showErr(errs);
    if (!token.value.trim()) return showErr(['Paste a GitHub token, or use “Download plot file” below.']);
    if (!M.repo) return showErr(['This build has no repository configured.']);
    create.disabled = true;
    try {
      const r = await submitPlot({ token: token.value.trim(), upstream: M.repo, branch: M.branch, doc: d, code, ownRepo: own.checked, log: (m) => { status.textContent = m; } });
      token.value = ''; meta.username = r.login; store_ls.set('meta', meta);
      out.replaceChildren(h('div', { class: 'okbox' }, h('b', { text: 'Pull request opened.' }), h('br'), h('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.url }), h('p', { class: 'hint', text: 'GitHub Actions checks it within a minute. If it passes it merges automatically and your build goes live after the next deploy.' })));
      status.textContent = '';
    } catch (e) { showErr([e.message]); status.textContent = ''; }
    create.disabled = false;
  } }, 'Create pull request');

  const download = h('button', { onclick: () => {
    const d = fileDoc(), errs = validatePlot(d, W, rules, new Set(reg.placeable.map((b) => b.id)));
    if (errs.length) return showErr(errs);
    const a = h('a', { href: URL.createObjectURL(new Blob([code ? code.source : JSON.stringify(d)], { type: 'text/plain' })), download: `${user.value.trim() || 'your-github-username'}.${code ? code.format : 'json'}` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } }, 'Download plot file');
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileIn.addEventListener('change', async () => {
    try {
      const d = JSON.parse(await fileIn.files[0].text());
      const errs = validatePlot(d, W, rules, new Set(reg.placeable.map((b) => b.id)));
      if (errs.length) return showErr(errs);
      meta.title = d.title || ''; meta.description = d.description || ''; docToStore(d); undo = []; redo = []; code = null; scheduleSave(); closeDrawer(); toast('Plot loaded.');
    } catch { showErr(['That file isn’t a valid plot.']); }
  });

  openDrawer('Submit your build',
    errors.length ? h('ul', { class: 'errors' }, errors.map((m) => h('li', { text: m }))) : h('p', { class: 'hint', text: `${doc.blocks.length.toLocaleString()} blocks ready.` }),
    code ? h('div', { class: 'okbox' }, h('b', { text: `Submitting your ${code.format.toUpperCase()} blueprint` }), h('br'), h('span', { class: 'hint', text: `${code.source.length.toLocaleString()} characters of source. Visitors can read it and remix it from your plot.` })) : null,
    h('label', { text: 'Title' }), title, h('label', { text: 'Description' }), desc,
    h('label', { text: 'GitHub username' }), user,
    h('label', { text: 'GitHub token' }), token,
    h('p', { class: 'hint', text: 'Needs the public_repo scope. It goes only to api.github.com from your browser and is never stored. It lets PullCraft fork the world repo and open the pull request for you.' }),
    h('label', { class: 'check' }, own, h('span', { text: 'Keep my build in my own repository (pullcraft-builds). The world pins it to this exact commit.' })),
    h('div', { class: 'stack' }, create, status),
    h('h3', { text: 'No token?' }),
    h('p', { class: 'hint', text: `Download the file, then upload it as plots/<your-username>.${code ? code.format : 'json'} on GitHub. GitHub offers to fork and open the pull request for you.` }),
    h('div', { class: 'stack' }, download, M.repo ? h('a', { href: uploadPageUrl(M.repo, M.branch), target: '_blank', rel: 'noopener', text: 'Open the GitHub upload page' }) : null),
    out,
    h('h3', { text: 'Tools' }),
    h('div', { class: 'stack' }, h('button', { onclick: () => fileIn.click() }, 'Load a plot file…'),
      h('button', { onclick: () => { if (confirm('Remove every block from your plot?')) { batch = current.store.all().map(([x, y, z, id]) => [x, y, z, id, 0]); for (const [x, y, z] of batch) current.vw.setBlock(x, y, z, 0); blockCount = 0; code = null; commitBatch(); updateMeter(); scheduleSave(); closeDrawer(); } } }, 'Clear my plot'),
      fileIn));
}

// ------------------------------------------------------------------ code (CSS / XML blueprints)
function stripFences(t) { return t.split('\n').filter((l) => !l.trim().startsWith('```')).join('\n').trim(); }
function openCode(initial) {
  const saved = initial || store_ls.get('codetext', { format: 'css', source: '' });
  const fmt = h('select', { 'aria-label': 'Format' }, h('option', { value: 'css', text: 'CSS-style' }), h('option', { value: 'xml', text: 'XML' }));
  fmt.value = saved.format;
  const ta = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Blueprint source', placeholder: 'Pick an example, write your own, or paste what an AI wrote.' });
  ta.value = saved.source;
  const out = h('div', {});
  const ex = h('select', { 'aria-label': 'Examples' }, h('option', { value: '', text: 'Load an example…' }), EXAMPLES.map(([n, f]) => h('option', { value: f, text: n })));
  ex.addEventListener('change', async () => {
    if (!ex.value) return;
    try { ta.value = await (await fetch(ex.value)).text(); fmt.value = ex.value.split('.').pop(); out.replaceChildren(); } catch { toast('Could not load the example.', true); }
  });
  const preview = h('button', { class: 'primary', onclick: () => {
    const source = stripFences(ta.value);
    const format = source.startsWith('<') ? 'xml' : source.includes('{') ? 'css' : fmt.value;
    fmt.value = format;
    const res = compileBlueprint(format, source, { world: W, rules }, new Set(reg.placeable.map((b) => b.id)));
    store_ls.set('codetext', { format, source });
    if (res.errors.length) { out.replaceChildren(h('ul', { class: 'errors' }, res.errors.map((m) => h('li', { text: m })))); return; }
    meta.title = res.title || meta.title; meta.description = res.description || meta.description;
    docToStore({ blocks: res.blocks }); undo = []; redo = []; batch = [];
    code = { format, source }; scheduleSave();
    out.replaceChildren(h('div', { class: 'okbox' }, `Built ${res.blocks.length.toLocaleString()} blocks. Close this panel and fly around your plot, or edit and press Preview again.`));
  } }, 'Preview in my plot');
  const prompt = h('button', { onclick: async () => {
    const text = AI_PROMPT(W, reg.placeable.map((b) => b.id));
    try { await navigator.clipboard.writeText(text); toast('AI prompt copied. Paste it into any chat AI, add your idea, then paste the reply here.', false, 7000); }
    catch { ta.value = text; toast('Copy the prompt from the box.', false, 5000); }
  } }, 'Copy AI prompt');
  openDrawer('Build with code',
    h('p', { class: 'hint', text: 'Describe a building as shapes in CSS-style or XML. The same file is what you submit, so visitors can read and remix it.' }),
    h('div', { class: 'row-actions' }, fmt, ex), ta,
    h('div', { class: 'row-actions' }, preview, prompt), out,
    h('p', { class: 'hint' }, 'Shapes: box, shell, walls, pyramid, cylinder, sphere, dome. Properties: x y z, width height depth, block, repeat-x/y/z, gap-x/y/z. ', M.repo ? h('a', { href: `https://github.com/${M.repo}/blob/${M.branch}/docs/BLUEPRINTS.md`, target: '_blank', rel: 'noopener', text: 'Full reference' }) : null));
}

// ------------------------------------------------------------------ palette
function openPalette() {
  const grid = $('#palette-grid');
  grid.replaceChildren(...reg.placeable.map((b) => h('button', { class: 'pal', onclick: () => { hotbar[sel] = b.id; store_ls.set('hotbar', hotbar); buildHotbar(); closePalette(); } }, iconFor(b.id), h('span', { text: b.name }))));
  $('#palette').hidden = false; document.body.classList.add('panel');
  controls.unlock();
}
function closePalette() { $('#palette').hidden = true; document.body.classList.remove('panel'); }

// ------------------------------------------------------------------ live updates
async function poll() {
  if (document.hidden || !current) return;
  let next;
  try { next = await getJSON('world/manifest.json', true); } catch { return; }
  if (next.revision === M.revision) return;
  const prev = M;
  const changed = [...new Set([...Object.keys(prev.chunks), ...Object.keys(next.chunks)])].filter((k) => prev.chunks[k] !== next.chunks[k]);
  M = next; W = M.world; rules = M.rules;
  indexPlots();
  if (current.name === 'world') {
    const { vw, store } = current;
    for (const k of changed) {
      const [cx, cz] = k.split('_').map(Number);
      loaded.delete(k);
      if (!M.chunks[k]) store.dropChunk(cx, cz);
      if (vw.meshes.has(k) || M.chunks[k]) vw.invalidate(cx, cz);
      vw.invalidateAround(cx, cz);
    }
    if (next.city_ring !== prev.city_ring) { current.terrain = new Terrain(W, reg, { ring: M.city_ring }); vw.terrain = current.terrain; vw.remeshAll(); }
    for (const s of current.labelMap.values()) { current.labels.remove(s); s.material.map.dispose(); s.material.dispose(); }
    current.labelMap.clear();
  }
  const newest = [...next.plots].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  const t = h('div', { class: 'toast' }, `World updated${newest ? ` — latest: ${newest.user}` : ''} `, newest ? h('button', { onclick: () => flyToPlot(newest) }, 'Visit') : null);
  $('#toasts').append(t); setTimeout(() => t.remove(), 9000);
}

// ------------------------------------------------------------------ wiring
function onLockChange(locked) {
  document.body.classList.toggle('playing', locked);
  document.body.classList.toggle('unlocked', !locked);
  $('#crosshair').hidden = !locked;
  if (locked) { closeDrawer(); closePalette(); $('#hover').hidden = true; }
  else { commitBatch(); held = null; $('#hover').hidden = true; highlight.visible = false; }
}
let held = null, heldAt = 0;
function wireUI() {
  document.body.classList.add('unlocked');
  const canvas = $('#view');
  $('#btn-play').onclick = () => controls.lock();
  canvas.addEventListener('click', () => { if (!controls.locked) controls.lock(); });
  $('#btn-world').onclick = () => { closeDrawer(); enterWorld(); };
  $('#btn-build').onclick = () => { closeDrawer(); enterBuild(); };
  $('#btn-builders').onclick = openBuilders;
  $('#btn-recent').onclick = openRecent;
  $('#btn-help').onclick = openHelp;
  $('#drawer-close').onclick = closeDrawer;
  $('#palette-close').onclick = closePalette;
  $('#btn-palette').onclick = openPalette;
  $('#btn-code').onclick = () => openCode();
  $('#btn-undo').onclick = doUndo; $('#btn-redo').onclick = doRedo;
  $('#btn-submit').onclick = openSubmit;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (!controls.locked || !current) return;
    e.preventDefault();
    if (current.name === 'build') { actOnTarget(e.button); if (e.button !== 1) { held = e.button; heldAt = performance.now() + 260; } }
    else if (e.button === 0 && hovered?.plot) openProfile(hovered.plot.user);
  });
  window.addEventListener('mouseup', () => { held = null; commitBatch(); });
  canvas.addEventListener('wheel', (e) => { if (controls.locked && current?.name === 'build') selectSlot(sel + (e.deltaY > 0 ? 1 : -1)); }, { passive: true });
  window.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.code === 'F3') { e.preventDefault(); $('#debug').hidden = !$('#debug').hidden; return; }
    if (inField) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); doRedo(); return; }
    if (current?.name !== 'build') return;
    if (/^Digit[1-9]$/.test(e.code)) selectSlot(+e.code.slice(5) - 1);
    if (e.code === 'KeyE') { $('#palette').hidden ? openPalette() : closePalette(); }
  });
  window.addEventListener('beforeunload', () => { if (current?.name === 'build') store_ls.set('draft', { ...exportDoc(), username: meta.username, code }); });
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), hoverT = 0, labelT = 0, fps = 0, frames = 0, fpsT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  controls.update(dt);
  current.vw.update(stage.camera.position);
  if (held !== null && t > heldAt && current.name === 'build') { actOnTarget(held); heldAt = t + 110; }
  hoverT += dt; labelT += dt;
  if (hoverT > 0.12) {
    hoverT = 0;
    if (current.name === 'world') updateHover();
    else if (controls.locked) {
      const hit = pickEditor();
      highlight.visible = !!hit;
      if (hit) highlight.position.set(hit.pos[0] + 0.5, hit.pos[1] + 0.5, hit.pos[2] + 0.5);
    }
  }
  if (labelT > 0.5) { labelT = 0; updateLabels(); }
  stage.renderer.render(stage.scene, stage.camera);
  frames++; fpsT += dt;
  if (fpsT > 0.5) {
    fps = Math.round(frames / fpsT); frames = 0; fpsT = 0;
    if (!$('#debug').hidden) {
      const p = stage.camera.position, s = current.vw.stats;
      $('#debug').textContent = `${fps} fps\nxyz ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\nchunks ${s.chunks} (+${s.pending || 0})  tris ${s.triangles.toLocaleString()}\nrev ${M.revision}`;
    }
  }
}

boot().catch((e) => { console.error(e); fatal(String(e.message || e)); });
