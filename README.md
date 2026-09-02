# opencode-scw —— 跑"原汁原味"的 opencode（Deno 进程内 / Scaleway Function 双形态）

把一个真实的 [OpenCode](https://github.com/anomalyco/opencode) 嵌进服务进程，外面套一个
OpenAI 兼容接口。你把任意 OpenAI 客户端的 `baseURL` 指到服务地址，就能当一个"原生 OpenAI
服务"来用——底下跑的都是真正的 opencode，而不是我们重写的大模型代理。

**两种形态**：

| 形态 | 入口 | 状态 |
| --- | --- | --- |
| **Deno 进程内**（推荐） | `deno task dev`（`deno/main.ts`） | opencode 以预编译 bundle 直接嵌入 Deno 进程，零子进程、单门制、端到端真流式。部署目标 [Deno Deploy](https://deno.com/deploy)：连接 GitHub 仓库 + dev 分支，**推送即部署** |
| **Scaleway Function** | `handler.js`（`exports.handle`） | 旧形态，保留；常驻形态 `node handler.js` 仍支持全透传 |

---

## Deno 进程内形态（方案 A，主力）

### 架构

```
GitHub 仓库（dev 分支）
   │ git push → Deno Deploy GitHub 集成自动构建部署
   ▼
┌─ Deno Deploy 实例（标准 Deno 2.5+，--allow-all）────────────────┐
│  deno/main.ts —— 唯一新入口                                      │
│    ├─ OPTIONS          → 204 + CORS                             │
│    ├─ checkAuth        → Bearer PROXY_API_KEY（单门制，fail closed）│
│    ├─ /v1/health       → 200（含引擎就绪状态）                   │
│    ├─ /v1/models       → 进程内 /config/providers → OpenAI list  │
│    ├─ /v1/chat/*       → OpenAI 翻译层 + 真流式（SSE 逐帧）      │
│    └─ 其余路径          → engine.fetch(req) 原样透传             │
│  deno/engine.ts —— 进程内 opencode 引擎适配器                     │
│    import { app } from vendor/dist/opencode-server.mjs           │
│    （app.fetch 直调，零套接字、无端口、无内部 Basic 门）          │
│  deno/stream.ts —— Web Streams 版 SSE 写器/解析器                │
└───────────────────────────────────────────────────────────────────┘
```

与 Scaleway 形态的本质区别：**opencode 不再是子进程**。上游源码经
`scripts/vendor-opencode.mjs` 流水线（下载锁定版本 tarball → SHA256 校验 →
Bun.build conditions=node → 双运行时冒烟）预编译成 `vendor/dist/opencode-server.mjs`
（提交进仓库），Deno 入口动态 import 后直接 `app.fetch()` 进程内调用——单进程单运行时，
省掉第二份运行时与子进程管理开销；上游源文件逻辑改动为零。

### 环境变量（Deno 形态）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PROXY_API_KEY` | ✅ | 代理访问密钥，所有请求必须带 `Authorization: Bearer <PROXY_API_KEY>`；未配置时 fail closed |
| `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`） | ✅（真对话） | opencode Zen API Key，写进引擎的 `auth.json`；不配也能起服务，但 LLM 调用会失败 |
| `OPENCODE_DEFAULT_MODEL` | ｜ | 默认模型（请求不带 `model` 时用） |
| `OPENCODE_DATA_HOME` | ｜ | 引擎数据目录（默认 `$TMPDIR/opencode-deno-data`） |
| `OPENCODE_AUTO_APPROVE` | ｜ | `false` 关闭 agent 工具权限自动放行 |
| `OPENCODE_STREAM_SMOOTHING` / `OPENCODE_STREAM_CHUNK` / `OPENCODE_STREAM_DELAY_MS` | ｜ | 打字机节奏（默认开，8 字符 / 45ms；`SMOOTHING=false` 直出） |
| `PORT` | ｜ | 监听端口（Deno Deploy 自动注入；本地默认 8787） |

### 本地跑

```bash
bun install                        # src/*.js 纯函数复用需要 node_modules
PROXY_API_KEY=test deno task dev   # 或 deno run --allow-all deno/main.ts

# 另一个终端
OPENCODE_API_KEY=<Zen key> deno task test        # 黑盒 D1–D10（自起服务）
OPENCODE_API_KEY=<Zen key> deno task test:multiturn  # 多轮续聊 + 断连中止（自起服务）

curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer test"
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer test" -H "content-type: application/json" \
  -d '{"model":"opencode/big-pickle","stream":true,"messages":[{"role":"user","content":"数到三"}]}'
```

### 部署到 Deno Deploy（连接 GitHub，推送即部署）

1. 打开 [dash.deno.com](https://dash.deno.com) → **New Playground** 旁选 **Deploy from GitHub**（或现有项目 → Settings → Git Integration）；
2. 授权 GitHub 后选择本仓库、分支 **`dev`**；
3. 入口点填 **`deno/main.ts`**，其他留空即可（Deno Deploy 自动 `deno main.ts` 语义）；
4. 在项目 **Settings → Environment Variables** 添加 `PROXY_API_KEY` 与 `OPENCODE_API_KEY`（必填两个）；
5. 保存后首次部署启动；之后 **每次 `git push` 到 dev 自动重新部署**，无需手动操作。

线上验收：

```bash
curl -s https://<your-project>.deno.dev/v1/health -H "Authorization: Bearer <PROXY_API_KEY>"
# → {"status":"ok","engine":"ready"}
```

### 内存与状态语义（如实声明）

- 单进程单运行时。opencode 引擎自身 RSS（数百 MB 级）是内存大头，进程内方案省掉的是
  第二份运行时 + 子进程管理开销，不是 opencode 本身的占用。
- Deno Deploy 实例空闲休眠（5s~10min）后，内存态 `sessions` Map 与引擎 SQLite 随实例消亡；
  会话锚定靠客户端重发完整历史即可续聊（多轮语义与 Scaleway 形态一致）。
- 多实例完全隔离，无跨实例共享状态；单实例即可满足当前流量。

### 升级 opencode 上游

```bash
OPENCODE_VERSION=v1.19.x bun run vendor   # 重跑流水线：下载→校验→构建→双运行时冒烟
# MANIFEST 与产物有变更则一并提交；补丁预算 ≤5 个解析级微补丁（当前 0）
```

---

## Scaleway Function 形态（旧形态，保留）

把一个真实的 opencode 放进 Scaleway Serverless Function。以下为原 Scaleway 方案的
使用与部署说明。

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
deno/main.ts            # Deno 进程内形态入口（推荐）
deno/engine.ts          # 进程内 opencode 引擎适配器（app.fetch 直调）
deno/stream.ts          # Web Streams 版 SSE 写器/解析器
deno.json               # deno task dev / test / test:multiturn
vendor/src/entry.ts     # bundle 入口（re-export 上游进程内 app）
vendor/dist/opencode-server.mjs  # 预编译 opencode bundle（提交进仓库）
vendor/MANIFEST.json    # 上游版本 / SHA256 / 补丁清单 / 构建记录
scripts/vendor-opencode.mjs  # vendor 流水线（下载→校验→构建→冒烟）
scripts/test-deno.mjs   # Deno 形态黑盒测试 D1–D10（自起服务）
scripts/test-multiturn.mjs   # 多轮续聊 + 断连中止验收（自起服务）
handler.js              # Scaleway 入口（导出 handle）；node dist/handler.js 也能本地跑
src/opencode.js         # 通过 @opencode-ai/sdk 启动并复用共享 opencode server
src/proxy.js            # OpenAI 兼容适配层：/v1/models、/v1/chat/completions
src/zen-models.js       # 静态 Zen 模型清单（作为 server 不可用时的兜底）
scripts/build.sh           # 一键打包 dist/function.zip（含官方 opencode 二进制 + SDK 依赖）
scripts/scaleway-deploy.sh # 把 dist/function.zip 部署到 Scaleway（供 CICD 调用）
scripts/run-local.mjs      # 本地联调启动器（会先打包）
scripts/smoke-test.mjs  # Node 常驻形态冒烟 5 项
scripts/test-bridge.mjs # Node 常驻形态黑盒 T1–T18
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

## opencode 原生接口全透传（web UI + 78 路由）

常驻形态（`node handler.js`，Freebuff 托管 / 容器 / VPS）下，除 `/v1/*` 外的**全部
路径**（opencode 原生 HTTP 路由、官方 web UI、SSE 事件流、WebSocket 终端）都原样透传
给共享 opencode server，外部客户端可以把它当 opencode server 直接连：

```
你的 OpenAI 客户端  →  /v1/*           OpenAI 翻译层（Bearer PROXY_API_KEY）
opencode server/CLI →  其它一切路径    原样透传（Bearer PROXY_API_KEY 或 Basic）
浏览器              →  /  /app         opencode 官方 web UI（浏览器 Basic 登录框）
```

- **鉴权双通道**：`Bearer <PROXY_API_KEY>` 或 `Basic opencode:<密码>`（密码 =
  `OPENCODE_SERVER_PASSWORD`，缺省回退 `PROXY_API_KEY`，一把钥匙开两道门）。
- **凭据分离**：上行转发统一替换为内部 Basic，客户端凭据不达上游。
- **长连接**：`/event` SSE 直通、`/pty/**/connect` WebSocket 字节级中继。
- **事件模式限制**：Scaleway Function 事件入口（`exports.handle`）一次调用返回一个
  响应，无法承载长连接路由——非 `/v1` 路径返回 `501` 明确提示，只有常驻形态有全能力。

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