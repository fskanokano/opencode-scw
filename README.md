# opencode-scw —— 在 Scaleway Serverless Function 里跑"原汁原味"的 opencode

把一个真实的 [OpenCode](https://github.com/anomalyco/opencode) 放进 Scaleway
Serverless Function，外面套一个 OpenAI 兼容接口。你把任意 OpenAI 客户端的
`baseURL` 指到函数的地址，就能当一个"原生 OpenAI 服务"来用——底下跑的都是
真正的 opencode，而不是我们重写的大模型代理。

## 核心思路（重要）

你要求的并不是"用 opencode 命名、我们自己调大模型"，而是一个**网关**：

- 我们的代码**只做翻译**：把 `/v1/chat/completions` 里的用户提问原样交给真正的
  opencode 去执行；
- **真正的大模型对话、agent 工具调用全部由 opencode 自己完成**（它加载 Zen
  配置、调 Zen 大模型、跑 agent 循环）；
- 我们再把 opencode 的回复原样翻译回 OpenAI 返回格式。

具体实现用官方 [`@opencode-ai/sdk`](https://opencode.ai/docs/sdk)（npm 安装，
零手工编译）：函数进程启动时用 `createOpencode()` 拉起**一个共享的 opencode
server**（常驻子进程），拿到类型安全 client；之后所有请求通过这个 client 走
`session.create` / `session.prompt`，不再每个请求 spawn 一次。SDK 由 opencode
官方维护，opencode 在这里就是被当作一个 npm 依赖使用的第三方库。

```
你的 OpenAI 客户端
   │  POST /v1/chat/completions   (Bearer PROXY_API_KEY)
   ▼
┌─ Scaleway Serverless Function ───────────────┐
│  适配层（handler/proxy，内嵌在函数里）          │
│     │ @opencode-ai/sdk（共享 client）          │
│     ▼                                        │
│  opencode server（常驻子进程，官方 SDK 启动）  │
│     │ 读 auth.json（Zen 凭据）→ 调用大模型     │
│     ▼                                        │
│  opencode 的回复 → 翻译回 OpenAI 格式          │
└───────────────────────────────────────────────┘
```

## 环境变量（只有两个必填）

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_API_KEY` | **opencode Zen 的 API Key**。去 [opencode.ai](https://opencode.ai) 登录创建 Zen 后复制。opencode 原生认这个变量名；适配层也会把它写进 opencode 的 `auth.json`，双保险。 |
| `PROXY_API_KEY` | **你代理函数自己的访问密钥**，任意调用方都必须带 `Authorization: Bearer <PROXY_API_KEY>`。 |

可选变量见 `env.example`（默认模型、SDK server 地址/端口、数据目录等）。

## 项目结构

```
handler.js              # Scaleway 入口（导出 handle）；node dist/handler.js 也能本地跑
src/opencode.js         # 通过 @opencode-ai/sdk 启动并复用共享 opencode server
src/proxy.js            # OpenAI 兼容适配层：/v1/models、/v1/chat/completions
src/zen-models.js       # 静态 Zen 模型清单（作为 server 不可用时的兜底）
scripts/build.sh           # 一键打包 dist/function.zip（含官方 opencode 二进制 + SDK 依赖）
scripts/scaleway-deploy.sh # 把 dist/function.zip 部署到 Scaleway（供 CICD 调用）
scripts/run-local.mjs      # 本地联调启动器（会先打包）
.github/workflows/deploy.yml          # 推送到 main 自动打包并部署到 Scaleway
.github/workflows/build-function.yml  # 手动一键打包 function.zip（只打包不部署）
env.example                # 环境变量模板
```

## 本地联调

```bash
# 1. 建一份本地 .env（或者直接在命令行设两个环境变量）
cp env.example .env
#    编辑 .env，填好 OPENCODE_API_KEY、PROXY_API_KEY

# 2. 启动（会先下载真实 opencode 二进制并打一次包）
node scripts/run-local.mjs
#    默认监听 http://127.0.0.1:8787/v1
```

在另一个终端试试：

```bash
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"

curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"用一句话打招呼"}]}'
```

## 一键打包 function.zip

**本地打包：**

```bash
sh scripts/build.sh
# 产物：dist/function.zip（包含真实 opencode 二进制 + 代理代码，约 58MB）
```

脚本默认从 `anomalyco/opencode` 的最新 Release 下载官方 Linux 二进制（`x64` 或
`arm64`，按本机 CPU 自动判断），所以部署的确实是 opencode 本体。想锁定版本用
`OPENCODE_VERSION=v1.18.25`，老 CPU 用 baseline 或 musl 版可用 `OPENCODE_BIN_URL` 覆盖。

**GitHub Actions 一键打包：**

1. 把你这个仓库推到 GitHub；
2. 打开仓库 `Actions` → `Build function.zip` → `Run workflow`；
3. 跑完在 build 的 `Artifacts` 里下载 `function.zip`。

## 自动部署（GitHub Actions CICD，推荐）

仓库里已经配好 `.github/workflows/deploy.yml`：**推送到 `main` 分支自动重新部署**，
也可以手动触发（Actions → Deploy to Scaleway → Run workflow）。Scaleway 凭据全部
从 GitHub Secrets 读取，不写死在仓库里。

### 1. 准备 GitHub Secrets

Settings → Secrets and variables → Actions → New repository secret：

| Secret | 说明 |
| --- | --- |
| `SCW_ACCESS_KEY` | Scaleway API Access Key（控制台 → IAM → API keys） |
| `SCW_SECRET_KEY` | Scaleway API Secret Key（创建 API key 时只显示一次） |
| `SCW_DEFAULT_ORGANIZATION_ID` | Scaleway 组织 ID（`scw init` 里能查到） |
| `SCW_DEFAULT_PROJECT_ID` | Scaleway 项目 ID |
| `OPENCODE_API_KEY` | opencode Zen API Key（会写进函数环境变量） |
| `PROXY_API_KEY` | 代理访问密钥（会写进函数环境变量） |

### 2. 准备仓库变量（可选，一般只需命名空间）

同一页面切到 **Variables** 标签：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `SCW_FUNCTION_NAMESPACE_ID` | 无 | **建议设置**：你的函数命名空间 UUID（控制台 Functions 页 URL 里能看到）。不设置则按名称查找 |
| `SCW_FUNCTION_NAMESPACE` | 无 | 命名空间名称（不填 ID 时用它来查） |
| `SCW_FUNCTION_NAME` | `opencode-proxy` | 函数名 |
| `SCW_DEFAULT_REGION` | `fr-par` | 区域（`fr-par`／`nl-ams`） |
| `SCW_FUNCTION_RUNTIME` | `node22` | 函数运行时 |
| `SCW_FUNCTION_MEMORY_LIMIT` | `1024` | 内存 MB |
| `SCW_FUNCTION_TIMEOUT` | `300` | 超时秒数 |
| `SCW_FUNCTION_PRIVACY` | `public` | `public`（带 Bearer 密钥访问）或 `private` |
| `SCW_FUNCTION_DEFAULT_MODEL` | 无 | 默认模型（如 `gpt-5.6-luna`） |

### 3. 推送即部署

```bash
git push origin main
```

工作流会：`npm ci` → 下载官方 opencode Linux 二进制 → 打成 `function.zip` →
`scw function deploy` 上传并部署。函数不存在时自动用上面这些参数创建，已存在则只更新
环境变量并重新部署。完成后 Actions 日志里会打印函数的 HTTPS 地址。

> 也可以本地手动跑同一条链路：`bash scripts/build.sh && bash scripts/scaleway-deploy.sh`
> （需要本机先配好 `scw init`，并导出上面那些环境变量）。

## 手动部署到 Scaleway

1. 打开 [console.scaleway.com](https://console.scaleway.com) → Serverless → Functions → Create；
2. Runtime 选 **Node（≥18）**；
3. 上传 `function.zip`；
4. **入口点**填：入口文件 `handler`，导出函数 `handle`（包里的 `package.json` 已指向它们）；
5. **环境变量**填上面两个：`OPENCODE_API_KEY`、`PROXY_API_KEY`；
6. **超时建议拉高**：opencode 是 agent，可能要跑较久。默认 10s 太短，建议设成
   `60s ~ 300s`；内存建议 ≥512MB；
7. 部署完成后，在函数详情里打开 HTTP Trigger 拿到 `*.functions.fnc.fr-par.scw.cloud` 地址。

> 注意：Serverless 有冷启动。第一次请求 opencode 要下载模型列表/初始化，会比后续慢几秒，
> 属正常现象。调到 Serverless 容器最热后基本是即时响应。

## 怎么无缝使用（把它当原生 OpenAI）

拿到你的函数 HTTPS 地址后，在任意 OpenAI 兼容客户端里设置：

```
base_url      = https://<你的函数>.functions.fnc.<区域>.scw.cloud/v1
api_key       = <你的 PROXY_API_KEY>
model         = 从你的函数 GET /v1/models 返回的任意一个 id（如 gpt-5.6-luna）
```

示例（Python openai 官方库）：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://xxx.functions.fnc.fr-par.scw.cloud/v1",
    api_key="<PROXY_API_KEY>",
)

r = client.chat.completions.create(
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "用一句话介绍 Serverless"}],
)
print(r.choices[0].message.content)
```

也支持 `stream=True`（返回标准 SSE）。想保持同一段 agent 对话，客户端每次把完整
消息历史发过来即可；适配层会按历史自动区分"续聊"和"新对话"。

## 常见问题

- **返回 401**：`Authorization` 里的 Bearer 跟 `PROXY_API_KEY` 不一致，或没配置该变量。
- **返回 502 / "opencode 处理失败"**：opencode 自己报错了。最常见是
  `OPENCODE_API_KEY` 填错或没填。查看函数日志里的 `[opencode] ...` 输出。
- **冷启动慢 / 首包请求超时**：把函数超时拉高（建议 60s+）。
- **模型列表想换**：改 `src/zen-models.js` 里的 `ZEN_MODELS` 再重新打包。

## 说明

这个项目只提供一个 OpenAI 接口的壳和打包部署流程，**不包含、也不需要**任何你自己的
LLM 实现——大模型能力全部来自你提供的 `OPENCODE_API_KEY`（Zen）。