#!/usr/bin/env python3
"""Validate (and optionally merge) a PullCraft pull request.

Runs from a `pull_request_target` workflow, so it executes TRUSTED code from the
base branch. Pull-request content is only ever read as data (git objects ->
json.loads); nothing from the PR is checked out, imported or executed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pullcraft as pc  # noqa: E402

MARKER = "<!-- pullcraft-bot -->"
TRUSTED = {"OWNER", "MEMBER", "COLLABORATOR"}
MAX_FILES = 20


@dataclass
class Verdict:
    kind: str  # approved | rejected | manual
    errors: list[str] = field(default_factory=list)
    summary: str = ""


def evaluate(
    login: str,
    association: str,
    files: list[dict],
    read_head: Callable[[str], Optional[bytes]],
    existing_plots: set[str],
    account_created: Optional[dt.datetime],
    cfg: dict,
    placeable: set[str],
    fetch=None,
    now: Optional[dt.datetime] = None,
) -> Verdict:
    """Pure decision function: no network, no subprocess (except via injected callables)."""
    rules = cfg["rules"]
    expected = f"plots/{login}.json"
    others = [f for f in files if not f["filename"].startswith("plots/")]
    if others:
        return Verdict("manual", summary="This pull request changes files outside `plots/`, so a maintainer must review it.")
    if len(files) > MAX_FILES:
        return Verdict("rejected", [f"Too many files changed ({len(files)}). A build PR changes only `{expected}`."])
    if not files:
        return Verdict("rejected", ["No files changed."])

    errors: list[str] = []
    if not pc.LOGIN_RE.match(login):
        errors.append("Unrecognised GitHub login.")
    for f in files:
        name, status = f["filename"], f["status"]
        if name != expected:
            errors.append(f"`{name}` is not yours. You may only change `{expected}`.")
        elif status not in ("added", "modified", "changed"):
            errors.append(f"Status `{status}` is not allowed for `{name}`. To clear your plot, commit an empty `blocks` list.")
    if errors:
        return Verdict("rejected", errors)

    lower = login.lower()
    clash = [p for p in existing_plots if p.lower() == lower and p != login]
    if clash:
        return Verdict("rejected", [f"A plot named `{clash[0]}` already exists (names are case-insensitive)."])

    if association not in TRUSTED and rules.get("min_account_age_days", 0) > 0:
        now = now or dt.datetime.now(dt.timezone.utc)
        if account_created is None or (now - account_created).days < rules["min_account_age_days"]:
            return Verdict("rejected", [f"Your GitHub account must be at least {rules['min_account_age_days']} day(s) old to submit builds."])

    raw = read_head(expected)
    if raw is None:
        return Verdict("rejected", [f"Could not read `{expected}` from the pull request."])
    if len(raw) > rules["max_file_bytes"]:
        return Verdict("rejected", [f"`{expected}` is {len(raw)//1024} KB; the limit is {rules['max_file_bytes']//1024} KB."])
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        return Verdict("rejected", [f"`{expected}` is not valid JSON: {str(exc)[:100]}"])

    errs, stats, _ = pc.validate_document(doc, login, cfg, placeable, fetch)
    if errs:
        return Verdict("rejected", errs)
    where = "your own repository (pinned commit)" if stats.kind == "repo" else "this pull request"
    title = stats.title or "Untitled"
    return Verdict("approved", summary=f"**{title}** — {stats.blocks:,} blocks, stored in {where}.")


# --------------------------------------------------------------------------- I/O glue
def run(cmd: list[str], check: bool = True, input_: Optional[str] = None) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True, input=input_)
    if check and res.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed: {res.stderr.strip()[:300]}")
    return res.stdout


def gh_json(*args: str):
    return json.loads(run(["gh", "api", *args]))


def list_files(repo: str, pr: int) -> list[dict]:
    files: list[dict] = []
    for page in range(1, 31):
        batch = gh_json(f"repos/{repo}/pulls/{pr}/files?per_page=100&page={page}")
        files += [{"filename": f["filename"], "status": f["status"]} for f in batch]
        if len(batch) < 100:
            break
    return files


def post_comment(repo: str, pr: int, body: str) -> None:
    body = f"{MARKER}\n{body}"
    comments = gh_json(f"repos/{repo}/issues/{pr}/comments?per_page=100")
    mine = [c for c in comments if MARKER in (c.get("body") or "") and c["user"]["type"] == "Bot"]
    payload = json.dumps({"body": body})
    if mine:
        run(["gh", "api", "-X", "PATCH", f"repos/{repo}/issues/comments/{mine[-1]['id']}", "--input", "-"], input_=payload)
    else:
        run(["gh", "api", "-X", "POST", f"repos/{repo}/issues/{pr}/comments", "--input", "-"], input_=payload)


def set_label(repo: str, pr: int, label: str, color: str) -> None:
    run(["gh", "label", "create", label, "--repo", repo, "--color", color, "--force"], check=False)
    for old in ("pullcraft:approved", "pullcraft:rejected", "pullcraft:needs-review"):
        if old != label:
            run(["gh", "pr", "edit", str(pr), "--repo", repo, "--remove-label", old], check=False)
    run(["gh", "pr", "edit", str(pr), "--repo", repo, "--add-label", label], check=False)


def format_comment(v: Verdict, merged: bool, auto_merge: bool) -> str:
    if v.kind == "approved":
        tail = ("Merged. Your build appears in the live world after the next deploy (usually under two minutes)."
                if merged else ("Looks good. A maintainer will merge it." if not auto_merge else "Looks good, merging…"))
        return f"### ✅ Build accepted\n{v.summary}\n\n{tail}"
    if v.kind == "rejected":
        bullets = "\n".join(f"- {e}" for e in v.errors)
        return f"### ❌ Build rejected\n{bullets}\n\nFix the file and push again; this check re-runs automatically."
    return f"### 👀 Needs review\n{v.summary}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--login", required=True)
    ap.add_argument("--association", default="NONE")
    ap.add_argument("--head-sha", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cfg = pc.load_config()
    blocks = pc.load_blocks()
    placeable = set(pc.block_ids(blocks, placeable_only=True))

    files = list_files(a.repo, a.pr)
    run(["git", "fetch", "--no-tags", "--depth=1", "origin", f"pull/{a.pr}/head"])
    fetched = run(["git", "rev-parse", "FETCH_HEAD"]).strip()
    if fetched != a.head_sha:
        print("Head moved since the event fired; a newer run will handle it.")
        return 0

    def read_head(path: str) -> Optional[bytes]:
        res = subprocess.run(["git", "show", f"FETCH_HEAD:{path}"], capture_output=True)
        return res.stdout if res.returncode == 0 else None

    existing = {p.stem for p in Path("plots").glob("*.json")}
    created = None
    if a.association not in TRUSTED:
        user = gh_json(f"users/{a.login}")
        created = dt.datetime.fromisoformat(user["created_at"].replace("Z", "+00:00"))

    fetch = pc.github_raw_fetch(cfg["rules"]["max_file_bytes"])
    v = evaluate(a.login, a.association, files, read_head, existing, created, cfg, placeable, fetch)
    print(f"verdict: {v.kind}")
    for e in v.errors:
        print(f" - {e}")

    merged = False
    out = os.environ.get("GITHUB_OUTPUT")
    if v.kind == "approved" and cfg["rules"]["auto_merge"] and not a.dry_run:
        try:
            run(["gh", "pr", "merge", str(a.pr), "--repo", a.repo, "--squash",
                 "--match-head-commit", a.head_sha, "--subject", f"Update plot: {a.login} (#{a.pr})"])
            merged = True
        except RuntimeError as exc:
            print(f"merge failed: {exc}")
            v = Verdict("rejected", ["Automatic merge failed (the branch may have changed). Push again to retry."])
    if not a.dry_run:
        if v.kind == "manual" and a.association in TRUSTED:
            pass  # maintainers' code PRs: stay quiet
        else:
            post_comment(a.repo, a.pr, format_comment(v, merged, cfg["rules"]["auto_merge"]))
        label = {"approved": ("pullcraft:approved", "2da44e"), "rejected": ("pullcraft:rejected", "cf222e"),
                 "manual": ("pullcraft:needs-review", "d4a72c")}[v.kind]
        if not (v.kind == "manual" and a.association in TRUSTED):
            set_label(a.repo, a.pr, *label)
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"merged={'true' if merged else 'false'}\nverdict={v.kind}\n")
    return 1 if v.kind == "rejected" else 0


if __name__ == "__main__":
    sys.exit(main())
