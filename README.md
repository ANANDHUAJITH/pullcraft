<div align="center">

# ⛏️ PullCraft

**A Minecraft-style world where every building is a pull request.**

Build with blocks, with **CSS**, or with **XML** (hand-written or AI-generated). GitHub Actions validates your build, merges it, and the live world updates for everyone.

[**▶ Live world**](https://anandhuajith.github.io/pullcraft/) · [Blueprint guide](docs/BLUEPRINTS.md) · [Contribute](CONTRIBUTING.md) · [Roadmap](#roadmap)

[![CI](https://github.com/ANANDHUAJITH/pullcraft/actions/workflows/ci.yml/badge.svg)](https://github.com/ANANDHUAJITH/pullcraft/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-f2b134)
![No build step](https://img.shields.io/badge/client-no%20build%20step-5aa63a)

</div>

<!-- Add docs/hero.gif after your first deploy: fly over the city, open a plot, press Code, preview. -->

## Three ways to build

| | For | How |
| --- | --- | --- |
| 🧱 **Blocks** | Anyone, no code | Place and break blocks in the in-browser creative editor |
| 🎨 **CSS-style blueprint** | Developers and designers | Describe shapes with `width`, `height`, `repeat-x`, `var(--wall)`… |
| 📐 **XML blueprint** | Tools and AI | `<walls>`, `<group>`, `<let>`… compiled the same way |

```css
:root { --title: Tiny Cottage; --plank: oak_planks; }
.walls { shape: walls;   x: 9; y: 1; z: 9; width: 14; height: 4; depth: 12; block: var(--plank); }
.door  { shape: box;     x: 15; y: 1; z: 9; width: 2; height: 3; depth: 1;  block: air; }
.roof  { shape: pyramid; x: 8; y: 5; z: 8; width: 16; height: 6; depth: 14; block: bricks; }
```

Press **Copy AI prompt** in the Code panel, paste it into any chat AI with your idea ("a Gothic cathedral with a glowing rose window"), and paste the reply back to preview it instantly. Everyone can read and remix each other's source from the plot's profile. Full reference: [docs/BLUEPRINTS.md](docs/BLUEPRINTS.md).

## How it works

```
 browser editor ──▶ pull request (plots/<you>.json | .css | .xml)
                         │  validate-pr.yml: ownership, schema, limits, compile
                         ▼  squash merge  →  deploy.yml
   plots + git history ──▶ build_world.py ──▶ chunked world ──▶ GitHub Pages
                                                    ▲
                      open clients poll the manifest and hot-swap changed chunks
```

- **GitHub is the backend:** PRs are submissions, Actions is the validator and build server, Pages is the game client, git history is the world's history (who built what, when, in which PR).
- **Asynchronous multiplayer:** Pages serves static files, so builds appear after each deploy (about two minutes), not in real time.
- **Own your build:** keep it in your own repo; the world pins it to an exact commit.
- **Safe by design:** blueprints are compiled by a bounded, deterministic compiler. Nothing from a PR is ever executed. See [SECURITY.md](SECURITY.md).

## Set it up (5 minutes)

1. Push this repo to GitHub (`./push.sh -r https://github.com/<you>/pullcraft.git "first upload"`).
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Actions → General →** *Read and write permissions* and *Allow GitHub Actions to create and approve pull requests*.
4. Don't require reviews or status checks on `main` (the bot merges valid builds).
5. **Actions → Deploy world → Run workflow.** Your world is at `https://<you>.github.io/pullcraft/`.
6. Run `./scripts/launch-setup.sh` (needs the GitHub CLI) to set topics, labels and starter issues that attract contributors.
7. Delete `plots/demo-*` and `plots/octocat.json` once real builders arrive.

Run locally: `python scripts/build_world.py --out site && python -m http.server -d site`.
Publishing edits later: `./push.sh "what I changed"` (add `-t` to run tests first).

## Rules

32×64×32 blocks per plot · 30,000 blocks · one plot per account (file name = your GitHub login; `.json`, `.css` or `.xml`) · plots can be cleared but not deleted, so nobody's position shifts · 43 block types · accounts must be a day old. Tune everything in `config.json`.

## Layout

| Path | Purpose |
| --- | --- |
| `plots/` | one file per player |
| `examples/` | ready-made blueprints (also loadable from the Code panel) |
| `scripts/pullcraft.py` | rules and validation, single source of truth |
| `scripts/blueprint.py` ↔ `web/js/blueprint.js` | CSS/XML compilers, kept identical by parity tests |
| `scripts/validate_pr.py`, `build_world.py` | PR check and auto-merge; world builder |
| `web/` | Three.js client: viewer, editor, code panel, PR submission (bundled, no CDN) |
| `push.sh`, `scripts/launch-setup.sh` | publish edits; configure the repo for contributors |

Tests: `python -m unittest discover -s tests` and `npm ci && SITE=site node --test tests/core.test.mjs`.

## Roadmap

Walking mode · touch controls · per-plot screenshots · more shapes (stairs, arch, torus) · rotate/mirror · incremental builds for huge worlds · day/night. Each has a `good first issue` or `help wanted` ticket after you run `launch-setup.sh`.

## Contributing

Builders: open a PR that changes your own plot file. Developers: see [CONTRIBUTING.md](CONTRIBUTING.md). Everyone: be kind ([Code of Conduct](CODE_OF_CONDUCT.md)). If PullCraft made you smile, a ⭐ helps others find it.

Assets: textures are generated in the browser (nothing to license); three.js r128 is bundled (MIT). MIT licensed.
