# Vercel 进程内 opencode —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 serverless 部署目标从 Deno Deploy（768MiB OOM）迁到 Vercel（Hobby 2GB）：新增 `api/` 三件套（Vercel Node.js 24.x fetch 入口 / 进程内引擎适配器 / Web Streams SSE 写器）+ `vercel.json` + 本地测试 shim；**完全删除** `deno/` 路径；Node 常驻形态与 vendor bundle 零改动。

**Architecture:** `handler(req: Request): Promise<Response>` 是框架无关核心（从 `deno/main.ts` 逐函数移植），api/index.ts 只是 Vercel fetch-export 薄壳；引擎侧复用 `vendor/dist/opencode-server.mjs`（`app.fetch` 进程内直调，bundle 零补丁）；本地测试 shim（`api/local.mjs`，node:http ↔ Web Request 桥接）与线上走同一 handler。

**Tech Stack:** Node.js 24.x（Vercel runtime，本地 ≥22.5 亦可跑测试）、纯 Web Streams、现有 CJS 纯函数（`src/proxy.js` / `src/opencode.js` / `src/zen-models.js`）经 `createRequire` 复用。零新 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md`（本计划从 spec 论证，执行者两份都要读）

## Global Constraints

- 完全替换：`deno/`（3 文件）、`deno.json`、`scripts/test-deno.mjs`、`scripts/test-multiturn.mjs` 全部删除；不保留双路径（spec §1.2）
- vendor bundle 零补丁：`vendor/` 目录不动（spec §3）
- Node 常驻形态零改动：`handler.js`、`src/proxy.js`、`src/bridge.js`、`src/opencode.js`、`src/zen-models.js` 不动（spec §3）
- 零新 npm 依赖（spec 头部 Tech Stack）
- Hobby 口径：`maxDuration: 300`；内存 `limitMB` 显示 2048（spec §2/§5）
- 单门制鉴权：`Bearer PROXY_API_KEY` fail closed；透传路径 401 带 `WWW-Authenticate: Basic realm="opencode"`（spec §5）
- 翻译层语义逐函数保留：会话锚定 / variant 映射 / reasoning_content / 复读裁剪 / usage 透传 / permission.asked 自动放行（spec §1.3）
- 无 LLM key 时测试口径：`POST /v1/chat/completions` 允许 502（引擎链路通即可），D5/D6 断言兼容此场景（沿用 test-deno.mjs 口径）
- 提交信息用 conventional commits（仓库既有惯例：`feat:` / `fix:` / `chore:` / `docs:`）

---

### Task 1: api/stream.ts + api/engine.ts —— 流式写器与引擎适配器移植

**Files:**
- Create: `api/stream.ts`（复制 `deno/stream.ts`，内容原样）
- Create: `api/engine.ts`（`deno/engine.ts` 去 Deno 化移植）

**Interfaces:**
- Produces（Task 2/3 依赖）:
  - `export const SSE_HEADERS: Record<string, string>`
  - `export function createSseWriter(base: Record<string, unknown>, opts?: { onCancel?: () => void }): SseWriter`（SseWriter 成员：`stream` / `sse` / `chunk` / `usage` / `stop` / `done` / `end`，语义与 deno/stream.ts 完全一致）
  - `export function* sseLines(res: Response): AsyncGenerator<string>`
  - `export function ensureEngine(): Promise<AppLike>`（AppLike = `{ fetch: (request: Request) => Response | Promise<Response> }`）
  - `export async function engineFetch(pathWithQuery: string, init?: RequestInit): Promise<Response>`
  - `export function engineReady(): boolean`
  - `export function memorySnapshot(): { rssMB; heapUsedMB; heapTotalMB; externalMB; buffersMB }`
  - `export function bootUptimeSec(): number`

- [ ] **Step 1: 创建 api/ 目录并复制 stream.ts**

```bash
mkdir -p api
cp deno/stream.ts api/stream.ts
```

说明：`deno/stream.ts` 是纯 Web Streams（ReadableStream / TextEncoder / setTimeout），零 Deno API，原样可用。文件头部注释把「spec §2」改为指向 Vercel spec：`docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md`。

- [ ] **Step 2: 写 api/engine.ts**

以 `deno/engine.ts` 为底本，做以下修改（其余逐行保留）：

1. 头部注释改为引用 Vercel spec，说明「Node 24.x runtime / 2GB 上限、无应用层熔断」。
2. 删除 `import { pathToFileURL } from "node:url"` 之外不需要的 Deno 特有引用（原文件只有 node: 前缀导入，无 Deno 导入，确认即可）。
3. `memorySnapshot()` 整体替换为 `process.memoryUsage()` 版本：

```ts
export function memorySnapshot(): {
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  buffersMB: number
} {
  try {
    const m = process.memoryUsage()
    return {
      rssMB: m.rss / 1048576,
      heapUsedMB: m.heapUsed / 1048576,
      heapTotalMB: m.heapTotal / 1048576,
      externalMB: m.external / 1048576,
      buffersMB: m.arrayBuffers / 1048576,
    }
  } catch {
    return { rssMB: -1, heapUsedMB: -1, heapTotalMB: -1, externalMB: -1, buffersMB: -1 }
  }
}
```

4. **删除** 整个 `startMemoryMonitor()` 函数、`monitorStarted` 变量、`ensureEngine()` 内的 `startMemoryMonitor()` 调用行（2GB 上限下熔断无意义，spec §2）。
5. `ensureEngine()` 内预热请求保持：`await app.fetch(new Request("http://internal/doc"))`。
6. `prepareEnv()` 原样保留（HOME/XDG 重定向、auth.json 写入、7 个 `OPENCODE_DISABLE_*` 压榨变量），仅把默认数据目录名从 `opencode-deno-data` 改为 `opencode-api-data`。
7. `bootUptimeSec()` 原样保留（`Date.now() - BOOT_TS`，无 Deno 依赖）。

- [ ] **Step 3: 冒烟验证两个模块可加载**

```bash
node --experimental-strip-types -e "
  const { createRequire } = await import('node:module');
" 2>/dev/null; node -e "
  (async () => {
    const m = await import('./api/stream.ts');
    console.log('stream.ts exports:', Object.keys(m).join(','));
  })();
" --experimental-strip-types 2>&1 | head -5
```

说明：Node 22.23 本地支持 `--experimental-strip-types` 直接加载 .ts（仅类型剥离，无转换——本文件只用了 TS 类型标注语法，兼容）。预期输出含 `createSseWriter,sseLines,SSE_HEADERS`。engine.ts 因顶部有 `import os from "node:os"` 等常规导入同样可加载；完整链路验证在 Task 3 的测试里。

若本地 Node 版本不支持 strip-types（<22.6），改用 `npx tsx` 或临时跳过本步——Task 3 的黑盒测试是真正的验证关卡（api/index.ts 引用两个模块后经 esbuild 打包运行，类型问题会在那时暴露）。

- [ ] **Step 4: Commit**

```bash
git add api/stream.ts api/engine.ts
git commit -m "feat(vercel): port SSE writer and in-process engine adapter from deno path"
```

---

### Task 2: api/index.ts + api/local.mjs —— Vercel 入口与本地 shim

**Files:**
- Create: `api/index.ts`（`deno/main.ts` 移植，路由/鉴权/翻译层逐函数保留）
- Create: `api/local.mjs`（本地 node:http ↔ Web Request 桥接）

**Interfaces:**
- Consumes: Task 1 的 `engineFetch`/`engineReady`/`memorySnapshot`/`bootUptimeSec`/`ensureEngine`/`SSE_HEADERS`/`createSseWriter`/`sseLines`；`src/zen-models.js` 的 `normalizeModel`/`modelsPayload`；`src/proxy.js` 的 `extractUserPrompt`；`src/opencode.js` 的 `mapVariant`/`extractTokens`
- Produces（Task 3 依赖）:
  - `api/index.ts` 导出 `export async function handler(req: Request): Promise<Response>`（框架无关核心）与 `export default { fetch: handler }`（Vercel fetch-export 壳）；模块加载时后台触发 `void ensureEngine()` 预热
  - `api/local.mjs`：`PORT`（默认 8787）起 node:http 服务，任何请求 → 收集 body → 构造 Web Request（`http://localhost:<PORT>` + url + method + headers + body + AbortController 信号）→ 调 `handler` → 回写状态/头/body（body 用 `response.body.pipeTo` 不可行——node:http 需要手动泵：`for await (const chunk of response.body) res.write(chunk)` 然后 `res.end()`）

- [ ] **Step 1: 写 api/index.ts**

以 `deno/main.ts` 为底本移植，结构对照：

1. **导入区**：Deno 的 `createRequire` 兼容写法

```ts
// deno-lint-ignore no-explicit-any
const { createRequire } = await import("node:module")
const require = createRequire(import.meta.url)
```

在 Node 24 下简化为顶部直接导入：

```ts
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { normalizeModel, modelsPayload } = require("../src/zen-models.js") as {
  normalizeModel: (m: string | undefined) => string
  modelsPayload: () => unknown
}
const { extractUserPrompt } = require("../src/proxy.js") as {
  extractUserPrompt: (messages: unknown[]) => { prompt: string; system: string; fileParts: unknown[] }
}
const { mapVariant, extractTokens } = require("../src/opencode.js") as {
  mapVariant: (body: Record<string, unknown>) => string | undefined
  extractTokens: (info: unknown) => Record<string, number>
}
import { bootUptimeSec, engineFetch, engineReady, ensureEngine, memorySnapshot } from "./engine.ts"
import { SSE_HEADERS, createSseWriter, sseLines } from "./stream.ts"
```

（TS 类型标注保留——Vercel 构建走 esbuild/TS 编译；本地 shim 用 `--experimental-strip-types` 或由测试脚本以 node 加载 .ts 的 strip-types 模式拉起。）

2. **逐函数原样移植**（从 deno/main.ts 复制，零逻辑改动）：`CORS`、`HOP_BY_HOP`、`jsonError`、`jsonResponse`、`checkAuth`、`sessions` Map + `sessionKeyFor`、`responseHeaders`、`handleModels`、`ChatBody` 类型、`completionId`、`parseModelPair`、`PartState`、`handleChat`（流式，含 `partStates` 状态机 / `clientGone` AbortController / `startEventLoop` / `stopEventLoop` / `flushState` / `pushUpdate`）、`handleChatNonStream`、`stripThink`、`stripEcho`。

3. **修改点（仅以下几处）**：
   - health 端点里 `limitMB: 768` → `limitMB: 2048`
   - 文件头注释：`Deno 入口（spec §2/§5）` → `Vercel 入口（spec docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md §2/§5）`；日志前缀 `[deno]` → `[api]`
   - **删除**文件尾部整个启动块：`const port = ...`、`console.log([deno] 监听...)`、`void ensureEngine()...`、`Deno.serve({...})` 整段
   - **新增**尾部（Vercel 壳 + 预热）：

```ts
// ---- Vercel fetch-export 壳 + 后台预热 ----
// fluid compute：模块加载即后台预热（bundle import + effect runtime 首建 30-48s），
// 实例请求间保活，后续请求直接命中就绪引擎。
void ensureEngine().catch((e) => {
  console.error("[api] 后台引擎预热失败（将由下个请求重试）:", String((e as Error).message || e))
})

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handler(request)
    } catch (err) {
      const msg = String((err as Error).message || err)
      console.error("[api] unhandled:", msg)
      return jsonError(502, msg, "upstream_error")
    }
  },
}

export { handler }
```

4. 客户端断连注释里「Deno legacy serve 会 abort req.signal」一句改为「fluid compute per-path cancellation 触发 request.signal abort」；`clientGone` 机制本身原样保留。

- [ ] **Step 2: 写 api/local.mjs**

```js
#!/usr/bin/env node
/**
 * 本地 shim：node:http ↔ Web Request 桥接（仅本地/测试用，不参与部署）。
 * 与线上同一 handler（api/index.ts），测试结论可信。
 * 用法：node api/local.mjs   （PORT 环境变量，默认 8787）
 * Node ≥22.6 需 --experimental-strip-types 加载 .ts；由启动器统一注入。
 */
import { createServer } from "node:http"

const PORT = Number(process.env.PORT || 8787)
const mod = await import("./index.ts")
const handler = mod.handler

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const ac = new AbortController()
  res.on("close", () => ac.abort())

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, String(item))
  }
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)
  const request = new Request(url, {
    method: req.method || "GET",
    headers,
    body: body.length && req.method !== "GET" && req.method !== "HEAD" ? new Uint8Array(body) : undefined,
    signal: ac.signal,
    // @ts-ignore duplex 在 Web 类型里必填（Node fetch 实现）
    duplex: "half",
  })

  try {
    const response = await handler(request)
    const resHeaders = {}
    response.headers.forEach((v, k) => { resHeaders[k] = v })
    res.writeHead(response.status, resHeaders)
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk)
    }
    res.end()
  } catch (e) {
    console.error("[local] request error:", e)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(e?.message || e), type: "internal_error" } }))
    } else {
      res.end()
    }
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[api] local shim listening on 0.0.0.0:${PORT}`)
})
```

注意：`body.length && ...` 在 body 为空时传 `undefined`，避免 Node fetch 对 GET 带 body 抛错；`duplex: "half"` 通过注释忽略类型（.mjs 无类型检查，注释仅文档性）。

- [ ] **Step 3: 手工冒烟（不依赖测试脚本）**

```bash
PORT=8791 node --experimental-strip-types api/local.mjs &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/v1/health   # 401（无凭据）
curl -s http://127.0.0.1:8791/v1/health -H "Authorization: Bearer wrong"   # 401 JSON
kill %1
```

预期：两个 401（引擎未配置 key 时 health 仍需鉴权——单门制 fail closed，对齐 test-deno D1/D3 口径：D3 用正确 key 后 200）。

- [ ] **Step 4: Commit**

```bash
git add api/index.ts api/local.mjs
git commit -m "feat(vercel): port handler entry as fetch-export shell with local dev shim"
```

---

### Task 3: scripts/test-api.mjs —— 黑盒测试 D1–D10（TDD 关卡）

**Files:**
- Create: `scripts/test-api.mjs`（`scripts/test-deno.mjs` 断言平移，boot 目标更换）

**Interfaces:**
- Consumes: Task 2 的 `api/local.mjs`（boot 目标）
- Produces: `node scripts/test-api.mjs` 退出码 0 = D1–D10 全绿

- [ ] **Step 1: 复制 test-deno.mjs 为 test-api.mjs 并改 boot 逻辑**

```bash
cp scripts/test-deno.mjs scripts/test-api.mjs
```

只改以下几处（断言 D1–D10 原样保留）：

1. 头部注释：`Deno 路径黑盒测试` → `Vercel 路径黑盒测试（api/ 入口）`；`deno run --allow-all deno/main.ts` → `node --experimental-strip-types api/local.mjs`；`DENO_BIN 可覆盖` 句删除。
2. boot 段（原 `spawn("deno", ["run", "--allow-all", "deno/main.ts"], ...)` 附近）改为：

```js
const NODE_FLAGS = process.version.startsWith("v2")
  ? []
  : ["--experimental-strip-types"]
child = spawn(process.execPath, [...NODE_FLAGS, "api/local.mjs"], {
  env: { ...process.env, PORT: String(port), PROXY_API_KEY: KEY },
  stdio: ["ignore", "pipe", "pipe"],
})
```

其中 `port` 无入参时取随机空闲口（`await import("node:net")` + `net.createServer` listen(0) 拿 `address().port` 后关闭——沿用原脚本如有同机制则保留原实现，否则用此段替换 `DENO_BIN` 分支）。`child.exitCode != null` 的报错信息 `deno 进程提前退出` → `api local 进程提前退出`。
3. 日志/报错文案里的 `deno` 字样全部改 `api`。

- [ ] **Step 2: 跑测试验证（需 OPENCODE_API_KEY 才能全绿；无 key 时 D5/D6 允许 502 口径已内置）**

```bash
PROXY_API_KEY=test node scripts/test-api.mjs
```

预期：D1–D10 输出 10 项断言结果。无 `OPENCODE_API_KEY` 的环境下 D5（非流式对话）与 D6（流式）会因上游 LLM 调用失败而 502/错误帧——这不算环境问题，是 spec §8 声明的口径；**有 key 的本地环境必须全绿**（`.env` 里有 `OPENCODE_API_KEY`，脚本会自动读取——沿用 test-deno.mjs 的 env 加载逻辑）。

- [ ] **Step 3: 修复暴露的问题直至全绿**

常见问题预判：
- `--experimental-strip-types` 在本地 Node 22.23 可用；若报「TypeScript is not supported」→ 检查 NODE_FLAGS 分支
- CJS require 在 ESM .ts 里的 `require` 需要文件为 `.ts` 且经 strip-types 后 `createRequire` 正常工作（Task 2 已用同机制验证）
- 引擎冷启动 30–48s：waitForReady 超时保持 90000ms 不变

- [ ] **Step 4: Commit**

```bash
git add scripts/test-api.mjs
git commit -m "test(vercel): port D1-D10 blackbox suite onto api local shim"
```

---

### Task 4: vercel.json + package.json —— 平台配置

**Files:**
- Create: `vercel.json`
- Modify: `package.json`（engines + scripts）

**Interfaces:**
- Produces: Vercel 构建时读取的函数配置（maxDuration/includeFiles）与本地 npm scripts（`api:dev` / `api:test`）

- [ ] **Step 1: 写 vercel.json**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/index.ts": {
      "maxDuration": 300,
      "includeFiles": "vendor/dist/**"
    }
  }
}
```

说明：`includeFiles` 把动态 import 的 bundle + wasm 打进函数包（spec V3/风险 #2）；Hobby maxDuration 上限即 300（spec V2）；Framework Preset 用 Other，无需 buildCommand（fetch export 即函数本体）。

- [ ] **Step 2: 改 package.json**

1. `engines` 改为：

```json
"engines": {
  "node": "24.x"
}
```

（Node ≥18 的旧约束删除；Vercel 按 engines 固定 24.x，spec V4。本地开发 22.23 仍可跑——engines 只约束 Vercel 构建选择。）

2. `scripts` 增加（保留既有 build/local/package:scw）：

```json
"api:dev": "node --experimental-strip-types api/local.mjs",
"api:test": "node scripts/test-api.mjs"
```

3. **不删** devDependencies 里的 `opencode-ai` / `@types/*`（Node 常驻形态与类型检查仍用）；**不删** deno.json 引用相关内容（Task 5 删文件时一并处理 deno.json 本身）。

- [ ] **Step 3: 本地验证 scripts**

```bash
bun run api:dev & sleep 2; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/v1/health; kill %1
```

预期：401（shim 起来且鉴权 fail closed）。

- [ ] **Step 4: Commit**

```bash
git add vercel.json package.json
git commit -m "feat(vercel): add function config (maxDuration 300, includeFiles) and api scripts"
```

---

### Task 5: 删除 Deno 路径 + 回归测试

**Files:**
- Delete: `deno/main.ts`、`deno/engine.ts`、`deno/stream.ts`、`deno.json`、`scripts/test-deno.mjs`、`scripts/test-multiturn.mjs`

**Interfaces:**
- Consumes: Task 3 的 `scripts/test-api.mjs`（替代品已就位后才允许删除）
- Produces: 仓库内无 Deno 残留；Node 常驻形态回归全绿

- [ ] **Step 1: 确认替代品就位后删除**

```bash
test -f scripts/test-api.mjs && test -f api/index.ts && echo "替代品就位" || (echo "缺替代品，中止" && exit 1)
git rm -r deno deno.json scripts/test-deno.mjs scripts/test-multiturn.mjs
```

- [ ] **Step 2: Node 常驻形态回归（零回归关卡）**

```bash
node scripts/smoke-test.mjs 2>&1 | tail -3     # 预期 5/5 checks passed
node scripts/test-bridge.mjs 2>&1 | tail -3    # 预期 21 passed, 0 failed
```

说明：这两个脚本会真实拉起 `node handler.js` + opencode 子进程，需要 `.env` 的 `OPENCODE_API_KEY`（本地已配）。任何失败都先修复再继续——本任务不允许带病提交。

- [ ] **Step 3: 残留扫描**

```bash
grep -rn "deno" --include="*.md" README.md docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md | grep -v "从 Deno\|Deno Deploy\|deno/ 三件套\|deno/\|Deno 方案\|Deno 路径\|删除 deno" || echo "无残留引用"
```

预期：README 里对 Deno 的引用只剩历史对照语境（Task 6 会重写 README，此步只确认没有「推荐 Deno」口径的活性引用）。`package.json` 的 `allowScripts` 等字段确认无 deno 引用。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove deno deploy path (replaced by vercel api entry)"
```

---

### Task 6: README + env.example 文档更新

**Files:**
- Modify: `README.md`（Deno 章节整体替换为 Vercel 章节）
- Modify: `env.example`（口径同步）

**Interfaces:**
- Produces: 面向用户的部署文档（GitHub 集成两步 + 环境变量 + 限制声明 + 验收命令）

- [ ] **Step 1: 重写 README 头部与形态表**

把现有「两种形态」表与「Deno 进程内形态（方案 A，主力）」整章替换为：

```markdown
# opencode-scw —— 跑"原汁原味"的 opencode（Vercel 进程内 / Node 常驻双形态）

（保留项目一句话简介）

**两种形态**：

| 形态 | 入口 | 状态 |
| --- | --- | --- |
| **Vercel 进程内**（推荐） | `api/index.ts`（Vercel Function） | opencode 以预编译 bundle 嵌入 Vercel Node.js 24.x 函数进程，零子进程、单门制、端到端真流式。部署目标 [Vercel](https://vercel.com)：GitHub 集成，**推送即部署**，Hobby 2GB 内存 |
| **Node 常驻** | `node handler.js` | 旧形态，保留；全透传（含 WebSocket /pty）只在常驻形态可用 |
```

- [ ] **Step 2: 写「Vercel 进程内形态」章节**

结构沿用原 Deno 章节（架构图 / 环境变量表 / 本地跑 / 部署 / 内存语义 / 升级），内容要点：

1. **架构图**：从 spec §2 复制 ASCII 图。
2. **环境变量表**：

```markdown
| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PROXY_API_KEY` | ✅ | 代理访问密钥，所有请求必须带 `Authorization: Bearer <PROXY_API_KEY>`；未配置时 fail closed |
| `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`） | ✅（真对话） | opencode Zen API Key，写进引擎的 `auth.json`；不配也能起服务，但 LLM 调用会失败 |
| `OPENCODE_DEFAULT_MODEL` | ｜ | 默认模型（请求不带 `model` 时用） |
| `OPENCODE_DATA_HOME` | ｜ | 引擎数据目录（默认 `$TMPDIR/opencode-api-data`） |
| `OPENCODE_AUTO_APPROVE` | ｜ | `false` 关闭 agent 工具权限自动放行 |
| `OPENCODE_STREAM_SMOOTHING` / `OPENCODE_STREAM_CHUNK` / `OPENCODE_STREAM_DELAY_MS` | ｜ | 打字机节奏（默认开，8 字符 / 45ms；`SMOOTHING=false` 直出） |
| `PORT` | ｜ | 仅本地 shim 用（`npm run api:dev`，默认 8787）；Vercel 上不需要 |
```

3. **本地跑**：

```bash
bun install
PROXY_API_KEY=test npm run api:dev     # 或 node --experimental-strip-types api/local.mjs

OPENCODE_API_KEY=<Zen key> npm run api:test   # 黑盒 D1–D10（自起服务）
```

4. **部署到 Vercel（GitHub 集成，两步）**：
   - dash.vercel.com → Add New… → Project → Import `fskanokano/opencode-scw` → Framework Preset 选 **Other** → Deploy（Vercel 读 `vercel.json`；Install/Build 留默认）
   - Project → Settings → Environment Variables 添加 `PROXY_API_KEY` 与 `OPENCODE_API_KEY` → 最新 Deployment **Redeploy**
   - 此后 push 到 main 自动部署
5. **平台限制（如实声明）**（spec §1.6/§6）：

```markdown
- **执行时长**：Hobby 单次请求硬上限 300s，超时返回 504；长 agent 任务会被切断，
  客户端重发完整历史即可续聊（会话锚定）。升级 Pro 可放宽到 800s（改 vercel.json 一处）。
- **WebSocket**：Vercel Functions 不支持 upgrade，`/pty` 终端在 Vercel 路径不可用
  （需要 pty 用 Node 常驻形态）。
- **请求体**：上限 4.5MB（大图片 file parts 受限，超出返回 413）。
- **内存**：Hobby 固定 2GB（对比 Deno Deploy 768MiB——本次迁移的动机，引擎实测
  RSS 峰值 ~720MB 在 2GB 下余量充足，应用层熔断看门狗已随 Deno 路径移除）。
```

6. **内存与状态语义**（沿用原章节口径，改写 Deno 字样）：

```markdown
- 单进程单运行时。opencode 引擎自身 RSS（数百 MB 级）是内存大头，进程内方案省掉的是
  第二份运行时 + 子进程管理开销，不是 opencode 本身的占用。
- Vercel 实例回收后，内存态 `sessions` Map 与引擎 SQLite 随实例消亡；会话锚定靠客户端
  重发完整历史即可续聊。多实例完全隔离，无跨实例共享状态。
```

7. **升级 opencode 上游**（沿用原文，去 deno 冒烟口径）：

```bash
OPENCODE_VERSION=v1.19.x bun run vendor   # 重跑流水线：下载→校验→构建→node 冒烟
```

- [ ] **Step 3: 同步 env.example 与项目结构清单**

1. README「项目结构」段更新：

```markdown
api/index.ts            # Vercel 进程内形态入口（fetch export 壳 + handler 核心）
api/engine.ts           # 进程内 opencode 引擎适配器（app.fetch 直调）
api/stream.ts           # Web Streams 版 SSE 写器/解析器
api/local.mjs           # 本地 shim（node:http ↔ Web Request，仅本地/测试用）
vercel.json             # Vercel 函数配置（maxDuration 300 / includeFiles vendor/dist）
scripts/test-api.mjs    # Vercel 形态黑盒测试 D1–D10（自起 api/local.mjs）
```

（保留 `handler.js` / `src/*` / `scripts/build.sh` 等既有条目；删除 `deno/*` 与两个 deno 测试条目。）

2. `env.example`：把 Deno 字样改为 Vercel 口径（PORT 说明加「仅本地 shim 用」），变量集合不变。

- [ ] **Step 4: 链接与命令自检**

```bash
grep -n "npm run api:test\|api/local.mjs\|vercel.json" README.md | head -5
grep -rn "deno task\|Deno Deploy" README.md || echo "README 无 deno 活性引用"
```

预期：第一条命中新命令；第二条无输出（或仅历史对照语境）。

- [ ] **Step 5: Commit**

```bash
git add README.md env.example
git commit -m "docs: replace deno deploy guide with vercel github-integration guide"
```

---

### Task 7: 终验 —— 全量测试 + Vercel 就绪检查

**Files:**
- 无新文件；本任务是验收关卡

**Interfaces:**
- Consumes: Task 1–6 全部产物
- Produces: 验收标准全绿的证据（spec §11）

- [ ] **Step 1: 全量测试矩阵**

```bash
PROXY_API_KEY=test node scripts/test-api.mjs 2>&1 | tail -4   # 预期 10/10 passed（有 OPENCODE_API_KEY 环境）
node scripts/smoke-test.mjs 2>&1 | tail -2                    # 预期 5/5 checks passed
node scripts/test-bridge.mjs 2>&1 | tail -3                   # 预期 21 passed, 0 failed
```

- [ ] **Step 2: Deno 残留终扫**

```bash
test ! -d deno && test ! -f deno.json && test ! -f scripts/test-deno.mjs && test ! -f scripts/test-multiturn.mjs && echo "DENO CLEAN"
git ls-files | grep -i deno || echo "git 无 deno 跟踪文件"
```

预期两行均为干净输出（`DENO CLEAN` / `git 无 deno 跟踪文件`）。

- [ ] **Step 3: 部署就绪检查（不花构建）**

人工核对清单（推给用户前自查）：
- `vercel.json` 存在且 `functions."api/index.ts".includeFiles == "vendor/dist/**"`、`maxDuration == 300`
- `package.json` `engines.node == "24.x"`
- `api/index.ts` 尾部有 `export default { fetch }` 与 `void ensureEngine()` 预热
- README 部署章节含「Import Repository / Framework Preset: Other / 环境变量两个 / Redeploy」四要素

- [ ] **Step 4: 交付说明（告知用户线上两步）**

在会话里告知用户：代码已就绪，等 Changes 面板提交推送后，用户需要：
1. dash.vercel.com → Import `fskanokano/opencode-scw`（Framework Preset: **Other**）→ Deploy
2. Settings → Environment Variables 加 `PROXY_API_KEY`、`OPENCODE_API_KEY` → Redeploy
3. 线上验收命令（README 同款 curl）

- [ ] **Step 5: 最终 Commit（如有收尾修正）**

```bash
git add -A
git commit -m "chore: vercel migration final checks"
```

---

## Self-Review（writing-plans 技能要求）

1. **Spec 覆盖**：spec §3 文件清单 → Task 1（api/stream+engine）、Task 2（api/index+local）、Task 3（test-api）、Task 4（vercel.json+package.json）、Task 5（删除）、Task 6（README+env.example）逐一映射 ✓；spec §5 路由/鉴权 → Task 2 Step 1 逐函数移植清单 ✓；spec §8 测试策略 → Task 3 + Task 5 Step 2 回归关卡 + Task 7 终验 ✓；spec §9 部署步骤 → Task 4 配置 + Task 7 Step 4 交付说明 ✓；spec §11 验收标准 1–3 → Task 7，4–5（线上项）→ Task 7 Step 4 交由用户执行 ✓
2. **占位符扫描**：无 TBD/TODO/「类似 Task N」；每个代码步都给了实际代码或精确的移植底本+修改点枚举 ✓
3. **类型一致性**：`handler(req: Request): Promise<Response>` 在 Task 2 定义、Task 3（经 shim）与 Task 7 消费同名；`engineFetch/ensureEngine/engineReady/memorySnapshot/bootUptimeSec/SSE_HEADERS/createSseWriter/sseLines` 在 Task 1 Produces 与 Task 2 Consumes 逐名一致 ✓
4. **顺序依赖**：Task 5 删除以 Task 3 替代品就位为前置守卫（Step 1 有 test 守卫）；Task 1→2→3 依赖链单向 ✓
