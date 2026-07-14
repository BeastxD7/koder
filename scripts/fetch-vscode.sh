#!/usr/bin/env bash
# Shallow-clone code-oss at the pinned tag from upstream-version.json into upstream/.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=$(node -p "require('./upstream-version.json').tag")
REPO=$(node -p "require('./upstream-version.json').repo")

if [ -d upstream/.git ]; then
  CURRENT=$(git -C upstream describe --tags --exact-match 2>/dev/null || echo none)
  if [ "$CURRENT" = "$TAG" ]; then
    echo "upstream/ already at $TAG"
    exit 0
  fi
  echo "upstream/ at '$CURRENT', re-fetching $TAG"
  git -C upstream fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git -C upstream checkout -f "tags/$TAG"
else
  rm -rf upstream
  git clone --depth 1 --branch "$TAG" "$REPO" upstream
fi

echo "upstream/ ready at $TAG"
