# Architecture

```
player ─ editor ─▶ PR (plots/<user>.json) ─▶ validate-pr.yml ─▶ squash merge
                                                       │ gh workflow run
                                                       ▼
 git history ─┐                                   deploy.yml
 plots/*.json ┼─▶ build_world.py ─▶ site/world/{manifest, chunks/, players/, plots/, metadata/} ─▶ Pages
 data/blocks ─┘                                                           ▲
                                  client polls manifest.json every 60 s ──┘
```

**Slots.** Slot 1 is the community plaza at cell (0,0). Players take slots 2… in order of the first commit that added their file (`git log --diff-filter` equivalent, ties by name), laid out on a square spiral of 36-block cells (32 plot + 4 road). Plot files can't be deleted, so slots never shift. History rewrites would reorder players; don't rewrite `main`.

**Chunks.** World chunks are 16×16 columns × 128 high. Only player blocks are stored (flat `[x,y,z,paletteId]` ints, content-hashed file names so they cache forever). Terrain, roads and trees are generated deterministically in the client from `world.seed`; the city floor is flat and surrounded by hills and ocean.

**Client.** `core.js` is pure logic (noise, layout, terrain, chunk voxels, face-culling mesher, DDA raycast, plot rules) and is unit-tested in Node. `engine.js` is Three.js glue (procedural texture atlas, chunk manager with a per-frame meshing budget, fly controls). `app.js` is UI, editor and polling. `github.js` opens PRs from the browser.

**Scaling path.** Per-chunk files and hashes already allow incremental client updates. Next steps: shard `manifest.json` by region, build only changed plots via a cache of previous chunk output, batch deploys under high PR volume (deploy is serialised by a concurrency group), and optionally replace polling with a lightweight notification channel.
