# Contributing

Thanks for helping! PullCraft is easiest to improve in small steps.

**Build something:** change only your own plot file (`plots/<your-github-username>.json|css|xml`). The bot validates and merges it. See [docs/BLUEPRINTS.md](docs/BLUEPRINTS.md) to build with CSS or XML.

**Fix or add a feature:**
1. Pick an issue labelled `good first issue` or `help wanted`, and comment that you're on it.
2. Fork, branch, change.
3. Run the tests: `python -m unittest discover -s tests` and `npm ci && python scripts/build_world.py --out site && SITE=site node --test tests/core.test.mjs`.
4. Open a PR describing what and why. A screenshot helps for visual changes.

**Two rules that keep the project honest**
- `scripts/pullcraft.py` ↔ `web/js/core.js`, and `scripts/blueprint.py` ↔ `web/js/blueprint.js` are mirrors. Change both; the parity tests fail otherwise.
- Anything that handles pull-request content must treat it as untrusted data. Never execute it. Read [SECURITY.md](SECURITY.md) first.

Maintainer shortcut: `./push.sh -t "message"` runs the tests, commits, syncs and pushes.
