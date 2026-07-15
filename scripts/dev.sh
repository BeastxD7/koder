#!/usr/bin/env bash
# Install deps, compile, and launch the LakshX dev build (Electron, unsigned).
set -euo pipefail
cd "$(dirname "$0")/../upstream"

# compile-client only: we deliberately skip compile-copilot — LakshX replaces it
[ -d node_modules ] || npm install
npm run compile-client
exec ./scripts/code.sh "$@"
