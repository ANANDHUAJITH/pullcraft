#!/usr/bin/env bash
# Configure the GitHub repo for discovery and contributors (needs the GitHub CLI: gh auth login).
#   ./scripts/launch-setup.sh            apply
#   ./scripts/launch-setup.sh --dry-run  show what would happen
set -euo pipefail
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
run() { if [[ $DRY -eq 1 ]]; then printf 'DRY: %s\n' "$*"; else "$@"; fi; }
command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com" >&2; exit 1; }
cd "$(dirname "$0")/.."
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
SITE="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME/"
echo "Configuring $REPO ($SITE)"

run gh repo edit "$REPO" \
  --description "A Minecraft-style world where every building is a pull request. Build with blocks, CSS or XML. Live on GitHub Pages." \
  --homepage "$SITE" --enable-issues --enable-discussions
for t in minecraft voxel threejs github-actions github-pages webgl game procedural-generation css generative-ai open-source hacktoberfest; do
  run gh repo edit "$REPO" --add-topic "$t"
done

label() { run gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force; }
label "good first issue" 7057ff "Small, well-scoped, great for newcomers"
label "help wanted" 008672 "Maintainers would love a hand"
label "blueprint" 1d76db "CSS/XML blueprint language"
label "block" fbca04 "New block types and textures"
label "client" 0e8a16 "Viewer and editor"
label "infra" 5319e7 "Workflows, builder, scale"
label "showcase" f9d0c4 "Featured builds"

issue() { # title, labels, body
  if [[ $DRY -eq 1 ]]; then echo "DRY: issue [$2] $1"; return; fi
  gh issue list --repo "$REPO" --search "in:title \"$1\"" --state all --json title -q '.[].title' | grep -qxF "$1" && return 0
  gh issue create --repo "$REPO" --title "$1" --label "$2" --body "$3" >/dev/null && echo "created: $1"
}
issue "Add more blocks (ice, wool colours, terracotta, glass colours)" "good first issue,block" "Add entries to \`data/blocks.json\`; textures are generated procedurally in \`web/js/engine.js\` (\`paintTile\`). Add a new \`pattern\` if one is needed. Keep colours distinct and run the tests."
issue "Blueprint: stairs, arch and torus shapes" "good first issue,blueprint,help wanted" "Add shapes to BOTH \`scripts/blueprint.py\` and \`web/js/blueprint.js\` (they must stay identical; \`tests/core.test.mjs\` checks parity). Document them in \`docs/BLUEPRINTS.md\` and add a fixture in \`tests/fixtures/\`."
issue "Blueprint: rotate and mirror properties" "blueprint,help wanted" "Let repeated groups be rotated 90 degrees or mirrored on x/z so castles and cities need fewer lines. Mirror Python and JS implementations."
issue "Code editor: line numbers and syntax highlighting" "good first issue,client" "The Code panel is a plain textarea. Add line numbers and light syntax colouring without external dependencies (CSP forbids remote scripts)."
issue "Touch controls for phones and tablets" "client,help wanted" "Add a virtual joystick, look-drag and tap-to-place so PullCraft works on touch screens."
issue "Walking mode with gravity and collision" "client,help wanted" "Add an optional survival-style walk mode (toggle with F) using the existing \`BlockStore\`/terrain lookups."
issue "Auto-generate a screenshot for every plot in CI" "infra,help wanted" "After the build, render each plot with headless Chromium (Playwright), save a thumbnail in \`site/world/thumbs/\`, and show it in the Builders list and profile card."
issue "Day/night cycle and ambient occlusion" "client" "Add a sun cycle and per-vertex ambient occlusion in \`meshChunk\` in \`web/js/core.js\` for a more atmospheric world."
issue "Minimap and shareable coordinates" "client,good first issue" "Show a small top-down map of plots and let players copy a link to their current position."
issue "Titles: configurable word blocklist" "good first issue,infra" "Add \`banned_words\` to \`config.json\` and enforce it in \`scripts/pullcraft.py\` and \`web/js/core.js\` for titles and descriptions."
issue "Incremental builds for large worlds" "infra,help wanted" "Cache compiled plots between deploys (keyed by file hash) and only regenerate changed chunks. See docs/ARCHITECTURE.md 'Scaling path'."
issue "Translate the UI" "good first issue,client" "Pull strings out of \`web/js/app.js\` and \`web/index.html\` into a small i18n table and add a language picker."
echo "Done. Next: pin a Discussions post 'Show your build', and add a screenshot or GIF to the README."
