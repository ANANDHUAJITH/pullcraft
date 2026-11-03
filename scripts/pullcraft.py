"""PullCraft shared library: rules, validation, layout and plot resolution.

Everything that decides whether a plot is acceptable lives here so the PR
validator and the world builder can never disagree.
"""
from __future__ import annotations

import json
import math
import re
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent

LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
SOURCE_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,120}\.json$")
TEXT_RE = re.compile(r"^[\w .,'!&()\-:+#/?]*$")
MAX_ERRORS = 20


# --------------------------------------------------------------------------- config
def load_config(root: Path = ROOT) -> dict:
    return json.loads((root / "config.json").read_text(encoding="utf-8"))


def load_blocks(root: Path = ROOT) -> list[dict]:
    return json.loads((root / "data" / "blocks.json").read_text(encoding="utf-8"))["blocks"]


def block_ids(blocks: list[dict], placeable_only: bool = False) -> list[str]:
    return [b["id"] for b in blocks if b["placeable"] or not placeable_only]


# --------------------------------------------------------------------------- layout
def spiral(n1: int) -> tuple[int, int]:
    """Cell for 1-indexed spiral slot n1. Slot 1 is the origin (0, 0)."""
    if n1 < 1:
        raise ValueError("slot must be >= 1")
    k = math.ceil((math.sqrt(n1) - 1) / 2)
    t = 2 * k + 1
    m = t * t
    t -= 1
    if n1 >= m - t:
        return k - (m - n1), -k
    m -= t
    if n1 >= m - t:
        return -k, -k + (m - n1)
    m -= t
    if n1 >= m - t:
        return -k + (m - n1), k
    return k, k - (m - n1 - t)


def cell_size(world: dict) -> int:
    return world["plot_size"] + world["road"]


def plot_origin(world: dict, cell: tuple[int, int]) -> tuple[int, int]:
    """World (x, z) of the plot's local (0, 0). Cell (0,0) is centred on the origin."""
    cs = cell_size(world)
    half = cs // 2
    pad = world["road"] // 2
    return cell[0] * cs - half + pad, cell[1] * cs - half + pad


def city_ring(world_rules: dict, plot_count: int) -> int:
    ring = world_rules["min_city_ring"]
    while (2 * ring + 1) ** 2 - 1 - plot_count < world_rules["min_free_plots"]:
        ring += 1
    return ring


# --------------------------------------------------------------------------- validation
@dataclass
class PlotStats:
    blocks: int = 0
    title: str = ""
    description: str = ""
    kind: str = "inline"  # inline | repo


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_content(doc: object, cfg: dict, placeable: set[str]) -> tuple[list[str], PlotStats]:
    """Validate an inline plot document (title + blocks)."""
    errors: list[str] = []
    stats = PlotStats()
    w, r = cfg["world"], cfg["rules"]

    def err(msg: str) -> None:
        if len(errors) < MAX_ERRORS:
            errors.append(msg)

    if not isinstance(doc, dict):
        return ["Plot file must be a JSON object."], stats
    extra = set(doc) - {"version", "title", "description", "blocks"}
    if extra:
        err(f"Unknown keys: {', '.join(sorted(map(str, extra)))}.")
    if doc.get("version") != 1:
        err('"version" must be 1.')
    for key, limit in (("title", r["max_title_length"]), ("description", r["max_description_length"])):
        val = doc.get(key, "")
        if not isinstance(val, str) or len(val) > limit or not TEXT_RE.match(val):
            err(f'"{key}" must be plain text up to {limit} characters (letters, digits and basic punctuation).')
        else:
            setattr(stats, key, val.strip())
    blocks = doc.get("blocks")
    if not isinstance(blocks, list):
        err('"blocks" must be a list of [x, y, z, "block_id"].')
        return errors, stats
    if len(blocks) > r["max_blocks"]:
        err(f"Too many blocks: {len(blocks)} (limit {r['max_blocks']}).")
        return errors, stats
    seen: set[tuple[int, int, int]] = set()
    for i, b in enumerate(blocks):
        if not (isinstance(b, list) and len(b) == 4 and all(_is_int(v) for v in b[:3]) and isinstance(b[3], str)):
            err(f"Block #{i}: expected [x, y, z, \"id\"].")
            continue
        x, y, z, bid = b
        if not (0 <= x < w["plot_size"] and 0 <= z < w["plot_size"] and 0 <= y < w["plot_height"]):
            err(f"Block #{i} at ({x},{y},{z}) is outside the plot "
                f"({w['plot_size']}x{w['plot_height']}x{w['plot_size']}).")
        if bid not in placeable:
            err(f"Block #{i}: unknown or non-placeable block \"{bid[:30]}\".")
        if (x, y, z) in seen:
            err(f"Block #{i}: duplicate position ({x},{y},{z}).")
        seen.add((x, y, z))
    stats.blocks = len(blocks)
    return errors, stats


def validate_document(
    doc: object,
    owner: str,
    cfg: dict,
    placeable: set[str],
    fetch: Optional[Callable[[str, str, str], object]] = None,
) -> tuple[list[str], PlotStats, Optional[dict]]:
    """Validate a plots/<owner>.json document, resolving repo pointers.

    Returns (errors, stats, resolved_inline_document).
    """
    if isinstance(doc, dict) and "source" in doc:
        extra = set(doc) - {"version", "title", "description", "source"}
        src = doc.get("source")
        errs: list[str] = []
        if extra:
            errs.append(f"Unknown keys next to \"source\": {', '.join(sorted(map(str, extra)))}.")
        if doc.get("version") != 1:
            errs.append('"version" must be 1.')
        if not (isinstance(src, dict) and set(src) == {"repo", "path", "sha"}):
            errs.append('"source" must be {"repo": "owner/name", "path": "file.json", "sha": "<40 hex>"}.')
            return errs, PlotStats(kind="repo"), None
        repo, path, sha = src["repo"], src["path"], src["sha"]
        if not (isinstance(repo, str) and REPO_RE.match(repo)):
            errs.append("source.repo is not a valid owner/name.")
        elif repo.split("/")[0].lower() != owner.lower():
            errs.append(f"source.repo must belong to you ({owner}), not {repo.split('/')[0]}.")
        if not (isinstance(path, str) and SOURCE_PATH_RE.match(path) and ".." not in path):
            errs.append("source.path must be a relative .json path.")
        if not (isinstance(sha, str) and SHA_RE.match(sha)):
            errs.append("source.sha must be a full 40-character lowercase commit SHA (builds are pinned).")
        if errs:
            return errs, PlotStats(kind="repo"), None
        if fetch is None:
            return ["Repo-linked plots cannot be resolved in this context."], PlotStats(kind="repo"), None
        try:
            remote = fetch(repo, sha, path)
        except Exception as exc:  # network, size, JSON problems
            return [f"Could not fetch {repo}@{sha[:7]}:{path}: {str(exc)[:120]}"], PlotStats(kind="repo"), None
        errors, stats = validate_content(remote, cfg, placeable)
        stats.kind = "repo"
        if not errors:
            for key in ("title", "description"):  # pointer may override display text
                if isinstance(doc.get(key), str) and doc[key].strip():
                    if len(doc[key]) <= cfg["rules"]["max_title_length" if key == "title" else "max_description_length"] \
                            and TEXT_RE.match(doc[key]):
                        setattr(stats, key, doc[key].strip())
        return errors, stats, (remote if not errors else None)
    errors, stats = validate_content(doc, cfg, placeable)
    return errors, stats, (doc if not errors else None)  # type: ignore[return-value]


def github_raw_fetch(max_bytes: int, cache_dir: Optional[Path] = None) -> Callable[[str, str, str], object]:
    """Fetch a SHA-pinned JSON file from raw.githubusercontent.com (immutable, so cacheable)."""
    def fetch(repo: str, sha: str, path: str) -> object:
        cache_file = None
        if cache_dir is not None:
            import hashlib
            key = hashlib.sha1(f"{repo}/{sha}/{path}".encode()).hexdigest()
            cache_file = cache_dir / f"{key}.json"
            if cache_file.exists():
                return json.loads(cache_file.read_text(encoding="utf-8"))
        url = f"https://raw.githubusercontent.com/{repo}/{sha}/{path}"
        req = urllib.request.Request(url, headers={"User-Agent": "pullcraft-builder"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError("file too large")
        data = json.loads(raw.decode("utf-8"))
        if cache_file is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
            cache_file.write_text(json.dumps(data), encoding="utf-8")
        return data
    return fetch
