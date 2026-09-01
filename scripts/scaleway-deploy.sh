#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${SCW_DEFAULT_REGION:-fr-par}"
NS_ID="${SCW_FUNCTION_NAMESPACE_ID:-}"
NS_NAME="${SCW_FUNCTION_NAMESPACE:-}"
FUNCTION_NAME="${SCW_FUNCTION_NAME:-opencode-proxy}"
RUNTIME="${SCW_FUNCTION_RUNTIME:-node22}"
HANDLER="${SCW_FUNCTION_HANDLER:-handler.handle}"
MEMORY="${SCW_FUNCTION_MEMORY_LIMIT:-256}"
TIMEOUT="${SCW_FUNCTION_TIMEOUT:-300}"
# scw 的 timeout 参数要求带单位的 duration（如 300s）；兼容旧配置里的裸数字，自动补 s。
case "$TIMEOUT" in *[a-zA-Z]*) ;; *) TIMEOUT="${TIMEOUT}s" ;; esac
PRIVACY="${SCW_FUNCTION_PRIVACY:-public}"
MIN_SCALE="${SCW_FUNCTION_MIN_SCALE:-0}"
MAX_SCALE="${SCW_FUNCTION_MAX_SCALE:-1}"
DEFAULT_MODEL="${SCW_FUNCTION_DEFAULT_MODEL:-}"
ZIP_FILE="${ZIP_FILE:-dist/function.zip}"
DRY_RUN="${DRY_RUN:-0}"

: "${OPENCODE_API_KEY:?需要设置 OPENCODE_API_KEY（GitHub secret）}"
: "${PROXY_API_KEY:?需要设置 PROXY_API_KEY（GitHub secret）}"
[ -f "$ZIP_FILE" ] || { echo "错误：找不到 $ZIP_FILE（先跑 scripts/build.sh）" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY-RUN: scw $*"
    return 0
  fi
  scw "$@"
}

json_field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const v=Array.isArray(a)?a[0]:a;console.log(v&&v['$1']?v['$1']:'')}catch{console.log('')}})"
}

echo "==> 区域      : $REGION"
echo "==> 函数      : $FUNCTION_NAME (runtime=$RUNTIME handler=$HANDLER memory=${MEMORY}MB timeout=$TIMEOUT privacy=$PRIVACY)"

if [ -z "$NS_ID" ]; then
  if [ -n "$NS_NAME" ]; then
    NS_ID="$(scw function namespace list name="$NS_NAME" region="$REGION" -o json | json_field id)"
    [ -n "$NS_ID" ] || { echo "错误：找不到命名空间 $NS_NAME。" >&2; exit 1; }
  else
    echo "==> 未指定 namespace，查询当前项目的默认 namespace……"
    NS_ID="$(scw function namespace list region="$REGION" -o json | json_field id)"
    if [ -z "$NS_ID" ]; then
      echo "==> 没有现有 namespace，创建 opencode-default……"
      run function namespace create name="opencode-default" region="$REGION"
      NS_ID="$(scw function namespace list name="opencode-default" region="$REGION" -o json | json_field id)"
    fi
    [ -n "$NS_ID" ] || { echo "错误：无法解析或创建默认 namespace。" >&2; exit 1; }
  fi
fi
echo "==> 命名空间  : $NS_ID"

# 不隐藏 CLI 输出：权限、项目/区域不匹配等错误必须出现在 Actions 日志中。
FUNCTIONS_JSON="$(scw function function list namespace-id="$NS_ID" name="$FUNCTION_NAME" region="$REGION" -o json)"
FID="$(printf '%s' "$FUNCTIONS_JSON" | json_field id)"
if [ -z "$FID" ]; then
  echo "==> 函数不存在，创建 $FUNCTION_NAME……"
  run function function create \
    name="$FUNCTION_NAME" namespace-id="$NS_ID" runtime="$RUNTIME" handler="$HANDLER" \
    memory-limit="$MEMORY" timeout="$TIMEOUT" privacy="$PRIVACY" \
    min-scale="$MIN_SCALE" max-scale="$MAX_SCALE" \
    "environment-variables.OPENCODE_API_KEY=$OPENCODE_API_KEY" \
    "environment-variables.PROXY_API_KEY=$PROXY_API_KEY" \
    ${DEFAULT_MODEL:+"environment-variables.OPENCODE_DEFAULT_MODEL=$DEFAULT_MODEL"} \
    region="$REGION"
  FUNCTIONS_JSON="$(scw function function list namespace-id="$NS_ID" name="$FUNCTION_NAME" region="$REGION" -o json)"
  FID="$(printf '%s' "$FUNCTIONS_JSON" | json_field id)"
else
  echo "==> 函数已存在 ($FID)，同步环境变量……"
  run function function update "$FID" \
    memory-limit="$MEMORY" \
    "environment-variables.OPENCODE_API_KEY=$OPENCODE_API_KEY" \
    "environment-variables.PROXY_API_KEY=$PROXY_API_KEY" \
    ${DEFAULT_MODEL:+"environment-variables.OPENCODE_DEFAULT_MODEL=$DEFAULT_MODEL"} \
    redeploy=false region="$REGION"
fi

[ -n "$FID" ] || { echo "错误：函数创建后仍无法解析函数 ID。" >&2; exit 1; }
echo "==> 上传 $ZIP_FILE 并部署……"
SIZE="$(wc -c < "$ZIP_FILE" | tr -d ' ')"
[ "$SIZE" -le 104857600 ] || { echo "错误：$ZIP_FILE 超过 Scaleway 100MiB 上限" >&2; exit 1; }
run function deploy name="$FUNCTION_NAME" namespace-id="$NS_ID" runtime="$RUNTIME" zip-file="$ZIP_FILE" region="$REGION"

echo "==> 部署完成。函数地址："
scw function function get "$FID" region="$REGION" -o json | json_field domain_name || true
