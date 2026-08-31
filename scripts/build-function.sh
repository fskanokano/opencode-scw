#!/usr/bin/env bash
#
# One-click build of function.zip for Scaleway Serverless Functions.
#
# Usage:
#   bash scripts/build-function.sh
#   OPENCODE_VERSION=v1.18.25 OPENCODE_TARGET=linux-x64-baseline bash scripts/build-function.sh
#
# Env:
#   OPENCODE_VERSION  Version tag or "latest" (default: latest)
#   OPENCODE_TARGET   linux-x64 (default) | linux-x64-baseline | linux-arm64
#   OUTPUT            Output file (default: function.zip)
#   NO_ZIP=1          Only fetch the binary, skip zipping (used by local dev)
#
# Requirements: curl, tar, zip
#
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v zip >/dev/null 2>&1; then
  echo "ERROR: 'zip' is required but not installed." >&2
  exit 1
fi

if [ "${NO_ZIP:-0}" = "1" ]; then
  bash scripts/fetch-opencode.sh
  exit 0
fi

bash scripts/fetch-opencode.sh

OUT="${OUTPUT:-function.zip}"
rm -f "$OUT"
echo "==> packaging function.zip"
(
  cd function
  zip -qr "../$OUT" .
)

SIZE="$(du -h "$OUT" | cut -f1)"
echo "==> built $OUT ($SIZE)"
echo "    Scaleway Functions zip limit: 100 MiB"
echo "    Upload in the console: Serverless Functions -> create function -> Upload .zip"
