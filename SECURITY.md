# Security model

**Untrusted input:** plot JSON from any GitHub user, pointer targets, titles.

| Threat | Defence |
| --- | --- |
| Editing someone else's plot | Validator requires the only changed file to be exactly `plots/<PR author login>.json` |
| Running attacker code in CI | `pull_request_target` checks out only the base branch; PR content is read with `git show` and `json.loads` |
| PR changed after validation | `gh pr merge --match-head-commit <validated sha>` |
| Huge or malformed files | Size, block-count, schema, range and duplicate checks; same code re-runs in the builder |
| Content swapped after merge (linked repos) | Pointers must name a 40-char commit SHA, and the repo owner must equal the plot owner |
| Markup injection via titles | Titles limited to a plain-text character set; client only uses `textContent` |
| Token theft | Tokens are typed by the player, sent only to `api.github.com`, never stored. Page CSP blocks other origins |
| Throwaway accounts | Minimum account age (config) |
| Workflow tampering | Non-`plots/` changes are never auto-merged; protect `.github/` with CODEOWNERS/rulesets |

**Moderation:** to remove a bad build, commit an empty `blocks` list to that player's file (don't delete it; slots must stay stable). Titles aren't profanity-filtered.

Report vulnerabilities privately via GitHub Security Advisories.
