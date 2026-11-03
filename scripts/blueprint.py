"""Blueprint compilers: CSS-style and XML source text -> blocks.

A blueprint is a list of shapes painted in order (later shapes win, `air` carves).
The compiler is deterministic, bounded (source size, shape count, work budget) and has
no I/O, so it is safe to run on untrusted pull requests. web/js/blueprint.js mirrors it
exactly; tests/core.test.mjs checks the two agree.

CLI: python scripts/blueprint.py file.css|file.xml  -> JSON {errors,title,description,blocks}
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_SOURCE = 40_000
MAX_OPS = 2000
MAX_INSTANCES = 20_000
MAX_CELLS = 2_000_000
MAX_GROUP_DEPTH = 5
MAX_ERRORS = 20

SHAPES = ("box", "shell", "walls", "pyramid", "cylinder", "sphere", "dome")
ALIAS = {"w": "width", "h": "height", "d": "depth", "repeat": "repeat-x", "gap": "gap-x"}
DEFAULTS = {"x": 0, "y": 0, "z": 0, "width": 1, "height": 1, "depth": 1,
            "repeat-x": 1, "repeat-y": 1, "repeat-z": 1, "gap-x": 0, "gap-y": 0, "gap-z": 0}
RANGES = {"x": (-256, 256), "y": (-256, 256), "z": (-256, 256), "width": (1, 256), "height": (1, 256),
          "depth": (1, 256), "repeat-x": (1, 1000), "repeat-y": (1, 1000), "repeat-z": (1, 1000),
          "gap-x": (0, 256), "gap-y": (0, 256), "gap-z": (0, 256)}
INT_RE = re.compile(r"^-?\d{1,4}$")
VAR_RE = re.compile(r"^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*?))?\s*\)$")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
TEXT_RE = re.compile(r"^[\w .,'!&()\-:+#/?]*$")


class Errors:
    def __init__(self) -> None:
        self.items: list[str] = []

    def __call__(self, msg: str) -> None:
        if len(self.items) < MAX_ERRORS:
            self.items.append(msg)

    def __bool__(self) -> bool:
        return bool(self.items)


def make_op(props: dict, where: str, err: Errors) -> dict | None:
    unknown = sorted(set(props) - set(DEFAULTS) - {"shape", "block"})
    if unknown:
        err(f"{where}: unknown property '{unknown[0][:30]}'")
        return None
    shape = props.get("shape", "box")
    if shape not in SHAPES:
        err(f"{where}: shape must be one of {', '.join(SHAPES)}")
        return None
    block = props.get("block")
    if not block:
        err(f"{where}: missing 'block'")
        return None
    op = {"shape": shape, "block": block, "where": where}
    for key, default in DEFAULTS.items():
        raw = props.get(key)
        if raw is None:
            op[key] = default
            continue
        if not INT_RE.match(raw):
            err(f"{where}: {key} must be a whole number, got '{raw[:20]}'")
            return None
        n = int(raw)
        lo, hi = RANGES[key]
        if not lo <= n <= hi:
            err(f"{where}: {key} must be between {lo} and {hi}")
            return None
        op[key] = n
    return op


def resolve_var(val: str, vars_: dict, where: str, err: Errors) -> str | None:
    m = VAR_RE.match(val)
    if not m:
        return val
    if m.group(1) in vars_:
        return vars_[m.group(1)]
    if m.group(2) is not None:
        return m.group(2).strip()
    err(f"{where}: undefined variable {m.group(1)}")
    return None


# ----------------------------------------------------------------------------- CSS
def parse_css(src: str, err: Errors) -> tuple[list[dict], dict]:
    text = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group()), src, flags=re.S)
    if "/*" in text:
        err("Unterminated comment.")
        return [], {}

    def line(pos: int) -> int:
        return text.count("\n", 0, pos) + 1

    rules = []  # (selector, [(prop, value, line)], line)
    pos = 0
    while True:
        o = text.find("{", pos)
        if o == -1:
            if text[pos:].strip():
                err(f"line {line(pos + len(text[pos:]) - len(text[pos:].lstrip()))}: text outside a rule")
            break
        c = text.find("}", o + 1)
        if c == -1:
            err(f"line {line(o)}: missing '}}'")
            break
        if "{" in text[o + 1:c]:
            err(f"line {line(o)}: nested blocks are not supported")
            break
        selector = text[pos:o].strip()
        decls = []
        body = text[o + 1:c]
        for m in re.finditer(r"[^;]+", body):
            stmt = m.group()
            if not stmt.strip():
                continue
            ln = line(o + 1 + m.start() + len(stmt) - len(stmt.lstrip()))
            prop, colon, val = stmt.partition(":")
            if not colon:
                err(f"line {ln}: expected 'property: value'")
                continue
            prop = prop.strip()
            prop = prop if prop.startswith("--") else prop.lower()
            decls.append((prop, val.strip(), ln))
        rules.append((selector, decls, line(o)))
        pos = c + 1

    vars_: dict[str, str] = {}
    for selector, decls, ln in rules:
        if selector == ":root":
            for prop, val, dl in decls:
                if prop.startswith("--"):
                    vars_[prop] = val
                else:
                    err(f"line {dl}: only --custom-properties belong in :root")
    ops = []
    for selector, decls, ln in rules:
        if selector == ":root":
            continue
        where = f"line {ln}"
        if not selector or selector.startswith("@") or len(selector) > 120:
            err(f"{where}: unsupported selector (use a name like .tower)")
            continue
        props = {}
        ok = True
        for prop, val, dl in decls:
            if prop.startswith("--"):
                err(f"line {dl}: custom properties belong in :root")
                ok = False
                continue
            prop = ALIAS.get(prop, prop)
            resolved = resolve_var(val, vars_, f"line {dl}", err)
            if resolved is None:
                ok = False
                continue
            props[prop] = resolved.lower()
        if not ok:
            continue
        if len(ops) >= MAX_OPS:
            err(f"Too many shapes (limit {MAX_OPS}).")
            break
        op = make_op(props, where, err)
        if op:
            ops.append(op)
    meta = {"title": vars_.get("--title", ""), "description": vars_.get("--description", "")}
    return ops, meta


# ----------------------------------------------------------------------------- XML
def parse_xml(src: str, err: Errors) -> tuple[list[dict], dict]:
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", src, re.I):
        err("DOCTYPE and entity declarations are not allowed.")
        return [], {}
    try:
        root = ET.fromstring(src)
    except ET.ParseError as exc:
        err(f"XML error: {str(exc)[:100]}")
        return [], {}
    if root.tag != "plot":
        err("The root element must be <plot>.")
        return [], {}
    bad = sorted(set(root.attrib) - {"title", "description"})
    if bad:
        err(f"<plot>: unknown attribute '{bad[0][:30]}'")
    vars_: dict[str, str] = {}
    for el in root:
        if el.tag == "let":
            name, value = el.attrib.get("name", ""), el.attrib.get("value", "")
            if not NAME_RE.match(name) or len(value) > 60 or set(el.attrib) - {"name", "value"}:
                err("<let> needs name (letters, digits, - _) and a short value")
            else:
                vars_[name] = value
    ops: list[dict] = []

    def walk(parent, ox: int, oy: int, oz: int, depth: int) -> None:
        for idx, el in enumerate(parent, 1):
            if len(ops) >= MAX_OPS:
                err(f"Too many shapes (limit {MAX_OPS}).")
                return
            where = f"<{str(el.tag)[:20]}> #{idx} in <{str(parent.tag)[:20]}>"
            if el.tag == "let" and parent is root:
                continue
            attrs = {}
            ok = True
            for k, v in el.attrib.items():
                if v.startswith("$"):
                    if v[1:] not in vars_:
                        err(f"{where}: undefined variable {v[:30]}")
                        ok = False
                        continue
                    v = vars_[v[1:]]
                attrs[ALIAS.get(k, k)] = v.lower() if k == "block" or ALIAS.get(k, k) == "shape" else v
            if not ok:
                continue
            if el.tag == "group":
                if set(attrs) - {"x", "y", "z"}:
                    err(f"{where}: <group> only accepts x, y, z")
                    continue
                if depth >= MAX_GROUP_DEPTH:
                    err(f"{where}: groups nested too deeply")
                    continue
                off = {}
                for k in ("x", "y", "z"):
                    raw = attrs.get(k, "0")
                    if not INT_RE.match(raw) or not -256 <= int(raw) <= 256:
                        err(f"{where}: {k} must be a whole number between -256 and 256")
                        ok = False
                    else:
                        off[k] = int(raw)
                if ok:
                    walk(el, ox + off["x"], oy + off["y"], oz + off["z"], depth + 1)
            elif el.tag in SHAPES:
                op = make_op({**attrs, "shape": el.tag}, where, err)
                if op:
                    op["x"] += ox
                    op["y"] += oy
                    op["z"] += oz
                    ops.append(op)
            else:
                err(f"{where}: unknown element")

    walk(root, 0, 0, 0, 0)
    return ops, {"title": root.attrib.get("title", ""), "description": root.attrib.get("description", "")}


# ----------------------------------------------------------------------------- rasteriser
def inside(shape: str, lx: int, ly: int, lz: int, w: int, h: int, d: int) -> bool:
    if shape == "box":
        return True
    if shape == "shell":
        return lx in (0, w - 1) or ly in (0, h - 1) or lz in (0, d - 1)
    if shape == "walls":
        return lx in (0, w - 1) or lz in (0, d - 1)
    if shape == "pyramid":
        return lx >= ly and lx <= w - 1 - ly and lz >= ly and lz <= d - 1 - ly
    dx = (lx - (w - 1) / 2) / (w / 2)
    dz = (lz - (d - 1) / 2) / (d / 2)
    if shape == "cylinder":
        return dx * dx + dz * dz <= 1
    if shape == "sphere":
        dy = (ly - (h - 1) / 2) / (h / 2)
    else:  # dome: top half of an ellipsoid sitting on the shape's floor
        dy = (ly + 0.5) / h
    return dx * dx + dy * dy + dz * dz <= 1


def rasterize(ops: list[dict], world: dict, max_blocks: int, placeable: set[str], err: Errors) -> list[list]:
    size, height = world["plot_size"], world["plot_height"]
    grid: dict[tuple[int, int, int], str] = {}
    cells = instances = 0
    for op in ops:
        if op["block"] != "air" and op["block"] not in placeable:
            err(f"{op['where']}: unknown or non-placeable block '{op['block'][:30]}'")
            return []
        w, h, d = op["width"], op["height"], op["depth"]
        n = op["repeat-x"] * op["repeat-y"] * op["repeat-z"]
        instances += n
        if instances > MAX_INSTANCES:
            err(f"Too many repeated shapes (limit {MAX_INSTANCES}).")
            return []
        for i in range(op["repeat-x"]):
            for j in range(op["repeat-y"]):
                for k in range(op["repeat-z"]):
                    bx = op["x"] + i * (w + op["gap-x"])
                    by = op["y"] + j * (h + op["gap-y"])
                    bz = op["z"] + k * (d + op["gap-z"])
                    x0, x1 = max(bx, 0), min(bx + w, size)
                    y0, y1 = max(by, 0), min(by + h, height)
                    z0, z1 = max(bz, 0), min(bz + d, size)
                    if x0 >= x1 or y0 >= y1 or z0 >= z1:
                        continue
                    cells += (x1 - x0) * (y1 - y0) * (z1 - z0)
                    if cells > MAX_CELLS:
                        err("Blueprint is too complex to compile.")
                        return []
                    for x in range(x0, x1):
                        for y in range(y0, y1):
                            for z in range(z0, z1):
                                if inside(op["shape"], x - bx, y - by, z - bz, w, h, d):
                                    if op["block"] == "air":
                                        grid.pop((x, y, z), None)
                                    else:
                                        grid[(x, y, z)] = op["block"]
    if len(grid) > max_blocks:
        err(f"Too many blocks: {len(grid)} (limit {max_blocks}).")
        return []
    return [[x, y, z, b] for (x, y, z), b in sorted(grid.items(), key=lambda kv: (kv[0][1], kv[0][2], kv[0][0]))]


def compile_blueprint(fmt: str, source: str, cfg: dict, placeable: set[str]) -> tuple[list[str], dict, list[list]]:
    err = Errors()
    if fmt not in ("css", "xml"):
        return ["format must be css or xml."], {}, []
    if not isinstance(source, str) or not source.strip():
        return ["The blueprint is empty."], {}, []
    if len(source) > MAX_SOURCE:
        return [f"Blueprint is too long ({len(source)} characters, limit {MAX_SOURCE})."], {}, []
    ops, meta = (parse_css if fmt == "css" else parse_xml)(source, err)
    for key, limit in (("title", cfg["rules"]["max_title_length"]), ("description", cfg["rules"]["max_description_length"])):
        if len(meta.get(key, "")) > limit or not TEXT_RE.match(meta.get(key, "")):
            err(f"{key}: plain text up to {limit} characters")
    if err:
        return err.items, meta, []
    if not ops:
        return ["The blueprint contains no shapes."], meta, []
    blocks = rasterize(ops, cfg["world"], cfg["rules"]["max_blocks"], placeable, err)
    if err:
        return err.items, meta, []
    return [], meta, blocks


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import pullcraft as pc

    path = Path(sys.argv[1])
    cfg = pc.load_config()
    ok = set(pc.block_ids(pc.load_blocks(), placeable_only=True))
    errors, meta, blocks = compile_blueprint(path.suffix[1:], path.read_text(encoding="utf-8"), cfg, ok)
    print(json.dumps({"errors": errors, **meta, "blocks": blocks}, separators=(",", ":")))
