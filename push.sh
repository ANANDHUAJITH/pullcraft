#!/usr/bin/env bash
# One-command publish: stage everything, commit, sync with GitHub, push.
#
#   ./push.sh "add pagoda example"        commit + push
#   ./push.sh -t "fix chunk bug"          run the tests first, push only if they pass
#   ./push.sh -r https://github.com/ANANDHUAJITH/pullcraft.git "first upload"
#   ./push.sh                              auto-generates the commit message
#
# It never force-pushes. If someone else changed the repo (for example the bot merged
# a build), it rebases your work on top first.
set -euo pipefail

BRANCH="main"
REMOTE_URL=""
RUN_TESTS=0
MSG=""

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--test)   RUN_TESTS=1; shift ;;
    -r|--remote) REMOTE_URL="${2:?--remote needs a URL}"; shift 2 ;;
    -b|--branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    -h|--help)   usage 0 ;;
    -*)          echo "Unknown option: $1" >&2; usage 1 ;;
    *)           MSG="$1"; shift ;;
  esac
done

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed."
cd "$(dirname "$0")"

if [[ ! -d .git ]]; then
  say "Creating a new git repository"
  git init -q -b "$BRANCH"
fi

# Remote
if ! git remote get-url origin >/dev/null 2>&1; then
  if [[ -z "$REMOTE_URL" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "GitHub repo URL (https://github.com/<you>/pullcraft.git): " REMOTE_URL
    fi
    [[ -n "$REMOTE_URL" ]] || die "No remote yet. Run: ./push.sh -r https://github.com/<you>/<repo>.git \"message\""
  fi
  say "Adding remote origin -> $REMOTE_URL"
  git remote add origin "$REMOTE_URL"
elif [[ -n "$REMOTE_URL" ]]; then
  git remote set-url origin "$REMOTE_URL"
fi

# Identity (only if git has none)
if ! git config user.name >/dev/null; then die "Set your identity first: git config --global user.name \"You\" && git config --global user.email you@example.com"; fi
if ! git config user.email >/dev/null; then die "Set your email first: git config --global user.email you@example.com"; fi

# Tests
if [[ $RUN_TESTS -eq 1 ]]; then
  say "Running tests"
  python3 -m unittest discover -s tests
  if command -v node >/dev/null; then
    [[ -d node_modules ]] || { command -v npm >/dev/null && npm install --silent || true; }
    python3 scripts/build_world.py --out .test-site >/dev/null
    SITE=.test-site node --test tests/core.test.mjs
    rm -rf .test-site
  fi
fi

# Make sure we are on the right branch
current="$(git symbolic-ref --short -q HEAD || true)"
if [[ "$current" != "$BRANCH" ]]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then git checkout -q "$BRANCH"; else git checkout -q -B "$BRANCH"; fi
fi

# Commit
git add -A
if git diff --cached --quiet; then
  say "Nothing new to commit"
else
  [[ -n "$MSG" ]] || MSG="Update $(date '+%Y-%m-%d %H:%M')"
  git commit -q -m "$MSG"
  say "Committed: $MSG"
fi

# Sync + push
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  say "Syncing with origin/$BRANCH"
  if ! git pull --rebase --autostash -q origin "$BRANCH"; then
    git rebase --abort >/dev/null 2>&1 || true
    die "Your changes conflict with what is on GitHub. Run: git pull --rebase origin $BRANCH, fix the conflicts, then ./push.sh again."
  fi
fi
say "Pushing to origin/$BRANCH"
git push -u origin "$BRANCH"
url="$(git remote get-url origin | sed -E 's#git@github.com:#https://github.com/#; s#\.git$##')"
say "Done: $url"
