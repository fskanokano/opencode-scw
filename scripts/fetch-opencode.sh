#!/usr/bin/env bash
#
# Download the opencode binary into function/opencode.
#
# Usage:
#   OPENCODE_VERSION=v1.18.25 OPENCODE_TARGET=linux-x64 bash scripts/fetch-opencode.sh
#
# Env:
#   OPENCODE_VERSION  Version tag (e.g. v1.18.25) or "latest" (default: latest)
#   OPENCODE_TARGET   linux-x64 (default) | linux-x64-baseline | linux-arm64
#
# Targets:
#   linux-x64           requires AVX2 (all modern Scaleway CPUs)
#   linux-x64-baseline  no AVX2 requirement — use if the function crashes on start (SIGILL)
#   linux-arm64         ARM64 (containers only; Scaleway Functions are x86_64)
#
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${OPENCODE_VERSION:-latest}"
TARGET="${OPENCODE_TARGET:-linux-x64}"
ARCHIVE="opencode-${TARGET}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/anomalyco/opencode/releases/latest/download/${ARCHIVE}"
else
  URL="https://github.com/anomalyco/opencode/releases/download/${VERSION#v}/${ARCHIVE}"
fi

echo "==> Downloading opencode ${VERSION} (${TARGET})"
curl -fsSL -o "/tmp/opencode-scw-${TARGET}.tar.gz" "$URL"
TMP="$(mktemp -d)"
tar -xzf "/tmp/opencode-scw-${TARGET}.tar.gz" -C "$TMP"
rm -f "/tmp/opencode-scw-${TARGET}.tar.gz"

mkdir -p function
install -m 755 "$TMP/opencode" function/opencode
rm -rf "$TMP"

"function/opencode" --version
echo "==> binary ready: function/opencode"
