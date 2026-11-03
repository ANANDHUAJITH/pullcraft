// Blueprint compiler (CSS-style and XML sources -> blocks). Mirror of scripts/blueprint.py;
// tests/core.test.mjs checks both produce identical output on every example and fixture.
const MAX_SOURCE = 40000, MAX_OPS = 2000, MAX_INSTANCES = 20000, MAX_CELLS = 2000000, MAX_GROUP_DEPTH = 5, MAX_ERRORS = 20;
export const SHAPES = ['box', 'shell', 'walls', 'pyramid', 'cylinder', 'sphere', 'dome'];
const ALIAS = { w: 'width', h: 'height', d: 'depth', repeat: 'repeat-x', gap: 'gap-x' };
const DEFAULTS = { x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1, 'repeat-x': 1, 'repeat-y': 1, 'repeat-z': 1, 'gap-x': 0, 'gap-y': 0, 'gap-z': 0 };
const RANGES = { x: [-256, 256], y: [-256, 256], z: [-256, 256], width: [1, 256], height: [1, 256], depth: [1, 256],
  'repeat-x': [1, 1000], 'repeat-y': [1, 1000], 'repeat-z': [1, 1000], 'gap-x': [0, 256], 'gap-y': [0, 256], 'gap-z': [0, 256] };
const INT_RE = /^-?\d{1,4}$/;
const VAR_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*?))?\s*\)$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TEXT_RE = /^[\p{L}\p{N}_ .,'!&()\-:+#/?]*$/u;

function makeErrors() {
  const items = [];
  const err = (m) => { if (items.length < MAX_ERRORS) items.push(m); };
  err.items = items;
  return err;
}

function makeOp(props, where, err) {
  const known = new Set([...Object.keys(DEFAULTS), 'shape', 'block']);
  const unknown = Object.keys(props).filter((k) => !known.has(k)).sort();
  if (unknown.length) { err(`${where}: unknown property '${unknown[0].slice(0, 30)}'`); return null; }
  const shape = props.shape ?? 'box';
  if (!SHAPES.includes(shape)) { err(`${where}: shape must be one of ${SHAPES.join(', ')}`); return null; }
  const block = props.block;
  if (!block) { err(`${where}: missing 'block'`); return null; }
  const op = { shape, block, where };
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const raw = props[key];
    if (raw === undefined) { op[key] = def; continue; }
    if (!INT_RE.test(raw)) { err(`${where}: ${key} must be a whole number, got '${raw.slice(0, 20)}'`); return null; }
    const n = parseInt(raw, 10), [lo, hi] = RANGES[key];
    if (n < lo || n > hi) { err(`${where}: ${key} must be between ${lo} and ${hi}`); return null; }
    op[key] = n;
  }
  return op;
}

function resolveVar(val, vars, where, err) {
  const m = VAR_RE.exec(val);
  if (!m) return val;
  if (Object.prototype.hasOwnProperty.call(vars, m[1])) return vars[m[1]];
  if (m[2] !== undefined) return m[2].trim();
  err(`${where}: undefined variable ${m[1]}`);
  return null;
}

function parseCss(src, err) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (text.includes('/*')) { err('Unterminated comment.'); return { ops: [], meta: {} }; }
  const line = (pos) => text.slice(0, pos).split('\n').length;
  const rules = [];
  let pos = 0;
  for (;;) {
    const o = text.indexOf('{', pos);
    if (o === -1) {
      const rest = text.slice(pos);
      if (rest.trim()) err(`line ${line(pos + rest.length - rest.trimStart().length)}: text outside a rule`);
      break;
    }
    const c = text.indexOf('}', o + 1);
    if (c === -1) { err(`line ${line(o)}: missing '}'`); break; }
    if (text.slice(o + 1, c).includes('{')) { err(`line ${line(o)}: nested blocks are not supported`); break; }
    const selector = text.slice(pos, o).trim();
    const decls = [];
    const body = text.slice(o + 1, c);
    for (const m of body.matchAll(/[^;]+/g)) {
      const stmt = m[0];
      if (!stmt.trim()) continue;
      const ln = line(o + 1 + m.index + stmt.length - stmt.trimStart().length);
      const ci = stmt.indexOf(':');
      if (ci === -1) { err(`line ${ln}: expected 'property: value'`); continue; }
      let prop = stmt.slice(0, ci).trim();
      if (!prop.startsWith('--')) prop = prop.toLowerCase();
      decls.push([prop, stmt.slice(ci + 1).trim(), ln]);
    }
    rules.push([selector, decls, line(o)]);
    pos = c + 1;
  }
  const vars = Object.create(null);
  for (const [selector, decls] of rules) {
    if (selector !== ':root') continue;
    for (const [prop, val, dl] of decls) {
      if (prop.startsWith('--')) vars[prop] = val; else err(`line ${dl}: only --custom-properties belong in :root`);
    }
  }
  const ops = [];
  for (const [selector, decls, ln] of rules) {
    if (selector === ':root') continue;
    const where = `line ${ln}`;
    if (!selector || selector.startsWith('@') || selector.length > 120) { err(`${where}: unsupported selector (use a name like .tower)`); continue; }
    const props = {};
    let ok = true;
    for (let [prop, val, dl] of decls) {
      if (prop.startsWith('--')) { err(`line ${dl}: custom properties belong in :root`); ok = false; continue; }
      prop = ALIAS[prop] ?? prop;
      const resolved = resolveVar(val, vars, `line ${dl}`, err);
      if (resolved === null) { ok = false; continue; }
      props[prop] = resolved.toLowerCase();
    }
    if (!ok) continue;
    if (ops.length >= MAX_OPS) { err(`Too many shapes (limit ${MAX_OPS}).`); break; }
    const op = makeOp(props, where, err);
    if (op) ops.push(op);
  }
  return { ops, meta: { title: vars['--title'] ?? '', description: vars['--description'] ?? '' } };
}

function parseXml(src, err) {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(src)) { err('DOCTYPE and entity declarations are not allowed.'); return { ops: [], meta: {} }; }
  const dom = new DOMParser().parseFromString(src, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) { err('XML error: the markup is not well-formed.'); return { ops: [], meta: {} }; }
  const root = dom.documentElement;
  if (root.tagName !== 'plot') { err('The root element must be <plot>.'); return { ops: [], meta: {} }; }
  const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const rootAttrs = attrsOf(root);
  const bad = Object.keys(rootAttrs).filter((k) => k !== 'title' && k !== 'description').sort();
  if (bad.length) err(`<plot>: unknown attribute '${bad[0].slice(0, 30)}'`);
  const vars = Object.create(null);
  for (const el of root.children) {
    if (el.tagName !== 'let') continue;
    const a = attrsOf(el), name = a.name ?? '', value = a.value ?? '';
    if (!NAME_RE.test(name) || value.length > 60 || Object.keys(a).some((k) => k !== 'name' && k !== 'value')) err('<let> needs name (letters, digits, - _) and a short value');
    else vars[name] = value;
  }
  const ops = [];
  const walk = (parent, ox, oy, oz, depth) => {
    let idx = 0;
    for (const el of parent.children) {
      idx++;
      if (ops.length >= MAX_OPS) { err(`Too many shapes (limit ${MAX_OPS}).`); return; }
      const tag = el.tagName;
      const where = `<${tag.slice(0, 20)}> #${idx} in <${parent.tagName.slice(0, 20)}>`;
      if (tag === 'let' && parent === root) continue;
      const attrs = {};
      let ok = true;
      for (const [k0, v0] of Object.entries(attrsOf(el))) {
        let v = v0;
        if (v.startsWith('$')) {
          if (!Object.prototype.hasOwnProperty.call(vars, v.slice(1))) { err(`${where}: undefined variable ${v.slice(0, 30)}`); ok = false; continue; }
          v = vars[v.slice(1)];
        }
        const k = ALIAS[k0] ?? k0;
        attrs[k] = k0 === 'block' || k === 'shape' ? v.toLowerCase() : v;
      }
      if (!ok) continue;
      if (tag === 'group') {
        if (Object.keys(attrs).some((k) => !['x', 'y', 'z'].includes(k))) { err(`${where}: <group> only accepts x, y, z`); continue; }
        if (depth >= MAX_GROUP_DEPTH) { err(`${where}: groups nested too deeply`); continue; }
        const off = {};
        for (const k of ['x', 'y', 'z']) {
          const raw = attrs[k] ?? '0';
          if (!INT_RE.test(raw) || parseInt(raw, 10) < -256 || parseInt(raw, 10) > 256) { err(`${where}: ${k} must be a whole number between -256 and 256`); ok = false; }
          else off[k] = parseInt(raw, 10);
        }
        if (ok) walk(el, ox + off.x, oy + off.y, oz + off.z, depth + 1);
      } else if (SHAPES.includes(tag)) {
        const op = makeOp({ ...attrs, shape: tag }, where, err);
        if (op) { op.x += ox; op.y += oy; op.z += oz; ops.push(op); }
      } else err(`${where}: unknown element`);
    }
  };
  walk(root, 0, 0, 0, 0);
  return { ops, meta: { title: rootAttrs.title ?? '', description: rootAttrs.description ?? '' } };
}

function inside(shape, lx, ly, lz, w, h, d) {
  if (shape === 'box') return true;
  if (shape === 'shell') return lx === 0 || lx === w - 1 || ly === 0 || ly === h - 1 || lz === 0 || lz === d - 1;
  if (shape === 'walls') return lx === 0 || lx === w - 1 || lz === 0 || lz === d - 1;
  if (shape === 'pyramid') return lx >= ly && lx <= w - 1 - ly && lz >= ly && lz <= d - 1 - ly;
  const dx = (lx - (w - 1) / 2) / (w / 2);
  const dz = (lz - (d - 1) / 2) / (d / 2);
  if (shape === 'cylinder') return dx * dx + dz * dz <= 1;
  const dy = shape === 'sphere' ? (ly - (h - 1) / 2) / (h / 2) : (ly + 0.5) / h;
  return dx * dx + dy * dy + dz * dz <= 1;
}

function rasterize(ops, world, maxBlocks, placeable, err) {
  const size = world.plot_size, height = world.plot_height;
  const grid = new Map();
  let cells = 0, instances = 0;
  for (const op of ops) {
    if (op.block !== 'air' && !placeable.has(op.block)) { err(`${op.where}: unknown or non-placeable block '${op.block.slice(0, 30)}'`); return []; }
    const w = op.width, h = op.height, d = op.depth;
    instances += op['repeat-x'] * op['repeat-y'] * op['repeat-z'];
    if (instances > MAX_INSTANCES) { err(`Too many repeated shapes (limit ${MAX_INSTANCES}).`); return []; }
    for (let i = 0; i < op['repeat-x']; i++) for (let j = 0; j < op['repeat-y']; j++) for (let k = 0; k < op['repeat-z']; k++) {
      const bx = op.x + i * (w + op['gap-x']), by = op.y + j * (h + op['gap-y']), bz = op.z + k * (d + op['gap-z']);
      const x0 = Math.max(bx, 0), x1 = Math.min(bx + w, size), y0 = Math.max(by, 0), y1 = Math.min(by + h, height), z0 = Math.max(bz, 0), z1 = Math.min(bz + d, size);
      if (x0 >= x1 || y0 >= y1 || z0 >= z1) continue;
      cells += (x1 - x0) * (y1 - y0) * (z1 - z0);
      if (cells > MAX_CELLS) { err('Blueprint is too complex to compile.'); return []; }
      for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
        if (!inside(op.shape, x - bx, y - by, z - bz, w, h, d)) continue;
        const key = `${x},${y},${z}`;
        if (op.block === 'air') grid.delete(key); else grid.set(key, op.block);
      }
    }
  }
  if (grid.size > maxBlocks) { err(`Too many blocks: ${grid.size} (limit ${maxBlocks}).`); return []; }
  const out = [...grid].map(([k, b]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, b]; });
  return out.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
}

/** @returns {{errors:string[], title:string, description:string, blocks:Array}} */
export function compileBlueprint(format, source, cfg, placeable) {
  const err = makeErrors();
  const fail = (m) => ({ errors: [m], title: '', description: '', blocks: [] });
  if (format !== 'css' && format !== 'xml') return fail('format must be css or xml.');
  if (typeof source !== 'string' || !source.trim()) return fail('The blueprint is empty.');
  if (source.length > MAX_SOURCE) return fail(`Blueprint is too long (${source.length} characters, limit ${MAX_SOURCE}).`);
  const { ops, meta } = (format === 'css' ? parseCss : parseXml)(source, err);
  const title = meta.title ?? '', description = meta.description ?? '';
  for (const [key, val, limit] of [['title', title, cfg.rules.max_title_length], ['description', description, cfg.rules.max_description_length]]) {
    if (val.length > limit || !TEXT_RE.test(val)) err(`${key}: plain text up to ${limit} characters`);
  }
  if (err.items.length) return { errors: err.items, title, description, blocks: [] };
  if (!ops.length) return { errors: ['The blueprint contains no shapes.'], title, description, blocks: [] };
  const blocks = rasterize(ops, cfg.world, cfg.rules.max_blocks, placeable, err);
  return { errors: err.items, title, description, blocks: err.items.length ? [] : blocks };
}

export const AI_PROMPT = (world, blocks) => `You are designing a building for PullCraft, a Minecraft-like voxel world. Reply with ONE code block only, in either CSS-style or XML (your choice), using exactly this format.

The plot is ${world.plot_size} wide (x), ${world.plot_height} tall (y), ${world.plot_size} deep (z). Origin 0,0,0 is a corner; y=0 is the first layer above the ground. Anything outside the plot is cut off.

CSS FORMAT: each rule is one shape, painted in order (later rules overwrite earlier ones; block: air carves holes).
:root { --title: My Building; --description: One short line.; --wall: stone_bricks; }
.walls { shape: walls; x: 4; y: 0; z: 4; width: 12; height: 6; depth: 10; block: var(--wall); repeat-x: 2; gap-x: 3; }
Properties: shape (box, shell, walls, pyramid, cylinder, sphere, dome), x y z, width height depth (or w h d), block, repeat-x/y/z (copies), gap-x/y/z (space between copies). Whole numbers only. shell = all six faces, walls = four sides without floor or roof, pyramid shrinks by one block per layer, dome = top half of a sphere. Use var(--name) for reusable materials (declare them in :root).

XML FORMAT:
<plot title="My Building" description="One short line.">
  <let name="wall" value="stone_bricks"/>
  <walls x="4" y="0" z="4" w="12" h="6" d="10" block="$wall" repeat-x="2" gap-x="3"/>
  <group x="2" y="0" z="2"> ...shapes positioned relative to the group... </group>
</plot>

Allowed block names: ${blocks.join(', ')}, air.
Rules: max 30,000 blocks, max 2,000 shapes. Make it detailed: foundations, windows, doors (carve with air), roofs, lighting (glowstone, sea_lantern) and trim. Describe nothing; output only the code block.

My idea: `;
