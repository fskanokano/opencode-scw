#!/usr/bin/env bash
#
# 把 dist/function.zip 部署到 Scaleway Serverless Functions。
# 供 .github/workflows/deploy.yml 调用（本地也可以手动跑）。
#
# 依赖：scw CLI 已配置好（本脚本只认环境变量，见下）。
#
# 必填环境变量：
#   SCW_FUNCTION_NAMESPACE_ID   函数命名空间的 UUID（不填则用名字解析）
#   SCW_FUNCTION_NAMESPACE     命名空间名称（SCW_FUNCTION_NAMESPACE_ID 未填时用）
#   OPENCODE_API_KEY            Zen API Key（写进函数环境变量）
#   PROXY_API_KEY               代理访问密钥（写进函数环境变量）
#
# 可选环境变量：
#   SCW_DEFAULT_REGION          区域（默认 fr-par）
#   SCW_FUNCTION_NAME           函数名（默认 opencode-proxy）
#   SCW_FUNCTION_RUNTIME        运行时（默认 node22）
#   SCW_FUNCTION_HANDLER        入口（默认 handler.handle）
#   SCW_FUNCTION_MEMORY_LIMIT   内存 MB（默认 1024）
#   SCW_FUNCTION_TIMEOUT        超时秒数（默认 300）
#   SCW_FUNCTION_PRIVACY        public|private（默认 public）
#   SCW_FUNCTION_MIN_SCALE      最小实例数（默认 0，省钱）
#   SCW_FUNCTION_MAX_SCALE      最大实例数（默认 1）
#   SCW_FUNCTION_DEFAULT_MODEL  默认模型（可选）
#   ZIP_FILE                    要上传的 zip（默认 dist/function.zip）
#   DRY_RUN=1                   只打印要执行的命令，不真的部署
#
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${SCW_DEFAULT_REGION:-fr-par}"
NS_ID="${SCW_FUNCTION_NAMESPACE_ID:-}"
NS_NAME="${SCW_FUNCTION_NAMESPACE:-}"
FUNCTION_NAME="${SCW_FUNCTION_NAME:-opencode-proxy}"
RUNTIME="${SCW_FUNCTION_RUNTIME:-node22}"
HANDLER="${SCW_FUNCTION_HANDLER:-handler.handle}"
MEMORY="${SCW_FUNCTION_MEMORY_LIMIT:-1024}"
TIMEOUT="${SCW_FUNCTION_TIMEOUT:-300}"
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
  # 从 stdin 的 JSON 里取首个元素的字段
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const v=Array.isArray(a)?a[0]:a;console.log(v&&v['$1']?v['$1']:'')}catch{console.log('')}})"
}

echo "==> 区域      : $REGION"
echo "==> 函数      : $FUNCTION_NAME (runtime=$RUNTIME handler=$HANDLER memory=${MEMORY}MB timeout=${TIMEOUT}s privacy=$PRIVACY)"

# 1) 解析命名空间：显式 ID / 名称优先；都不提供时沿用控制台行为，
# 自动使用当前项目和区域的第一个 namespace。没有 namespace 时创建默认 namespace。
if [ -z "$NS_ID" ]; then
  if [ -n "$NS_NAME" ]; then
    NS_ID="$(scw function namespace list name="$NS_NAME" region="$REGION" -o json | json_field id)"
    if [ -z "$NS_ID" ]; then
      echo "错误：找不到命名空间 $NS_NAME。" >&2
      exit 1
    fi
  else
    echo "==> 未指定 namespace，查询当前项目的默认 namespace……"
    NS_ID="$(scw function namespace list region="$REGION" -o json | json_field id)"
    if [ -z "$NS_ID" ]; then
      echo "==> 没有现有 namespace，创建 opencode-default……"
      run function namespace create name="opencode-default" region="$REGION"
      NS_ID="$(scw function namespace list name="opencode-default" region="$REGION" -o json | json_field id)"
    fi
    if [ -z "$NS_ID" ]; then
      echo "错误：无法解析或创建默认 namespace。" >&2
      exit 1
    fi
  fi
fi
echo "==> 命名空间  : $NS_ID"

# 2) 看函数是否存在——不存在就用正确的参数创建（含环境变量）
FID="$(scw function function list namespace-id="$NS_ID" name="$FUNCTION_NAME" region="$REGION" -o json 2>/dev/null | json_field id)"
if [ -z "$FID" ]; then
  echo "==> 函数不存在，创建 $FUNCTION_NAME……"
  run function function create \
    name="$FUNCTION_NAME" \
    namespace-id="$NS_ID" \
    runtime="$RUNTIME" \
    handler="$HANDLER" \
    memory-limit="$MEMORY" \
    timeout="$TIMEOUT" \
    privacy="$PRIVACY" \
    min-scale="$MIN_SCALE" \
    max-scale="$MAX_SCALE" \
    "environment-variables.OPENCODE_API_KEY=$OPENCODE_API_KEY" \
    "environment-variables.PROXY_API_KEY=$PROXY_API_KEY" \
    ${DEFAULT_MODEL:+"environment-variables.OPENCODE_DEFAULT_MODEL=$DEFAULT_MODEL"} \
    region="$REGION"
  FID="$(scw function function list namespace-id="$NS_ID" name="$FUNCTION_NAME" region="$REGION" -o json 2>/dev/null | json_field id)"
else
  echo "==> 函数已存在 ($FID)，同步环境变量……"
  # redeploy=false：只更新环境变量，不触发一次无谓的构建（下面 function deploy 会带新代码）
  run function function update "$FID" \
    "environment-variables.OPENCODE_API_KEY=$OPENCODE_API_KEY" \
    "environment-variables.PROXY_API_KEY=$PROXY_API_KEY" \
    ${DEFAULT_MODEL:+"environment-variables.OPENCODE_DEFAULT_MODEL=$DEFAULT_MODEL"} \
    redeploy=false \
    region="$REGION"
fi

# 3) 上传代码并部署（create or fetch, upload and deploy）
echo "==> 上传 $ZIP_FILE 并部署……"
# zip 不能超过 100MiB；提前检查
SIZE="$(wc -c < "$ZIP_FILE" | tr -d ' ')"
if [ "$SIZE" -gt 104857600 ]; then
  echo "错误：$ZIP_FILE 有 $((SIZE / 1024 / 1024))MiB，超过 Scaleway 100MiB 上限" >&2
  exit 1
fi
run function deploy \
  name="$FUNCTION_NAME" \
  namespace-id="$NS_ID" \
  runtime="$RUNTIME" \
  zip-file="$ZIP_FILE" \
  region="$REGION"

echo ""
echo "==> 部署完成。函数地址："
scw function function get "$FID" region="$REGION" -o json 2>/dev/null | json_field domain_name || true