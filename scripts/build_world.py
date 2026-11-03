#!/usr/bin/env python3
"""Build the static PullCraft site (client + chunked world data) into --out.

Inputs : plots/*.json, data/blocks.json, config.json, git history
Outputs: <out>/ (client)  and  <out>/world/ (manifest, chunks, players, plots, metadata)
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pullcraft as pc  # noqa: E402

PR_RE = re.compile(r"\(#(\d+)\)")


def compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def git_log(root: Path) -> list[dict]:
    """One entry per (commit, plot file). Empty list when there is no git history."""
    try:
        out = subprocess.run(
            ["git", "log", "--format=%x1e%H%x1f%ct%x1f%an%x1f%s", "--name-status", "--", "plots"],
            cwd=root, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    events = []
    for chunk in out.split("\x1e")[1:]:
        head, *rest = chunk.strip("\n").split("\n")
        sha, ts, author, subject = head.split("\x1f", 3)
        pr = PR_RE.search(subject)
        for line in rest:
            parts = line.split("\t")
            if len(parts) >= 2 and parts[-1].startswith("plots/") and parts[-1].endswith(".json"):
                events.append({
                    "user": Path(parts[-1]).stem, "status": parts[0][0], "sha": sha, "ts": int(ts),
                    "author": author, "subject": subject[:100], "pr": int(pr.group(1)) if pr else None,
                })
    return events  # newest first


def spawn_blocks(cfg: dict) -> list[list]:
    """Community plaza: checker floor, fountain, lamp pillars. y=-1 replaces the ground layer."""
    n = cfg["world"]["plot_size"]
    c = n // 2
    out = []
    for x in range(n):
        for z in range(n):
            edge = x in (0, n - 1) or z in (0, n - 1)
            floor = "quartz" if edge else ("stone_bricks" if (x + z) % 2 else "smooth_stone")
            out.append([x, -1, z, floor])
    for x in range(c - 4, c + 4):  # fountain basin
        for z in range(c - 4, c + 4):
            ring = max(abs(x - c + 0.5), abs(z - c + 0.5))
            if ring >= 3.5:
                out.append([x, 0, z, "quartz"])
            else:
                out.append([x, -1, z, "water"])
    for dy in range(0, 4):
        out.append([c - 1, dy, c - 1, "quartz"] if dy < 3 else [c - 1, dy, c - 1, "sea_lantern"])
    for px, pz in ((2, 2), (n - 3, 2), (2, n - 3), (n - 3, n - 3)):
        for dy in range(0, 5):
            out.append([px, dy, pz, "quartz"])
        out.append([px, 5, pz, "glowstone"])
    return out


def first_line_time(events: list[dict]) -> dict[str, int]:
    first: dict[str, int] = {}
    for e in events:
        if e["status"] == "A":
            first[e["user"].lower()] = min(first.get(e["user"].lower(), e["ts"]), e["ts"])
    return first


def build(root: Path, out: Path, fetch=None, events=None, repo: str = "", branch: str = "main") -> dict:
    cfg = pc.load_config(root)
    blocks = pc.load_blocks(root)
    palette = pc.block_ids(blocks)
    pid = {b: i + 1 for i, b in enumerate(palette)}
    placeable = set(pc.block_ids(blocks, placeable_only=True))
    world, rules = cfg["world"], cfg["rules"]
    events = git_log(root) if events is None else events
    if fetch is None:
        fetch = pc.github_raw_fetch(rules["max_file_bytes"], root / ".cache" / "sources")

    # ---- collect + validate plots
    plots = []
    skipped = []
    for path in sorted((root / "plots").glob("*.json")):
        user = path.stem
        if not pc.LOGIN_RE.match(user):
            skipped.append((user, "invalid file name"))
            continue
        if path.stat().st_size > rules["max_file_bytes"]:
            skipped.append((user, "file too large"))
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            skipped.append((user, f"bad JSON: {exc}"))
            continue
        errors, stats, resolved = pc.validate_document(doc, user, cfg, placeable, fetch)
        if errors or resolved is None:
            skipped.append((user, errors[0] if errors else "invalid"))
            continue
        plots.append({"user": user, "stats": stats, "doc": resolved})

    # ---- stable slot allocation: order of first merge, then name. Slot 1 = spawn plaza.
    first = first_line_time(events)
    plots.sort(key=lambda p: (first.get(p["user"].lower(), 2**62), p["user"].lower()))
    seen_lower = set()
    unique = []
    for p in plots:  # case-insensitive duplicates: first one wins
        if p["user"].lower() in seen_lower:
            skipped.append((p["user"], "duplicate (case-insensitive)"))
            continue
        seen_lower.add(p["user"].lower())
        unique.append(p)
    plots = unique

    by_user: dict[str, list[dict]] = {}
    for e in events:
        by_user.setdefault(e["user"].lower(), []).append(e)

    chunks: dict[tuple[int, int], dict[tuple[int, int, int], int]] = {}
    cs = world["chunk"]

    def put(wx: int, wy: int, wz: int, name: str) -> None:
        cx, cz = wx // cs, wz // cs  # floor division: correct for negative coordinates
        chunks.setdefault((cx, cz), {})[(wy, wz, wx)] = pid[name]  # later writes win

    plot_meta = []
    spawn_origin = pc.plot_origin(world, (0, 0))
    for x, y, z, name in spawn_blocks(cfg):
        put(spawn_origin[0] + x, world["ground"] + 1 + y, spawn_origin[1] + z, name)

    for i, p in enumerate(plots):
        cell = pc.spiral(i + 2)
        ox, oz = pc.plot_origin(world, cell)
        for x, y, z, name in p["doc"]["blocks"]:
            put(ox + x, world["ground"] + 1 + y, oz + z, name)
        hist = by_user.get(p["user"].lower(), [])
        commits = [e for e in hist if e["status"] != "D"]
        plot_meta.append({
            "user": p["user"], "cell": list(cell), "origin": [ox, oz], "title": p["stats"].title,
            "description": p["stats"].description, "blocks": p["stats"].blocks, "source": p["stats"].kind,
            "added": first.get(p["user"].lower()), "updated": commits[0]["ts"] if commits else None,
            "pr": commits[0]["pr"] if commits else None,
        })
        p["meta"] = plot_meta[-1]

    # ---- write output
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(root / "web", out, ignore=shutil.ignore_patterns(".*"))
    wdir = out / "world"
    for sub in ("chunks", "players", "plots", "metadata"):
        (wdir / sub).mkdir(parents=True)
    (out / ".nojekyll").write_text("")
    shutil.copy(root / "data" / "blocks.json", wdir / "blocks.json")

    chunk_hashes = {}
    for (cx, cz), entries in sorted(chunks.items()):
        flat: list[int] = []
        for (wy, wz, wx), bid in sorted(entries.items()):
            flat += [wx - cx * cs, wy, wz - cz * cs, bid]
        body = compact({"cx": cx, "cz": cz, "b": flat})
        h = hashlib.sha1(body.encode()).hexdigest()[:10]
        chunk_hashes[f"{cx}_{cz}"] = h
        (wdir / "chunks" / f"{cx}_{cz}.{h}.json").write_text(body, encoding="utf-8")

    hist_limit = cfg["history_limit"]
    for p in plots:
        m = p["meta"]
        hist = [e for e in by_user.get(p["user"].lower(), [])][:hist_limit]
        (wdir / "players" / f"{p['user']}.json").write_text(compact({
            **m, "history": [{k: e[k] for k in ("sha", "ts", "author", "subject", "pr")} for e in hist],
        }), encoding="utf-8")
        (wdir / "plots" / f"{p['user']}.json").write_text(compact({
            "version": 1, "title": m["title"], "description": m["description"], "blocks": p["doc"]["blocks"],
        }), encoding="utf-8")

    recent = [e for e in events if e["user"].lower() in seen_lower][: cfg["recent_limit"]]
    (wdir / "metadata" / "recent.json").write_text(compact([
        {k: e[k] for k in ("user", "status", "sha", "ts", "author", "subject", "pr")} for e in recent
    ]), encoding="utf-8")
    board = sorted(plot_meta, key=lambda m: (-m["blocks"], m["user"].lower()))[:50]
    (wdir / "metadata" / "leaderboard.json").write_text(compact(
        [{"user": m["user"], "blocks": m["blocks"], "title": m["title"]} for m in board]), encoding="utf-8")

    ring = pc.city_ring(rules, len(plots))
    revision = hashlib.sha1(compact([chunk_hashes, plot_meta]).encode()).hexdigest()[:12]
    manifest = {
        "schema": 1, "revision": revision,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "repo": repo or os.environ.get("GITHUB_REPOSITORY", ""), "branch": branch,
        "name": cfg["name"], "world": world, "rules": rules, "palette": palette,
        "city_ring": ring, "spawn": {"title": cfg["spawn"]["title"]},
        "plots": plot_meta, "chunks": chunk_hashes,
        "stats": {"players": len(plots), "blocks": sum(m["blocks"] for m in plot_meta), "chunks": len(chunk_hashes)},
    }
    (wdir / "manifest.json").write_text(compact(manifest), encoding="utf-8")
    for user, why in skipped:
        print(f"::warning::skipped plot {user}: {why}")
    print(f"built {len(plots)} plots, {len(chunk_hashes)} chunks, revision {revision}")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site")
    ap.add_argument("--root", default=str(pc.ROOT))
    args = ap.parse_args()
    branch = os.environ.get("PULLCRAFT_BRANCH", "main")
    build(Path(args.root), Path(args.out), repo=os.environ.get("GITHUB_REPOSITORY", ""), branch=branch)


if __name__ == "__main__":
    main()
