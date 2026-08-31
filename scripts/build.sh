#!/usr/bin/env bash
#
# 一键打包 dist/function.zip —— 直接上传到 Scaleway 部署。
#
# 行为：
#   1. 从 anomalyco/opencode 的 GitHub Release 下载官方 Linux 二进制
#      （这是"原汁原味"的 opencode，不是重新实现）。
#   2. 连同 handler、代理代码一起打成 zip：dist/function.zip
#
# 可选环境变量：
#   OPENCODE_VERSION   下载哪个版本（默认 latest；可填 v1.18.25 之类的 tag）
#   OPENCODE_ARCH      目标架构（x64 / arm64；默认按本机 CPU 推断）
#   OPENCODE_BIN_URL   完全自定义二进制下载地址（跳过默认推断）
#   FORCE=1            强制重新下载二进制

set -eu
cd "$(dirname "$0")/.."

REPO="anomalyco/opencode"
ARCH="${OPENCODE_ARCH:-}"
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "错误：无法推断架构 $(uname -m)，请设置 OPENCODE_ARCH=x64|arm64" >&2; exit 1 ;;
  esac
fi

VERSION="${OPENCODE_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  VERSION="$(\
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -oE '"tag_name"[^,]*' | head -1 | sed -E 's/.*"([^"]+)"$/\1/' \
  )"
  if [ -z "$VERSION" ]; then
    echo "错误：无法获取 latest 版本号。可设置 OPENCODE_VERSION=v1.18.25 之类的 tag 重试。" >&2
    exit 1
  fi
fi
echo "==> 目标 opencode 版本：$VERSION（架构：$ARCH）"

BIN_DIR="vendor/opencode/$ARCH"
BIN="$BIN_DIR/opencode"
mkdir -p "$BIN_DIR"
if [ ! -x "$BIN" ] || [ "${FORCE:-0}" = "1" ]; then
  if [ -n "${OPENCODE_BIN_URL:-}" ]; then
    URL="$OPENCODE_BIN_URL"
  else
    # Linux CLI 二进制是 tar.gz（glibc 版）。需要兼容老 CPU 用 baseline，
    # 纯静态用 musl；这两种可通过 OPENCODE_BIN_URL 自定义。
    TGZ="opencode-linux-$ARCH.tar.gz"
    URL="https://github.com/$REPO/releases/download/$VERSION/$TGZ"
  fi
  echo "==> 下载 $URL"
  TMPTAR="$(mktemp)"
  curl -fL --retry 3 -o "$TMPTAR" "$URL"
  # 解压出名为 opencode 的可执行文件
  rm -rf "$BIN_DIR/__x"
  mkdir -p "$BIN_DIR/__x"
  tar -xzf "$TMPTAR" -C "$BIN_DIR/__x" 2>/dev/null || true
  rm -f "$BIN"
  find "$BIN_DIR/__x" -type f -name opencode -exec mv {} "$BIN" \; -quit
  rm -rf "$BIN_DIR/__x"
  rm -f "$TMPTAR"
  chmod +x "$BIN" 2>/dev/null || true
  if [ ! -x "$BIN" ]; then
    echo "错误：解压后找不到 opencode 可执行文件（$BIN）。压缩包结构可能变化，可设置 OPENCODE_BIN_URL。" >&2
    exit 1
  fi
fi

echo "==> 校验二进制"
"$BIN" --version || true

echo "==> 组装 dist/stage"
STAGE="dist/stage"
rm -rf dist
mkdir -p "$STAGE/bin" "$STAGE/src"
cp handler.js package.json "$STAGE/"
cp src/*.js "$STAGE/src/"
cp "$BIN" "$STAGE/bin/opencode"

echo "==> 打包 dist/function.zip"
if ! command -v zip >/dev/null 2>&1; then
  echo "错误：系统缺少 zip 命令。请安装 zip，或改用 GitHub Actions workflow 打包。" >&2
  exit 1
fi
( cd "$STAGE" && zip -qr ../function.zip . )

SIZE="$(du -h dist/function.zip | cut -f1)"
echo ""
echo "完成：dist/function.zip （$SIZE）"
echo "把它上传到 Scaleway Serverless Functions 即可（入口文件 handler，导出函数 handle）。"