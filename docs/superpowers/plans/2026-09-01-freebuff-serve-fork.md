# freebuff serve 模式 fork —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fork [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)，给 freebuff CLI 增加 `serve` 模式（opencode 兼容 HTTP 契约：session/message/event/providers），使本仓库（opencode-scw）的 `src/proxy.js` + `src/bridge.js` 零改动切换引擎为真实 freebuff；并落地上游同步工作流。

**Architecture:** fork 侧全部新代码放 `cli/src/serve/`，只改 `cli/src/entry.ts` 一个既有文件（serve 分支绕开 TUI，进程内复用 `CodebuffClient`）；本仓库侧新增 `src/freebuff.js`（对标 `src/opencode.js`）与 `scripts/fetch-freebuff.mjs`，`AGENT_RUNTIME` 环境变量切换引擎。契约细节以 `docs/superpowers/specs/2026-09-01-freebuff-serve-fork-design.md` 为准。

**Tech Stack:** fork = TypeScript/Bun monorepo，编译为单文件二进制（`FREEBUFF_MODE=true bun freebuff/cli/build.ts`）；本仓库 = Node.js ≥18 CJS，零新依赖。本仓库现有 `src/opencode.js`、`src/proxy.js`、`src/bridge.js`、`handler.js`。

**Executing agent prerequisites (read first):**
- 复制 fork 得到可推送仓库（GitHub UI：fork 按钮；或本地裸仓库 + 新 remote）。
- fork 内执行一次 `bun install`；构建链路验证见 Task 1。
- 实现期间上游 main 会前进：所有路径引用以当日 checkout 为准；若 `entry.ts` 结构变化，按"三分支追加"合并原则调整（见 Task 6）。

## Global Constraints

- fork 侧只改 `cli/src/entry.ts` 一个既有文件；其余全部新增文件（冲突面最小化，供 Task 6 同步工作流）
- serve 分支严禁 import `cli/src/index.tsx`（TUI 依赖：OpenTUI renderer / alternate-screen / terminal watchdog 一律不进入 serve 进程）
- 不带修改上游鉴权/模型/广告/限额逻辑；`FREEBUFF_MODE=true` 剪枝保持原样
- HTTP 契约字段形状与 opencode 一致（以设计文档 §4 为准），`src/proxy.js`/`src/bridge.js` 必须零改动
- 凭据分离：serve 只认内部 Basic（`FREEBUFF_SERVER_PASSWORD`，缺省回退 `PROXY_API_KEY`）；不落日志
- 单会话串行执行（同时只跑一个 run），多会话并行；全局并发上限 env `FREEBUFF_MAX_CONCURRENT_RUNS`（默认 1）
- 桥接侧验收标准 = 现有 `scripts/smoke-test.mjs` 5/5 + `scripts/test-bridge.mjs` 21/21（21 项 = 服务器就绪 + T1–T18 + T8b + T17a；/pty 的 T17a/T17、大响应 T8 按引擎参数化；web UI 由 serve 极简页覆盖）；opencode 引擎回归保持全绿

---

### Task 1: fork 仓库 + 构建/运行链路打通

**Files:**
- Create: `freebuff/` fork 仓库（GitHub 或本地）
- Test: fork 构建产物黑盒启动

**Interfaces:**
- Produces: `freebuff` 可执行二进制（linux-x64/linux-arm64），能跑 `--version`、`login` 之外的启动路径

- [ ] **Step 1: 准备 fork**
  - GitHub 上 fork `CodebuffAI/freebuff` 到你的账号（或本地 clone），`git remote add upstream https://github.com/CodebuffAI/freebuff.git`。
  - 记录 fork SHA：`git rev-parse HEAD`，写进 README 的版本说明。

- [ ] **Step 2: 构建 freebuff 二进制**

```bash
bun install
# 构建可能需要 NEXT_PUBLIC_* env（见 cli/scripts/build-binary.ts 的 nextPublicEnvVars），正式发布设 prod：
NEXT_PUBLIC_CB_ENVIRONMENT=prod FREEBUFF_MODE=true bun freebuff/cli/build.ts 0.0.0-dev
# 产物：<repo>/freebuff（linux 平台单文件），拷贝到 dist/ 或 /tmp/freebuff-dev
```

- [ ] **Step 3: 失败断言（serve 尚不存在）**

```bash
./freebuff --serve --help 2>&1 | head -5
```
期望：无 `serve` 相关输出（当前上游只有 version/continue/cwd/login/help）。

- [ ] **Step 4: 验证基线可启动**

```bash
./freebuff --version   # 打印版本号
```
期望：打印版本；若 `--version` 进 TUI 报错，改用 `freebuff --help`（freebuff 分支 commander 先解析，无需 TTY）。

- [ ] **Step 5: 记录基线**（提交信息：`chore: fork freebuff @ <sha>`；不动任何源码）

---

### Task 2: serve 骨架 —— entry 分支 + 鉴权 + 静态端点

**Files:**
- Modify: `cli/src/entry.ts`（唯一既有文件）
- Create: `cli/src/serve/server.ts`、`cli/src/serve/auth.ts`、`cli/src/serve/providers.ts`

**Interfaces:**
- Produces:
  - `isServeInvocation(argv, env) → boolean`（argv 含 `--serve`，或 env `FREEBUFF_SERVE=1`）
  - `startServeServer(options: { port: number; hostname: string }) → Promise<{ port: number; close(): Promise<void> }>`（Bun.serve）
  - `checkAuth(headers) → { allowed, message }`（内部 Basic，密码 = `FREEBUFF_SERVER_PASSWORD || process.env.PROXY_API_KEY`）
  - `GET /config/providers`、`GET /agent`、`OPTIONS`、未登录时 message 502

- [ ] **Step 1: 写失败断言**（serve 模块不存在）

```bash
node -e "import('./cli/src/serve/server.ts').then(() => console.log('should not reach')).catch(e => console.log('MISSING OK'))"
```
期望：`MISSING OK`（模块不存在）。

- [ ] **Step 2: 实现 auth.ts**

```ts
export function serverPassword(): string {
  return process.env.FREEBUFF_SERVER_PASSWORD || process.env.PROXY_API_KEY || "";
}
export function checkAuth(headers: Headers): { allowed: boolean; message: string } {
  const expected = serverPassword();
  if (!expected) return { allowed: false, message: "FREEBUFF_SERVER_PASSWORD 未配置（缺省回退 PROXY_API_KEY）" };
  const auth = headers.get("authorization") || "";
  // 只接受 Basic；解析 base64 后比对冒号后段（用户名不校验，与 bridge.js 一致）
  // fail closed
}
```

- [ ] **Step 3: 实现 providers.ts**

```ts
// 读免费模型目录：common/src/constants/freebuff-models.ts（DEFAULT_FREEBUFF_MODEL_ID /
// resolveAvailableFreebuffModel 等；找不到则静态兜底清单。agents/constants.ts 没有 FREE_MODE_AGENT_MODELS）
// 输出 opencode 原始形状（p.models 是对象 map，不是数组 —— 见 src/opencode.js 的 fetchProviders）：
// { providers: [{ id: "opencode", name: "freebuff", models: { "<modelId>": { id, name, ... } } }],
//   default: { opencode: "<默认模型>" } }
```

- [ ] **Step 4: 实现 server.ts**（骨架版：路由只有 providers/agent/OPTIONS/401）

```ts
// Bun.serve({ hostname, port, fetch(req) => 路由分发 })
//  - OPTIONS 任意路径 → 204 + CORS
//  - checkAuth 失败 → 401 + WWW-Authenticate: Basic realm="opencode"
//  - GET /config/providers → 200 providersPayload()（models 对象 map 形状）
//  - GET /agent → 200 免费 agent 清单（非空数组，≥1 项 —— bridge T3/T6 要求）
//  - GET /experimental/tool/ids → 200 { data: [工具id,...] }（bridge T7）
//  - GET /session/:id/todo → 200 []（bridge T11）
//  - GET / → 200 text/html 极简状态页（bridge T16）
//  - 其余 → 404 { error: { message: "unknown route (serve subset)" } }
// 端口：env FREEBUFF_SERVE_PORT 或 CLI --port 参数；--port 0 时从 Bun.serve 返回值拿实际端口，
// 打印独占 ready 行到 stdout：FREEBUFF_SERVE_READY {"port":N}（serve 分支关闭 logger stdout，避免解析竞态）
```

- [ ] **Step 5: entry.ts 加 serve 分支**（追加在 terminal-broker 判断之后、`await import('./index')` 之前）

```ts
if (isServeInvocation(process.argv, process.env)) {
  // ⚠ 必须在此处（import('./index') 之前）拦截：parseArgs()/commander 的 choices(['login'])
  // 会拒绝未知 command/option。--serve 与 serve 子命令二选一，与 src/freebuff.js spawn 一致。
  await startServeServer({ port: ..., hostname: process.env.FREEBUFF_SERVE_HOSTNAME || "127.0.0.1" });
  // 保持进程常驻（Promise 不 resolve / 顶层 await 挂住）
  process.exit(0); // 仅 shutdown 信号触发
}
```

- [ ] **Step 6: 重建二进制并黑盒验证**

```bash
FREEBUFF_MODE=true bun freebuff/cli/build.ts 0.0.1-serve.1
./freebuff --serve --port 0 &
# 读 stdout 的 FREEBUFF_SERVE_READY {"port":xxxx}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/config/providers          # 401
curl -s -u opencode:$FREEBUFF_SERVER_PASSWORD http://127.0.0.1:$PORT/config/providers | head -c 300
curl -s -X OPTIONS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/anything          # 204
curl -s -u opencode:$FREEBUFF_SERVER_PASSWORD http://127.0.0.1:$PORT/nope -o /dev/null -w '%{http_code}\n'  # 404
```
期望：401 / 200（providers JSON）/ 204 / 404。

---

### Task 3: session 层 + message 引擎接入（进程内 CodebuffClient）

**Files:**
- Create: `cli/src/serve/sessions.ts`、`cli/src/serve/engine.ts`

**Interfaces:**
- Produces:
  - `SessionStore`：`createSession(title) → id`、`getSession(id)`、`listSessions()`、`deleteSession(id)`；每 session 持 `previousRun: RunState|null`、`messages: MessageRecord[]`、`running: Promise 链（串行队列）`、`abort: AbortController|null`
  - `Engine.runPrompt(session, prompt, system?) → Promise<{ parts: Part[]; info: { tokens } }>`：单飞（同 session 排队）、`maxAgentSteps` 默认 20、超时 env `FREEBUFF_RUN_TIMEOUT_MS` 默认 0（不超时）
  - `POST /session`、`GET /session`、`GET /session/:id`、`PATCH /session/:id`、`DELETE /session/:id`、`POST /session/:id/message`、`GET /session/:id/message/:messageId`

- [ ] **Step 1: 写失败断言**（路由不存在）

```bash
curl -s -X POST -u opencode:$PW http://127.0.0.1:$PORT/session -d '{"title":"t"}' -o /dev/null -w '%{http_code}\n'
```
期望：404（Task 2 骨架行为）。

- [ ] **Step 2: 实现 sessions.ts**（内存态；单会话串行队列）

```ts
type Session = {
  id: string;               // crypto.randomUUID()
  title: string;
  previousRun: RunState | null;
  messages: MessageRecord[]; // { id, parts: Part[], info }
  queue: Promise<unknown>;    // 串行化：runPrompt 用 queue = queue.then(op)
  abort: AbortController | null;
};
// POST /session body {title} → { id }
// PATCH /session/:id {title?} → 200 {id,title}
```

- [ ] **Step 3: 实现 engine.ts**（复用 CLI 现有 client 构造，见 `cli/src/utils/codebuff-client.ts`）

```ts
// getServeClient(): CodebuffClient | null
//   - 与 getCodebuffClient() 同参数（apiKey=getAuthTokenDetails().token、cwd=--cwd||process.cwd()、
//     logger、traceWriter）
//   - ⚠ 不注入 terminalCommandBroker（headless 可省略，run.ts 注释；工具命令默认直接执行）
//   - ⚠ ask_user 不直通 AskUserBridge（serve 无 TUI）：override 为自动应答——
//     FREEBUFF_AUTO_APPROVE !== "false" 时返回预置答案/跳过，否则返回 skipped
//   - 未登录 → 返回 null（message 端点 502 + 提示先跑 `freebuff login`）
// runPrompt(session, prompt, system?, model?, variant?)：
//   const handleEvent = (e) => events.publish(session.id, toServeEvent(e));   // Task 4
//   const handleStreamChunk = (c) => events.publishDelta(session.id, c);      // Task 4（真流式）
//   const agentId = 免费档 LITE agent（当前 'base2-free'，读 cli/src/utils/constants.ts AGENT_MODE_TO_ID）
//   const result = await client.run({ agent: agentId, costMode: 'free',      // AGENT_MODE_TO_COST_MODE
//     prompt, previousRun: session.previousRun, handleEvent, handleStreamChunk,
//     signal: session.abort?.signal,
//     extraCodebuffMetadata: mapModelToFreebuff(model),   // RunOptions 无 model 参数（见设计 §4.4）
//     maxAgentSteps: 20, knowledgeFiles: system ? { "SYSTEM.md": system } : undefined });
//   session.previousRun = result;
//   tokens 取 result.sessionState 内的 tokens 字段（以 SDK RunState 实际字段为准，找不到则全 0）
//   返回 parts（见 Task 4 的拆分/归一化）
```

- [ ] **Step 4: 实现 message 路由**

```ts
// POST /session/:id/message
//   body: { parts:[{type:"text",text}|{type:"file",mime,url}], model?, system?, variant? }
//   - 只取 parts 里首个 text part 为 prompt（file part 先忽略，P2）
//   - model/variant 先过映射层（RunOptions 无 model 参数）：providerID/modelID → freebuff 模型
//     （resolveSupportedFreebuffModel）+ extraCodebuffMetadata；未知/付费模型（gpt-5.6-luna）落默认免费模型；
//     reasoning_effort → freebuff_reasoning_effort
//   - client 未登录 → 502 { error: { message: "freebuff 未登录：先运行 freebuff login" } }
//   - 串行入队 → 返回 200 { id: messageId, parts, info: { tokens } }
// GET /session/:id/message/:messageId → 单条 MessageRecord
// GET /session/:id/todo → 200 []（bridge T11）
```

- [ ] **Step 5: 登录与验证**

- 交互登录一次：`./freebuff login`（在带 TTY 的终端跑设备码流程；无 TTY 环境提示用户在本地登录后复制 `~/.config/manicode/credentials.json` 到部署环境）。注意：**不要把 credentials.json 提交进 git**。
- 重建二进制，黑盒验证：

```bash
ID=$(curl -s -X POST -u opencode:$PW http://127.0.0.1:$PORT/session -d '{"title":"t"}' | jq -r .id)
curl -s -X POST -u opencode:$PW http://127.0.0.1:$PORT/session/$ID/message \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"用一句话回复 OK"}]}' | head -c 500
```
期望：200，`parts[].text` 含模型回答，`info.tokens` 数值或 0。

---

### Task 4: /event SSE + 事件归一化 + 权限自动放行

**Files:**
- Create: `cli/src/serve/events.ts`、`cli/src/serve/permissions.ts`

**Interfaces:**
- Produces:
  - `EventBus`：`subscribe(sessionId, handler) → unsubscribe`、`publish(sessionId, event)`
  - `/event` SSE：连接建立即 200 `text/event-stream` + `x-accel-buffering:no`；按 session 过滤（`properties.sessionID`）；连接关闭清理
  - `permission.asked` 自动放行：`FREEBUFF_AUTO_APPROVE !== "false"` 时对权限事件直接答复 allow（still 广播事件）
  - `POST /session/:id/permissions/:permissionID`：允许外部显式答复（透传层会带，兼容 opencode 客户端）

- [ ] **Step 1: 写失败断言**（/event 无订阅源）

```bash
curl -s -N -u opencode:$PW --max-time 3 http://127.0.0.1:$PORT/event | head -c 200
```
期望：Task 3 骨架返回 404 或空流（先记录当前行为）。

- [ ] **Step 2: 实现 events.ts**

```ts
// 每 session 一个订阅者集合；/event 处理器把事件 JSON 按 SSE 帧写：
//   "data: " + JSON.stringify({type, properties}) + "\n\n"
// 连接建立立即 200 + flushHeaders（不等事件，bridge T13 要求首帧 <8s）；
// 无事件期间保持连接不断开（T14 要求空连接存活 1.5s）。
// 真流式：Engine 的 handleStreamChunk（text / reasoning_chunk 增量）→ 直接发
//   message.part.delta（properties:{ sessionID, partID, messageID, field, delta }）；
//   handleEvent → message.part.updated 累积全文。
// handleEvent 归一化（Engine 内调用，SDK 事件类型以 @codebuff/common/types/print-mode 的
//   PrintModeEvent 为准；翻译逻辑参考 cli/src/sdk-event-handlers.ts）：
//   - 含 reasoning/thinking 文本的事件 → { type:"message.part.updated", properties:{ sessionID, part:{ id, type:"reasoning", text } } }
//   - 其余文本事件 → { type:"message.part.updated", properties:{ sessionID, part:{ id, type:"text", text } } }
//   - 权限类事件 → { type:"permission.asked", properties:{ sessionID, id } } + permissions 注册表登记
//   - part id 稳定性：同一 part 多次 updated 用同一 id（按 SDK event 的 message id + 序号推导，或维护 partIdByText 映射——以前者为准）
// run() resolve 后补发最终 message.updated（properties:{ sessionID, messageID }），保证订阅方收尾
```

- [ ] **Step 3: 实现 permissions.ts**

```ts
// serve 无 TUI，SDK 交互面收敛为两处：
//   - ask_user（overrideTools）：FREEBUFF_AUTO_APPROVE !== "false" 时自动应答
//     （返回预置答案/跳过），否则 skipped —— 绝不让 run 挂起
//   - 工具权限：不注入 terminalCommandBroker（headless 可省略），工具命令默认直接执行；
//     若实测仍出现权限挂起，再实现 permissionRegistry（Map<id,{sessionID,resolve}> +
//     30s 超时 deny 兜底）
// POST /session/:id/permissions/:permissionID 仍实现：接受外部显式答复（透传层会带），返回 2xx
```

- [ ] **Step 4: 真流式验证（对照本仓库 streamChat 的消费逻辑）**

- 起 `freebuff serve`，跑一次带多轮工具的 prompt（如"先列出当前目录再回复"），并行开 `curl -N /event`：
  - 收到 `message.part.updated`（text/reasoning），`properties.sessionID` 正确；
  - 工具权限事件被自动放行，run 能完成；
  - 结束前收到最终 updated/完形事件。
- 冒烟脚本 `scripts/test-serve.mjs`（fork 内新增，纯黑盒 curl 断言）：
  - 401 无凭据 / OPTIONS 204 / providers 200（models 对象 map 形状）/ agent 200 **非空数组** / /experimental/tool/ids 200 / / 200 text/html / session CRUD / /session/:id/todo 200 / message 200（含 tokens）/ event 首帧 <8s 且空连接保持 / permissions 显式答复 2xx / 未知路由 404

---

### Task 5: 桥接仓库接入（AGENT_RUNTIME 切换 + 双引擎回归）

**Files:**
- Create: `scripts/fetch-freebuff.mjs`、`src/freebuff.js`
- Modify: `handler.js`（引擎选择）、`README.md`、`env.example`

**Interfaces:**
- Produces:
  - `src/freebuff.js` 导出与 `src/opencode.js` 同签名：`ensureRuntime() / getServerUrl() / serverFetch(url, opts) / serverPassword() / fetchProviders() / mapVariant()`
  - env：`AGENT_RUNTIME`（`opencode` 默认 | `freebuff`）、`FREEBUFF_BIN`、`FREEBUFF_VERSION`、`FREEBUFF_BIN_URL`、`FREEBUFF_BIN_SHA256`、`FREEBUFF_SERVER_PASSWORD`、`FREEBUFF_AUTO_APPROVE`、`FREEBUFF_SERVE_HOSTNAME`

- [ ] **Step 1: 写失败断言**（freebuff 引擎未实现）

```bash
AGENT_RUNTIME=freebuff node -e "require('./src/freebuff.js')" 2>&1 | tail -1
```
期望：`MODULE_NOT_FOUND`（当前不存在）。

- [ ] **Step 2: 实现 scripts/fetch-freebuff.mjs**（对标 scripts/build.sh 下载段）

```js
// FREEBUFF_BIN_URL 下载 → 校验 FREEBUFF_BIN_SHA256（sha256 不匹配即失败）→ chmod 0o755 → dist/freebuff-<platform>-<arch>
// 无 FREEBUFF_BIN_URL 时提示：从 fork 的 GitHub Release 拿（见设计文档 §9.3）
```

- [ ] **Step 3: 实现 src/freebuff.js**（复制 src/opencode.js 骨架改 spawn 参数）

```js
// ensureRuntime()：
//   spawn(FREEBUFF_BIN || dist 下的二进制, ["--serve", "--hostname", "127.0.0.1", "--port", "0"],
//         { env: { ...process.env, FREEBUFF_SERVER_PASSWORD: serverPassword() } })
//   从 stdout 的 FREEBUFF_SERVE_READY {"port":N} 行解析 serverUrl（不是首行——避免 logger 竞态）；
//   5s 内没就绪 → 抛错
//   child 退出 → instance=null（下次 ensureRuntime 重启，与 opencode 语义一致）
//   ⚠ 不要学 src/opencode.js 重定向 HOME/XDG_*：serve 要读 ~/.config/manicode/credentials.json 的登录 token
// serverFetch/fetchProviders/serverPassword：照抄 src/opencode.js 同名单（内部 Basic 注入）
//   fetchProviders 归一化为 { models: [{ id: "provider/model", owned_by }], defaultModel }
//   （与 opencode 引擎一致；原始 /config/providers 里 p.models 是对象 map）
// mapVariant：把 reasoning_effort 映射为 freebuff effort（freebuff_reasoning_effort，白名单外返回 undefined）
//   —— 不返回 undefined 兜底，见设计 §4.4
```

- [ ] **Step 4: handler.js 引擎选择**

```js
// 引擎选择零侵入：src/opencode.js 改为 selector
//   module.exports = require(process.env.AGENT_RUNTIME === "freebuff" ? "./freebuff" : "./opencode-core");
// 原 src/opencode.js 改名为 src/opencode-core.js。
// handler.js / src/bridge.js / src/proxy.js 的 require("./opencode") 全部不动。
```

- [ ] **Step 5: 双引擎回归（本仓库验收标准）**

```bash
# 引擎 = freebuff
node scripts/fetch-freebuff.mjs && AGENT_RUNTIME=freebuff node handler.js &
node scripts/smoke-test.mjs 2>&1 | tail -2    # 期望 5/5 checks passed
node scripts/test-bridge.mjs 2>&1 | tail -3   # 期望 21 passed, 0 failed

# 引擎 = opencode（回归）
node scripts/smoke-test.mjs 2>&1 | tail -2    # 5/5
node scripts/test-bridge.mjs 2>&1 | tail -3   # 21/21
```

**test-bridge 按引擎参数化（最小改动，改 `scripts/test-bridge.mjs`）：**
- T8（/config/providers `text.length > 10000`）：freebuff 模型少，按引擎降阈值或跳过（`BRIDGE_LARGE_RESPONSE=off`）；
- T16（GET / → text/html）：serve 实现极简 HTML 页后无需参数化；
- T17a（POST /pty 200 拿 id）+ T17（/pty 101 握手）：freebuff 不实现 pty → 都参数化为断言"透传上游响应（非 502）"；**原脚本 `skip（无 pty）` 分支计 fail**，必须显式改断言而非依赖 skip；
- T7/T11 由 serve 实现覆盖（T2/T3）。

- [ ] **Step 6: 文档**（README 新增"freebuff 引擎"章节：架构图、env 表、登录流程、风控声明；env.example 同步；引用设计文档）

---

### Task 6: 上游同步工作流落地

**Files:**
- Create: fork 内 `.github/workflows/sync-upstream.yml`、`.github/workflows/release-serve.yml`、fork 内 `docs/sync-workflow.md`
- Test: 演练一次真实同步（合并 upstream 新 commit）→ 双绿

**Interfaces:**
- Produces: 可重复的同步 + 发布流程（设计文档 §9 的实现）

- [ ] **Step 1: 同步脚本（CI 或本地命令）** `docs/sync-workflow.md` + `.github/workflows/sync-upstream.yml`

```yaml
# 手动触发 + schedule（每周一 02:00 UTC）
# jobs: 
#  1) git fetch upstream main
#  2) git merge upstream/main --no-edit（冲突时 workflow 失败 → 人工处理）
#  3) bun install && bun run typecheck && bun test
#  4) 全绿后 push main；版本号 = 上游 package.json version + '-serve'
```

- [ ] **Step 2: 冲突预案文档化**（写进 docs/sync-workflow.md）
  - `cli/src/entry.ts`：三分支合并模板（贴出当前三分支的 diff 形态）；
  - `package.json`（workspaces/deps 变动）：三向合并后 `bun install`；
  - `sdk/src/run.ts`（RunOptions/事件形状）、`common/src/constants/freebuff-models.ts`（模型目录）、`sdk-event-handlers.ts` 变化：适配 serve/providers.ts + serve/events.ts + serve/engine.ts（唯一预期经常变的适配点，集中隔离在这三个文件）。

- [ ] **Step 3: 发布 workflow `.github/workflows/release-serve.yml`**
  1. 触发：workflow_dispatch（输入版本号）或 sync 成功后自动；
  2. `NEXT_PUBLIC_CB_ENVIRONMENT=prod FREEBUFF_MODE=true bun freebuff/cli/build.ts <ver>` linux-x64 + linux-arm64（必须设 prod，否则 config 目录变 `manicode-<env>` 找不到登录 token）；构建需要 bun 1.3.14 + 网络（OpenTUI native bundle）；产物在 `cli/bin/freebuff` + 同目录 `tree-sitter.wasm`；
  3. 上传 Release `freebuff-serve-<platform>-<arch>-v<ver>` + sha256 文件；
  4. 输出 Release URL。桥接仓库手工把 `FREEBUFF_BIN_URL` + `FREEBUFF_BIN_SHA256` + `FREEBUFF_VERSION` 更新为对应版本。

- [ ] **Step 4: 端到端演练**
  - 在 fork 里 merge 一次当周 upstream main（若有变动），跑 Task 5 双引擎回归全绿；
  - 发布一版 `-serve` 二进制，桥接仓库配好 env，`AGENT_RUNTIME=freebuff` 预览就绪、浏览器/OpenAI 客户端验收通过；
  - 演练结论写进 `docs/sync-workflow.md`（含每次升级耗时与踩坑记录）。

---

## Self-Review（writing-plans 技能要求）

1. **Spec 覆盖**：契约子集（设计 §4）→ T2/T3/T4 逐一映射 ✓；鉴权（§4.1）→ T2 ✓；事件归一化（§4.3）→ T4 ✓；桥接侧改动（§6）→ T5 ✓；登录凭证（§7）→ T3 Step 5 ✓；同步工作流（§9）→ T6 ✓；风险（§8）→ T3/T5 的 env 与文档落地 ✓
2. **占位符扫描**：无 TBD/TODO；`sdk/src/run.ts` 的实际事件名/tokens 字段以实现时读取为准（标注了"以实际字段为准"，非占位符）
3. **类型一致性**：`src/freebuff.js` 导出签名与 `src/opencode.js` 对齐（T5 Step 3 对照实现）；`events.ts` 事件形状与 streamChat 消费字段一致（T4 Step 4 验证）
4. **冲突面控制**：fork 只改 entry.ts（T2 Step 5），serve 全新增文件，保证 T6 同步 merge 冲突可控 ✓