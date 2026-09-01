# freebuff serve 模式 fork —— 调研与设计文档

**日期**: 2026-09-01
**状态**: 调研完成，方案待实现（本仓库只落文档，未改代码）
**2026-09-01 评审修订**: 对照上游 commit `b088c5c` 逐条核对源码后修订。关键修正：token 文件是 `~/.config/manicode/credentials.json`（非 `auth.json`）；免费模型常量在 `common/src/constants/freebuff-models.ts`（非 `agents/constants.ts`）；免费档没有独立的 FREE 模式（`LITE` → costMode `'free'` + agent `'base2-free'`）；SDK `run()` 没有 `model` 参数（需映射层，且 `gpt-5.6-luna` 是付费模型需兜底）；`reasoning_effort` 可映射到 `freebuff_reasoning_effort`（不忽略）；`test-bridge.mjs` 是 21 项（非 19，含就绪/T8b/T17a）；删除自造的 `FREEBUFF_CONFIG_DIR`；`ask_user` 在 serve 无 TUI 需自动应答；真流式用 `handleStreamChunk`。
**关联**: 目标 = fork [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff) 源码，给 freebuff CLI 增加 `serve` 模式（opencode 兼容 HTTP 契约），使本仓库（opencode-scw）的代理/桥接层（`src/proxy.js` + `src/bridge.js`）**零改动**转向由真实 freebuff agent 引擎驱动。

---

## 1. 背景：为什么要 fork

本仓库现状：`node handler.js` 常驻，外部客户端走两条路——

- `/v1/*`（OpenAI 翻译层，`src/proxy.js`）→ 共享 opencode server；
- 其余路径（78 路由 + SSE + WebSocket，`src/bridge.js`）→ 字节级透传 opencode server。

代理层只做翻译/透传，agent 能力 100% 来自真实 opencode（`opencode serve` 子进程 + `@opencode-ai/sdk` SDK 拉起）。

用户想要同样形态但引擎换成 **freebuff**（免费档模型、真实 freebuff agent）。前序调研（见对话记录）已确认四个障碍，其中三个可通过"fork 魔改"解决：

| 障碍 | 性质 | 本方案的解法 |
|---|---|---|
| freebuff CLI 无服务模式，纯 TUI | 致命 | fork 源码，加 `freebuff serve` 命令 |
| 免费档绑账号/会话、广告 | 政策风险 | serve 复用已登录 token；无头模式不渲染广告（风险自担，见 §8） |
| 原生二进制不适合生产静态托管 | 部署约束 | 与现状一致：dev-server/容器/VPS 常驻形态，不依赖静态托管 |
| `@codebuff/sdk` 是云端客户端？ | 误解 | **否** —— 已核实 SDK 在进程内运行 `client.run()`，CLI 本身就是内嵌 SDK + 自绘 TUI |

最后一个发现是整个方案成立的关键：**freebuff CLI 的 agent 循环跑在 CLI 自己进程里**（`cli/src/utils/codebuff-client.ts` 直接 `new CodebuffClient({ apiKey: 登录token, cwd, overrideTools, ... })`，`sdk/src/client.ts` 的 `run()` 是本地执行，模型走 Codebuff 网关）。所以 fork 加 serve 模式时，**同一个进程**里既有 HTTP server 又驱动 agent，不需要再造运行时、不需要额外进程（与 opencode 的"server 子进程"形态相比反而更简单）。

## 2. 已核实的上游事实（2026-09-01，main 分支）

- 仓库：TypeScript monorepo，Bun（`engines` 锁 1.3.14），Apache-2.0；workspaces：`cli`、`common`、`agents`、`sdk`、`freebuff`、`evals`、`packages/*`、`scripts/tmux`。
- `freebuff` CLI 二进制 = `cli/` 全部代码以 `FREEBUFF_MODE=true` 经 `bun build --compile` 打成单文件（`freebuff/cli/build.ts` → `cli/scripts/build-binary.ts`）。构建链路还含：`bun run scripts/prebuild-agents.ts`、`sdk build`、**联网安装 OpenTUI native bundle**（`bun install --cwd staging`）、拷贝 `tree-sitter.wasm` 兄弟文件；产物在 `cli/bin/freebuff`（+ 同目录 `tree-sitter.wasm`）。
- npm 包 `freebuff` 只是启动器：`bin=index.js` + `postinstall`，二进制落 `~/.config/manicode/freebuff`（已从 npm 元数据核实）；"首次运行从官方 `/api/releases/download/` 下载"一句来自包内 `index.js`，实施时以 tarball 源码为准（未逐字核实）。
- CLI 参数表（`cli/src/cli-args.ts`，freebuff 分支）：`-v/--version`、`--continue [id]`、`--cwd`、`login`、`-h/--help`。**无 serve，无端口，无非交互输出**。
- 入口 `cli/src/entry.ts`（267 字节）：先判断 `--terminal-command-broker`（Windows 内部模式）再 `import('./index')`（TUI）。**serve 模式在此处加第三个分支，绕开 TUI**——且天然先于 `parseArgs()`（commander），避免 `cli-args.ts` 的 `choices(['login'])` 拒绝未知 command/option。
- TUI 依赖（`cli/src/index.tsx`）：OpenTUI renderer、alternate-screen、终端 watchdog、OSC 主题检测、`startEngagementTracking()`（仅 `IS_FREEBUFF` 且 TUI 渲染后启动）—— serve 分支一概不触发（无广告渲染、无 engagement 心跳，但限额/门控仍按账号结算，见 §7）。
- SDK（`sdk/src/client.ts` → `sdk/src/run.ts`）：`run()` 在**进程内**执行 agent 循环（工具直接调本地 fs/terminal），LLM 走 Codebuff 网关；`RunOptions` 含 `signal` / `handleStreamChunk`（text / `reasoning_chunk` 真增量）/ `handleEvent`（`PrintModeEvent`）/ `extraCodebuffMetadata` / `costMode` / `previousRun`，**没有 `model` 参数**；`checkConnection()` 打 `${websiteUrl}/api/healthz`。CLI 已有 `cli/src/sdk-event-handlers.ts` 做 SDK 事件→UI 翻译，serve 的 events.ts 应参考。
- 鉴权/凭据：`getAuthToken()`（`cli/src/utils/auth.ts`）读 CLI 登录 token——文件是 `~/.config/manicode/credentials.json`（`getCredentialsPath()`，**不是 `auth.json`**）；目录由 `config-dir.ts` 决定：`NEXT_PUBLIC_CB_ENVIRONMENT=prod` 时是 `~/.config/manicode`，dev 栈带 `-<env>` 后缀（`manicode-<env>`）。SDK 构造器接受 `apiKey` 或环境变量（`common/src/constants/paths.ts` 的 `API_KEY_ENV_VAR = 'CODEBUFF_API_KEY'`）。
- 模型目录（评审修正）：**`agents/constants.ts` 里没有 `FREE_MODE_AGENT_MODELS`**（初稿写错）。免费模型常量在 `common/src/constants/freebuff-models.ts`（`DEFAULT_FREEBUFF_MODEL_ID`、`resolveAvailableFreebuffModel`、`resolveSupportedFreebuffModel`、`getFreebuffModelEfforts` 等），免费 agent 定义在 `agents/base2-free-*.ts` / `agents/base3-free-*.ts`（GLM 5.3 Flash / Luna / DeepSeek Flash / MiMo / Solar Pro 4 / MiniMax M3 等，随版本变动）。
- 模式（评审修正）：`AGENT_MODES = ['DEFAULT','LITE','MAX','PLAN']`，**免费档没有独立的 FREE 模式**。freebuff 的 `LITE` 映射为 costMode `'free'` + agent `'base2-free'`（`cli/src/utils/constants.ts` 的 `AGENT_MODE_TO_COST_MODE` / `AGENT_MODE_TO_ID`；服务端据此做 session gate/限流/地区与设备限制）。
- 思考强度（评审修正）：freebuff **原生支持** reasoning effort——`cli/src/state/freebuff-model-store.ts` 按模型维护 effort ladder（`getFreebuffModelEfforts` / `getFreebuffReasoningEffortForModel`），随请求以 `freebuff_reasoning_effort` 元数据上送。serve 应把 OpenAI `reasoning_effort` 映射过来，而非忽略。

## 3. 目标架构

```
外部 OpenAI 客户端 / 浏览器 / 任何客户端
   │  Bearer <PROXY_API_KEY> 或 Basic
   ▼
┌─ 本仓库（opencode-scw，改动最小）────────────────────────┐
│  handler.js（常驻 HTTP 服务器）                            │
│    ├─ /v1/*        → src/proxy.js（OpenAI 翻译层，不改）    │
│    └─ 其它路径      → src/bridge.js（透传层，不改）          │
│    └─ src/freebuff.js（新增，对标 src/opencode.js）         │
│          spawn 常驻子进程 + serverFetch(Basic 上行)         │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP 127.0.0.1:<port>（opencode 兼容契约）
                           ▼
┌─ fork 二进制（freebuff serve）───────────────────────────┐
│  cli/src/serve/*（新增，全部新文件）                       │
│    Bun.serve HTTP 路由（session/message/event/providers）  │
│    SessionStore（ID、消息、parts、RunState、并发队列）      │
│    engine.ts：进程内 run()（base2-free + costMode=free）  │
│              + model 映射层 + ask_user 自动应答           │
│    事件总线 → /event SSE（handleStreamChunk 真流式）       │
│    权限/ask_user → 自动放行（FREEBUFF_AUTO_APPROVE）       │
│    登录 token 复用（~/.config/manicode/credentials.json）  │
└───────────────────────────────────────────────────────────┘
```

**关键设计决策：契约以本仓库的消费方式反向定义。** `src/proxy.js` 和 `src/bridge.js` 零改动的前提是 fork 的 serve 端实现 opencode HTTP 契约的"被消费子集"，字段形状与 opencode 一致（见 §4）。这样桥接层不需要感知引擎差异，`AGENT_RUNTIME=opencode|freebuff` 一个环境变量切换，双引擎可并行回归。

## 4. serve 模式 HTTP 契约（必实现子集）

以下形状以本仓库当前消费代码为准（`src/proxy.js` 的 `streamChat`/`handleModels`、`src/bridge.js` 的透传），实现时逐字段对齐：

### 4.1 鉴权

- 所有请求需 `Authorization: Basic <base64("opencode:" + FREEBUFF_SERVER_PASSWORD)>`；`FREEBUFF_SERVER_PASSWORD` 缺省回退 `PROXY_API_KEY`（沿用本仓库"一把钥匙开两道门"惯例，由桥接层注入）。
- 无凭据 → 401 + `WWW-Authenticate: Basic realm="opencode"`；`OPTIONS` → 204 + CORS（`access-control-allow-origin: *` 等，见 `src/bridge.js` 的 CORS 常量）。
- 凭据分离：客户端凭据不达 serve；serve 只认内部 Basic。

### 4.2 端点

| 方法/路径 | 本仓库消费处 | 要求 |
|---|---|---|
| `GET /config/providers` | `handleModels`（`src/proxy.js`）+ bridge 透传 | 原始形状对齐 opencode：`{ providers: [{ id, name, models: { <modelId>: {...} } }], default: { <providerId>: <modelId> } }`（**`p.models` 是对象 map，不是数组** —— 见 `src/opencode.js` 的 `fetchProviders` 用 `Object.values(p.models)`）；`src/freebuff.js` 的 `fetchProviders` 归一化为 `{ models: [{ id: "<providerId>/<modelId>", owned_by }], defaultModel }`，与 opencode 引擎完全一致 |
| `GET /agent` | bridge 透传测试（T3/T6） | **必须返回非空数组**（T3 断言 `length > 0`，T6 断言 `text.length > 20`）：返回免费 agent 清单（≥1 项，含 `id` 等字段） |
| `GET /experimental/tool/ids` | bridge T7 | 返回 `{ data: [工具id, ...] }`（数组亦可，T7 兼容两种） |
| `GET /session/:id/todo` | bridge T11 | 返回 200 + 空列表（`[]`） |
| `GET /` | bridge T16 | 返回极简 `text/html` 状态页（200，`content-type: text/html`）—— 不做完整 web UI，但让 T16 直接通过 |
| `POST /session` | `streamChat` | body `{ title }` → `{ id }` |
| `GET /session`、`GET /session/:id`、`PATCH /session/:id`、`DELETE /session/:id` | 透传/可选 | 内存态即可 |
| `POST /session/:id/message` | `streamChat` | body: `{ parts:[{type:"text"|"file",...}], model:{providerID,modelID}, system?, variant? }` → 200 `{ id, parts:[{id,type:"text"|"reasoning",text}], info:{ tokens:{input,output,reasoning,total} } }`。单会话**串行队列**执行（一次一个 run），同会话并发请求排队；`GET /session/:id/message/:messageId` 返回同一形状。`model`/`variant` 在 serve 内先过映射层（§4.4），未知/付费模型（含 `gpt-5.6-luna`）落默认免费模型 |
| `GET /event` | `streamChat` | SSE 长连接（`text/event-stream`），事件见 4.3 |
| `POST /session/:id/permissions/:permissionID` | `streamChat` 自动放行 | body `{ response:"allow"|"deny", remember? }` → 2xx |
| `/pty` 及 WebSocket | bridge T17/T18 | P2。freebuff 引擎下 T17 参数化为"透传上游 404/501"；T18（无鉴权 401）由代理层兜底，不受影响 |
| 其它路径 | `bridge` 透传 | 404（透传层原样转发上游 404，可接受） |

### 4.3 /event SSE 事件（与 opencode 同构）

每个事件 `data: {type, properties}`：

- `message.part.updated`：`properties: { sessionID, part: { id, type:"text"|"reasoning", text } }`（**累积全文**；`src/proxy.js` 用 `part.text.length > acc.length` 判增量）。
- `message.part.delta`：`properties: { sessionID, partID, messageID, field:"text", delta }`。**评审修正：由 SDK `handleStreamChunk` 直接产出（含 `reasoning_chunk` → `field:"reasoning"`），不再是可选项**；`src/proxy.js` 的增量路径（`pushDelta`）依赖它获得真流式。
- `permission.asked`：`properties: { sessionID, id }`（工具权限；serve 端默认自动放行：配置 `FREEBUFF_AUTO_APPROVE !== "false"` 时后台直接答复 allow 并仍广播事件供观察）。
- `message.updated`：`properties: { sessionID, messageID }`（可选）。

**事件来源（评审修正）**：SDK `client.run({ handleEvent, handleStreamChunk })`。`handleStreamChunk` → `message.part.delta`（text / `reasoning_chunk` 真增量）；`handleEvent`（`@codebuff/common/types/print-mode` 的 `PrintModeEvent`）→ 归一化为 `message.part.updated` 累积全文（part 拆分规则：reasoning 类 → `type:"reasoning"`，其余 → `"text"`）。翻译逻辑参考 CLI 现成的 `cli/src/sdk-event-handlers.ts`。消息完成时 flush 最终 parts 并广播 `message.updated`（serve 端 /event 是单进程内广播，不存在订阅晚于生成的问题；`run()` resolve 后补发 updated 即可）。

### 4.4 会话语义

- SDK `run()` 的 `previousRun`（RunState）≈ opencode 的 session：每个 `/session/:id` 持有一个 RunState；`POST message` 把上一次的 RunState 作为 `previousRun` 传入，完成后续写。内存态足够（常驻形态），不持久化（P2 可选落盘 `~/.local/share/freebuff/serve/<id>.json`）。
- `model` 映射（评审修正）：**SDK `run()` 没有 `model` 参数**——serve 需自建映射层：把 `providerID/modelID` 解析为 freebuff 模型 id（`resolveSupportedFreebuffModel`），经 `extraCodebuffMetadata`（freebuff 模型键名以 `sdk/src/run.ts` 当日源码为准）上送；未知/付费模型（含 `src/proxy.js` 默认的 `gpt-5.6-luna`，它是付费 `LITE_MODEL`）一律落 `DEFAULT_FREEBUFF_MODEL_ID`。
- `variant`（reasoning_effort）（评审修正）：**不忽略**——映射到 freebuff 原生 effort（`freebuff_reasoning_effort`，per-model ladder 见 §2），无法映射时省略；请求字段必须接受、不回 400。
- `system`：SDK 支持 `knowledgeFiles`/`agentDefinitions`，serve 端固定用默认免费 agent（免费档 LITE 对应 agent，当前 `base2-free`，随版本变化），`system` 字段映射到 `knowledgeFiles`（P1 可忽略，接受字段即可）。
- 交互工具（评审新增）：serve 无 TUI，`AskUserBridge` 不可用——engine 必须 override `ask_user` 自动应答（`FREEBUFF_AUTO_APPROVE !== "false"` 时按预置答案/跳过处理）；`terminalCommandBroker` 不注入（`run.ts` 注明 headless 可省略）→ 工具命令默认直接执行，该安全权衡写进 README。

## 5. fork 侧改动清单（最小侵入）

**原则：所有新代码放新文件，只改一个既有文件（入口），把上游合并冲突面压到 1 个文件。**

| 文件 | 动作 | 说明 |
|---|---|---|
| `cli/src/entry.ts` | 改（唯一既有文件） | 在 `isTerminalCommandBrokerInvocation` 之外加 `isServeInvocation`（`argv` 含 `--serve` 或 env `FREEBUFF_SERVE=1`），先于 TUI import（也先于 commander `parseArgs`）走 `./serve/server`。**`--serve` 与 `serve` 子命令二选一，与桥接侧 spawn 保持一致** |
| `cli/src/serve/server.ts` | 新增 | Bun.serve + 路由分发 + Basic 鉴权 + CORS + OPTIONS；`--port 0` 时 stdout 打**独占 ready 行** `FREEBUFF_SERVE_READY {"port":N}`（serve 分支关闭 logger 的 stdout 输出，避免解析竞态） |
| `cli/src/serve/sessions.ts` | 新增 | SessionStore：id 生成、消息/parts 记录、单会话串行队列、abort 信号 |
| `cli/src/serve/engine.ts` | 新增 | 包 `CodebuffClient`（复用构造参数；**`ask_user` 自动应答而非直通 `AskUserBridge`**，不注入 `terminalCommandBroker`）：`runOne(session, prompt)` → `{ parts, tokens }`；run 参数 `agent`=免费档 LITE agent（当前 `base2-free`）、`costMode: 'free'`、model 映射层（§4.4）、`handleEvent`+`handleStreamChunk` → 事件总线 |
| `cli/src/serve/events.ts` | 新增 | EventBus：session 维度订阅/发布，`/event` SSE 广播（每连接一个 AbortController）；`handleStreamChunk` → `message.part.delta` 真流式（参考 `cli/src/sdk-event-handlers.ts`） |
| `cli/src/serve/providers.ts` | 新增 | 免费模型静态清单：读 `common/src/constants/freebuff-models.ts`（`DEFAULT_FREEBUFF_MODEL_ID` / `resolveAvailableFreebuffModel` 等），启动时缓存；找不到则静态兜底（**不是 `agents/constants.ts`**） |
| `cli/src/serve/permissions.ts` | 新增 | `ask_user` 自动应答 + 权限请求注册表 + 自动放行（`FREEBUFF_AUTO_APPROVE`，默认 true，对标本仓库 `OPENCODE_AUTO_APPROVE`）；`POST /session/:id/permissions/:id` 仍接受外部显式答复（兼容透传层） |
| `freebuff/cli/build.ts` | 不改 | serve 代码随 `FREEBUFF_MODE=true` 编译进同一二进制；`freebuff serve` 靠 argv 识别 |
| `cli/src/index.tsx` | 不改 | serve 分支永不 import 它 |

**TUI 依赖规避**：serve 入口不 import `index.tsx`；登录用 `runPlainLogin` 单独命令交互完成（`freebuff login`），serve 只读现成 token（`~/.config/manicode/credentials.json`）。启动时若未登录：`/config/providers` 正常返回（模型目录静态），`POST /session/:id/message` 返回 502 + `{error:{message}}`（模型网关鉴权失败），日志提示先 `freebuff login`。

## 6. 桥接仓库（本仓库）改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/freebuff.js` | 新增 | 对标 `src/opencode.js`：`ensureRuntime()`（二进制路径 env `FREEBUFF_BIN`，spawn `freebuff --serve --hostname 127.0.0.1 --port 0`，从 stdout 的 `FREEBUFF_SERVE_READY` 行解析分配端口，或 env 固定端口 + 轮询就绪）、`serverFetch`（注入内部 Basic）、`fetchProviders`、`serverPassword`、`mapVariant`（映射到 freebuff effort）。若 `FREEBUFF_BIN` 未配置或 spawn 失败 → 抛"未配置 freebuff 运行时"，`/v1` 返回 502（语义与现有一致） |
| `src/opencode.js` | 改名 → `src/opencode-core.js`，新建同名 selector | **引擎选择零侵入**：新建 `src/opencode.js` = `module.exports = require(process.env.AGENT_RUNTIME === "freebuff" ? "./freebuff" : "./opencode-core")`。`handler.js`、`src/bridge.js`、`src/proxy.js` 的 `require("./opencode")` 全部不用动（两引擎导出同签名：`ensureRuntime/serverFetch/fetchProviders/serverPassword/getServerUrl/basicAuthHeader/mapVariant/runPrompt`） |
| `scripts/fetch-freebuff.mjs` | 新增 | 对标 `scripts/build.sh` 的下载逻辑：从 `FREEBUFF_BIN_URL`（fork 的 GitHub Release 地址）下载 linux x64/arm64 二进制 → 校验 `FREEBUFF_BIN_SHA256` → `chmod +x` → 落 `dist/freebuff` |
| `env.example` / `README.md` | 改 | 新增 `AGENT_RUNTIME`、`FREEBUFF_BIN`、`FREEBUFF_VERSION`、`FREEBUFF_BIN_URL`、`FREEBUFF_BIN_SHA256`、`FREEBUFF_SERVER_PASSWORD`、`FREEBUFF_AUTO_APPROVE` 文档 |

运行形态与现状相同：常驻 HTTP 服务器（Freebuff 托管 dev-server / 容器 / VPS）；静态生产托管不支持长驻进程，不承诺。

**HOME 透传（与 opencode 引擎相反）**：`src/opencode.js` 故意把 `HOME`/`XDG_*` 重定向到临时目录（为了写 Zen key）；`src/freebuff.js` **不得**重定向 `HOME`/`XDG_CONFIG_HOME` —— serve 进程要读 `~/.config/manicode/credentials.json` 下的 CLI 登录 token。部署时若登录环境与运行环境 HOME 不同，用 `HOME` 显式指定（`os.homedir()` 尊重 `HOME`；**评审删除**：初稿的 `FREEBUFF_CONFIG_DIR` 是自造变量，上游 `config-dir.ts` 不读它——除非 fork 额外改 `config-dir.ts`，那会破坏"只改一个文件"约束）。

## 7. 登录与免费档凭证（重要）

- 免费档没有 API Key 通道。做法：部署容器里**交互登录一次**（`freebuff login`，设备码流转），token 持久化在 `~/.config/manicode/credentials.json`（`auth.ts` 的 `getCredentialsPath`；**不是 `auth.json`**），serve 进程复用。prod 构建必须设 `NEXT_PUBLIC_CB_ENVIRONMENT=prod`，否则目录变成 `~/.config/manicode-<env>`。
- 自动化替代：`CODEBUFF_API_KEY`（付费 Codebuff API key）走 SDK 既有逻辑；免费档不适用。
- 风控现实（写进 README，如实告知）：免费档按账号计会话限额；广告是免费模型的对价。已核实源码：`startEngagementTracking()` 只在 TUI 主流程（`cli/src/index.tsx` 的 `main()`）启动，serve 分支不 import 它 → **无头 serve 不渲染广告、也不发 engagement 心跳**，但限额仍按账号结算。**评审补充**：免费档的 session gate / 限流 / 地区限制 / 设备绑定是**服务端强制**（`AGENT_MODE_TO_COST_MODE` 注释），代码层无法绕过——属于"**不保证可用**"（可能直接 401/403/限流），不只是风控概率问题。**将免费 CLI 用作公共服务接口是否违约/触发风控，属用户自担风险**；规模使用请评估 `@codebuff/sdk` 付费档（那是合法的程序化通道，但模型与免费档不同）。

## 8. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 免费档风控：会话限额/地区限制/设备绑定 | 高（政策面） | 如实文档化；单账号自用；不做多账号轮换（红线） |
| 上游变动：`cli/src/entry.ts`、SDK `run()` 签名（RunOptions/事件形状）、`common/src/constants/freebuff-models.ts`、免费 agent 定义（base2-free/base3-free）、`sdk-event-handlers.ts` | 中 | §9 同步工作流 + 双引擎回归 |
| fork 二进制体积/内存（Bun 单文件，数百 MB 级） | 中 | 与 opencode 二进制同量级，已有先例（function.zip ~58MB 时代已过，opencode 现在更大）；部署内存 ≥1GB |
| serve 并发：多 session 并行 run 导致网关限流 | 低 | 默认每 session 串行；全局并发数可配（FREEBUFF_MAX_CONCURRENT_RUNS） |
| 上游免费网关接口非公开，可能无预告变化 | 中 | 锁版本（FREEBUFF_VERSION + sha256），升级窗口人工验证 |
| 免费网关出网依赖 + 服务端门控：serve 进程需访问 codebuff 后端（登录校验/模型网关/session gate/地区设备校验） | 中 | 部署环境出网白名单；启动时用 SDK `checkConnection()`（`/api/healthz`）做健康检查；未登录/被门控时 `POST message` 返回明确 502 提示 |
| fork 构建链路重：`prebuild-agents.ts` + `sdk build` + OpenTUI native bundle（联网 `bun install`）+ `tree-sitter.wasm` 兄弟文件；依赖 `NEXT_PUBLIC_*` env（`build-binary.ts` 的 `nextPublicEnvVars`） | 中 | CI 用 bun 1.3.14 + 网络；构建时设 `NEXT_PUBLIC_CB_ENVIRONMENT=prod`（否则 config 目录变 `manicode-<env>`，登录 token 找不到）；产物 `cli/bin/freebuff` + `tree-sitter.wasm` 一起上传 |

## 9. 上游同步工作流（fork 维护）

### 9.1 仓库拓扑

```
CodebuffAI/freebuff（upstream，只读）
   └─ fork: <you>/freebuff（主开发仓）
         ├─ main 分支 = 主动同步 upstream/main + 少量文件（entry.ts 等）
         ├─ serve/* 全部放新文件，永不与上游冲突
         └─ 每次发布打 tag：freebuff-serve-v<freebuff版本>-<serve批次>
```

### 9.2 同步节奏与命令

- 触发：上游打 `freebuff-v*` tag / 上游 main 大版本更新 / 例行每月一次。
- 流程（merge 策略，保留上游历史，冲突面最小）：

```bash
git remote add upstream https://github.com/CodebuffAI/freebuff.git   # 一次
git fetch upstream main
git merge upstream/main          # 冲突只可能出现在 entry.ts/package.json/构建脚本
# 冲突处置：
#  - entry.ts：三分支（TUI / terminal-broker / serve）手工合并，serve 分支永远追加
#  - package.json：三向合并后再 bun install
#  - 新文件永不冲突
bun install
bun run typecheck                # fork 内
bun test                         # fork 单测
```

- 升级后验证矩阵（双绿才发布）：
  1. fork：`freepuff --version`、`freebuff serve` 启动、curl 契约冒烟（§4 端点逐个）；
  2. 桥接仓库：`AGENT_RUNTIME=freebuff` 跑 `scripts/smoke-test.mjs`（5/5）+ `scripts/test-bridge.mjs`（21/21，含 T8b/T17a）+ 真流式人工验收；
  3. 回归：`AGENT_RUNTIME=opencode` 同套测试保持全绿（双引擎并行保障）。

### 9.3 二进制发布

- fork 仓库 GitHub Actions（workflow 名称建议 `release-serve.yml`）：
  1. 触发：手动（workflow_dispatch）或上游同步 merge 后自动；
  2. `FREEBUFF_MODE=true bun freebuff/cli/build.ts <ver>` 各平台一次（linux-x64 / linux-arm64 起步，macOS/Windows 可选）；构建环境：bun 1.3.14 + 网络（OpenTUI native bundle 需联网安装）；**必须设 `NEXT_PUBLIC_CB_ENVIRONMENT=prod`**；
  3. 上传 GitHub Release：`freebuff-serve-linux-x64-v<ver>`，附 sha256；
  4. 把产物 URL + sha256 写进桥接仓库 env（`FREEBUFF_BIN_URL` / `FREEBUFF_BIN_SHA256` / `FREEBUFF_VERSION`），可重复构建。

### 9.4 回滚

- 一个环境变量回滚到 opencode 引擎（`AGENT_RUNTIME=opencode`），二进制版本回退 = 换 `FREEBUFF_BIN_URL` 指向旧 Release。发布与回滚都不改代码。

## 10. 明确不做（YAGNI）

- 不移植 opencode 全部 78 路由：只实现 §4 被消费子集，其余 404（透传层可接受）。
- 不做 `/pty` WebSocket 终端、不做官方 web UI 端口（P2 可选：简化静态页 `/app` 返回 JSON 状态页即可通过 bridge UI 测试）。
- 不改上游鉴权、模型定价、广告/限额逻辑（free 模式编译期剪枝保持原样）。
- 不做多账号池/额度轮换（风控红线）。
- 不持久化会话历史（P2 可选落盘）。

## 11. 验收标准（照抄现有标准，双重引擎）

1. fork 仓库：`bun test` 全绿；`freebuff serve` 黑盒 curl 冒烟全绿（models/session/message/event/permissions/401/OPTIONS）。
2. 桥接仓库 `AGENT_RUNTIME=freebuff`：`node scripts/smoke-test.mjs` 输出 `5/5 checks passed`；`node scripts/test-bridge.mjs` 输出 `21 passed, 0 failed`（21 项 = 服务器就绪 + T1–T18 + T8b + T17a；若 serve 未实现 /pty、UI，对应用例降级为"透传上游 404/501"断言，**T17a 与 T17 都要按引擎参数化**）。
3. 真流式：OpenAI 客户端 `stream=True` 看到逐字 SSE 与最终 usage；多轮续聊上下文延续。
4. `AGENT_RUNTIME=opencode` 全量回归保持全绿。