# PullCraft

A shared voxel world where **every building is a pull request**.

- Players build in the browser (creative-mode editor) and open a PR that changes one file: `plots/<github-username>.json`.
- A GitHub Actions workflow validates the PR, squash-merges it, and rebuilds the world.
- GitHub Pages serves the live world. The git history is the world's history: who built what, when, in which PR.

It is an *asynchronous* multiplayer world. Pages serves static files only, so players see each other's builds after each deploy (usually under two minutes), not in real time.

## Set it up (about 5 minutes)

1. Create a repository from these files and push to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions:** allow *Read and write*, and tick *Allow GitHub Actions to create and approve pull requests*.
4. Don't require reviews or status checks on `main`, or the bot can't merge. (Protect `.github/`, `scripts/` and `web/` with CODEOWNERS or a ruleset that exempts the bot if you want.)
5. Edit `.github/CODEOWNERS` and replace `@OWNER_PLACEHOLDER` with your username.
6. Run **Actions → Deploy world → Run workflow**. Your world is at `https://<user>.github.io/<repo>/`.
7. Delete `plots/octocat.json` (the demo cottage) when you're ready.

## Run it locally

```bash
python scripts/build_world.py --out site
python -m http.server -d site 8000      # open http://localhost:8000
```

Tests: `python -m unittest discover -s tests` and `SITE=site node --test tests/core.test.mjs`.

## How a build becomes part of the world

1. Build in the **Build** tab (left click break, right click place, middle click pick, `E` palette, `Ctrl+Z`).
2. **Submit build…** Paste a GitHub token with `public_repo` and the editor forks the repo, commits `plots/<you>.json` and opens the PR. No token? Download the file and upload it on GitHub; it offers to open the PR for you.
3. `validate-pr.yml` checks the PR, comments the result, and squash-merges it if valid.
4. `deploy.yml` runs `build_world.py`, which turns every plot into chunk files and publishes the site.
5. Open clients poll `world/manifest.json` every minute and hot-swap only the chunks whose hash changed.

## Keep your build in your own repo (optional)

Tick the checkbox in the submit panel, or commit a pointer file by hand:

```json
{"version":1,"title":"My Castle","source":{"repo":"you/pullcraft-builds","path":"plot.json","sha":"<40-char commit sha>"}}
```

The world fetches the file at that exact commit, so you own your data, nobody can swap content after merge, and you update by opening a new PR with a new SHA. The repo owner must match the plot owner.

## Rules (see `config.json`)

32×64×32 blocks per plot, 30,000 blocks max, 43 block types (`data/blocks.json`), one plot per account (the file name is your GitHub login), plots can be cleared but not deleted (so everyone else's plot position stays stable), accounts must be 1 day old.

## Layout

| Path | Purpose |
| --- | --- |
| `plots/` | one JSON file per player |
| `scripts/pullcraft.py` | rules, validation, layout (single source of truth) |
| `scripts/validate_pr.py` | PR check + auto-merge |
| `scripts/build_world.py` | plots + git history → chunked world in `site/` |
| `web/` | Three.js client (vendored, no CDN): viewer, editor, PR submission |
| `docs/ARCHITECTURE.md`, `SECURITY.md` | design and threat model |

Assets: textures are generated procedurally in the browser (nothing to license). three.js r128 is bundled under MIT. To use a CC0 texture pack, replace `paintAtlas` in `web/js/engine.js`.

## Known limits

Desktop browsers only (no touch controls). Fly-mode creative building; no walking, survival or crafting yet. The plot spiral grows forever, but very large worlds will want sharded manifests.

MIT licensed.
