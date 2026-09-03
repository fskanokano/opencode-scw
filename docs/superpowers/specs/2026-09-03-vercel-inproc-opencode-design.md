# opencode 进程内嵌入 + Vercel 方案 —— 设计文档

**日期**: 2026-09-03
**分支**: main
**状态**: 三节设计已获用户逐节确认（架构 / 文件改动与数据流 / 路由与部署）
**目标**: Deno Deploy 768MiB 内存上限导致 OOM（实测引擎 RSS 峰值 ~720MB，看门狗
熔断频繁触发）。把 serverless 部署目标从 Deno Deploy 换成 Vercel（Hobby 固定
2GB 内存），入口从 `deno/` 三件套替换为 `api/` 三件套（Node.js 24.x runtime，
fluid compute），进程内引擎、OpenAI 翻译层、真流式语义全部原样保留；
**Deno 路径完全删除**（用户确认），Node 常驻形态（`node handler.js`）不动。

**前置决策（用户已确认）**:
1. Deno 路径**完全替换**（删除 `deno/`、`deno.json` 的 deploy 配置、Deno 侧测试脚本）
2. 部署方式：**Vercel GitHub 集成**（后台连接仓库 push 即部署，不用 Actions/CLI）
3. 套餐：**Hobby**（2GB / 1vCPU / maxDuration 300s 硬上限，按最保守配置）

---

## 0. 已核实的关键事实（设计依据）

| # | 事实 | 核实方式 |
|---|---|---|
| V1 | Vercel Functions（fluid compute）内存：**Hobby 固定 2GB / 1 vCPU**（不可调也不可降），Pro/Ent 默认 2GB 可调 4GB/2vCPU | vercel.com/docs/functions/limitations（2026-08 更新） |
| V2 | maxDuration：Hobby 默认与**硬上限均 300s**；Pro 800s（1800s beta）。时长含流式响应全程；超时返回 504 FUNCTION_INVOCATION_TIMEOUT | 同上 |
| V3 | 函数包体上限 250MB 未压缩（含 includeFiles 拖入的文件）；支持 `includeFiles` 配置把额外文件打进函数包 | 同上 |
| V4 | Node.js 版本：24.x（默认）/ 22.x / 20.x；`package.json` 的 `engines.node: "24.x"` 可固定 | vercel.com/docs/functions/runtimes/node-js/node-js-versions |
| V5 | 入口形态：`/api` 下 fetch Web 标准 export（`export default { fetch(request) }`）即 Vercel Function；也支持 Node.js server 入口（server.listen 检测）。本方案用 fetch export（更贴近现有 handler 结构，无内部端口层） | vercel.com/docs/functions/runtimes/node-js |
| V6 | 客户端断连：fluid compute 支持 per-path request cancellation，`request.signal` 会 abort | vercel.com/changelog（Node.js Functions per-path request cancellation） |
| V7 | WebSocket upgrade 在 Vercel Functions **不支持**（Deno Deploy 支持）→ `/pty` 终端交互在 Vercel 路径明确不可用，透传层遇 upgrade 请求返回明确错误 | vercel.com/docs/functions/limitations + 既有 bridge.js 实测认知 |
| V8 | 请求体上限 4.5MB（超出 413 FUNCTION_PAYLOAD_TOO_LARGE）→ 大图片 file parts 受限，文档声明 | vercel.com/docs/functions/limitations |
| V9 | bundle 本身就是 `target=node --conditions=node` 构建的（MANIFEST: bun 1.3.14），vendor 冒烟已含 node 加载 4/4 → Node 24.x runtime 直接可加载；`node:sqlite` 在 Node 22.5+/24 稳定 | vendor/MANIFEST.json + scripts/vendor-smoke.mjs 记录 + Node 官方文档 |
| V10 | Vercel GitHub 集成：后台 Import Repository → push 生产分支自动部署；环境变量在 Project → Settings → Environment Variables 配置 | Vercel 标准流程（用户已选该方式） |
| V11 | fluid compute 实例在请求间保活（分钟级），模块级单例与后台预热跨请求存活——进程内引擎预热情景成立 | vercel.com/docs/fluid-compute |
| V12 | 本仓库现状：`deno/main.ts`（571 行，路由/鉴权/翻译层/流式）+ `deno/engine.ts`（180 行，进程内 app.fetch 适配器 + Deno 专属内存监控）+ `deno/stream.ts`（177 行，纯 Web Streams SSE 写器）；翻译层纯函数复用自 `src/proxy.js`/`src/opencode.js`/`src/zen-models.js`（CJS） | 本仓库源码（origin/main 65f1b74） |

## 1. 需求与约束（用户口径）

1. **解决 OOM**：Deno Deploy 768MiB 不够，Vercel Hobby 2GB 固定内存直接消除该问题。
2. **完全替换 Deno 路径**：`deno/` 三件套、`deno.json` deploy 配置、Deno 侧测试全部删除；
   不保留双路径。
3. **零回归**：Node 常驻形态（`node handler.js`）与 `vendor/dist/opencode-server.mjs`
   bundle 完全不动；OpenAI 翻译层语义（会话锚定 / variant 映射 / reasoning_content /
   复读裁剪 / usage 透传 / 自动放行）逐函数保留。
4. **部署**：Vercel GitHub 集成，push 即部署；环境变量 `PROXY_API_KEY` + `OPENCODE_API_KEY`。
5. **Hobby 口径**：maxDuration 300s；升级 Pro 后仅需改 `vercel.json` 一个数字。
6. **如实声明限制**：300s 时长上限、WebSocket 不支持（/pty 不可用）、4.5MB 请求体、
   实例回收即会话内存消亡。

## 2. 架构总览

```
GitHub 仓库（main 分支）
   │ git push → Vercel GitHub 集成自动构建部署
   ▼
┌─ Vercel Function（Node.js 24.x runtime，fluid compute，2GB）────┐
│  api/index.ts —— 唯一新入口（fetch Web 标准 export）             │
│    ├─ OPTIONS          → 204 + CORS                             │
│    ├─ checkAuth        → Bearer PROXY_API_KEY（单门制，fail closed）│
│    ├─ /v1/health       → 200（引擎就绪 + process.memoryUsage）  │
│    ├─ /v1/models       → 进程内 /config/providers → OpenAI list │
│    ├─ /v1/chat/*       → 翻译层复用 + 真流式（SSE 逐帧）         │
│    └─ 其余路径          → engineFetch 原样透传                   │
│  api/engine.ts —— 进程内 opencode 引擎适配器                     │
│    （deno/engine.ts 去 Deno 化移植：app.fetch 直调、              │
│      Promise 单例、OPENCODE_DISABLE_* 内存压榨、                  │
│      process.memoryUsage() 内存快照；删除 Deno.exit 熔断看门狗    │
│      —— 2GB 上限下熔断无意义，实例回收交给平台）                  │
│  api/stream.ts —— SSE 写器/解析器                                │
│    （deno/stream.ts 原样移植：纯 Web Streams，零 Deno API）       │
│  api/local.mjs —— 本地 shim（node:http ↔ Web Request 桥接）      │
│  scripts/test-api.mjs —— 黑盒 D1–D10（boot 目标 = local shim）   │
│  vendor/dist/opencode-server.mjs —— 复用现有 bundle（14MB）      │
│  vercel.json —— maxDuration 300 + includeFiles vendor/dist/**    │
└───────────────────────────────────────────────────────────────────┘
```

**入口分层**：`handler(req: Request): Promise<Response>` 是框架无关核心
（api/index.ts 只是 Vercel fetch-export 壳）；本地测试 shim（api/local.mjs）
与线上走同一 handler，测试结论可信。

**与 Deno 方案对比**：

| | Deno Deploy（旧） | Vercel（新） |
|---|---|---|
| 内存上限 | 768MiB（OOM 重灾区，720MB 熔断看门狗） | **2GB 固定**（余量充足，无看门狗） |
| 执行时长 | 无硬上限（但 OOM 暴杀） | 300s 硬上限（Hobby），504 后靠会话锚定续跑 |
| WebSocket | 支持 | ❌ 不支持（/pty 不可用，明确报错） |
| 请求体 | — | 4.5MB 上限 |
| 实例保活 | 空闲 5s~10min 休眠 | fluid compute 请求间保活（分钟级） |
| 运行时 | Deno 2.5 | Node.js 24.x |

## 3. 文件改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `api/index.ts` | 新增 | Vercel 入口：`export const config`（如有需要）+ `export default { fetch }` → 调 `handler()`；路由/鉴权/翻译层 = `deno/main.ts` 逐函数移植（去 `createRequire` 的 Deno 兼容写法，直接 Node `createRequire`） |
| `api/engine.ts` | 新增 | `deno/engine.ts` 移植：`prepareEnv()`（凭据/XDG/OPENCODE_DISABLE_* 压榨）原样；`ensureEngine()` Promise 单例原样；`memorySnapshot()` 改 `process.memoryUsage()`（rss/heapUsed/heapTotal/external/buffers 全有）；**删除** `startMemoryMonitor()`/`Deno.exit` 熔断与 `bootUptimeSec` 的 Deno 依赖（保留 uptime 语义） |
| `api/stream.ts` | 新增 | `deno/stream.ts` 原样拷贝（纯 Web Streams：ReadableStream/TextEncoder/setTimeout，Node 24 原生支持，零改动） |
| `api/local.mjs` | 新增 | 本地 shim：`node:http` server → 收集 body → 构造 Web `Request` → `handler(req)` → 把 `Response` 状态/头/body 回写 `res`（body 流式 pipe）；`PORT` 环境变量，默认 8787；**仅本地/测试用，不参与部署** |
| `scripts/test-api.mjs` | 新增 | `test-deno.mjs` 断言清单迁移（D1–D10：鉴权/预检/health/models/非流式/流式首帧/透传/错误结构/usage）；boot 从 `deno run` 改为 `node api/local.mjs` |
| `vercel.json` | 新增 | `{ "functions": { "api/index.ts": { "maxDuration": 300, "includeFiles": "vendor/dist/**" } } }` |
| `package.json` | 小改 | `engines.node: "24.x"`；scripts 增加 `"api:dev": "node api/local.mjs"`、`"api:test": "node scripts/test-api.mjs"`；删除 deno 相关 task 引用 |
| `deno/`（3 文件）、`deno.json`、`scripts/test-deno.mjs`、`scripts/test-multiturn.mjs` | **删除** | Deno 路径完全替换（用户确认） |
| `README.md` | 改 | Deno 章节替换为 Vercel 章节：架构图、env 表、GitHub 集成连接步骤、限制声明（300s/WS/4.5MB）、本地与线上验收命令 |
| `env.example` | 改 | 删除 Deno 专属说明口径，补 Vercel 语义（PORT 仅本地 shim 用） |
| `src/proxy.js`、`src/bridge.js`、`src/zen-models.js`、`src/opencode.js`、`handler.js`、`vendor/` | **不动** | Node 常驻形态与 bundle 原样；纯函数继续被 api 侧 `createRequire` 复用 |

**魔改预算**：上游 bundle 零补丁（复用现有产物）；本仓库侧全部为新增文件 + 删除 +
两处小改（package.json / README / env.example）。

## 4. 数据流

**冷启动与预热**（对齐 Deno 方案的后台预热经验）：

```
实例拉起 → api/index.ts 模块加载 → void ensureEngine()（后台预热，不阻塞）
首请求 → fetch(request) → ensureEngine()（Promise 单例；预热未完则同 Promise 等待）
       → app.fetch 处理 → 响应
fluid compute 实例请求间保活（分钟级）→ 后续请求直接命中就绪引擎
```

（bundle import + effect runtime 首建 30–48s 的实测数据沿用；预热在实例拉起即开始，
首请求大概率命中就绪引擎；若遇新建实例 + 未预热完成，请求等待单例完成初始化，
最多消耗一次 300s 预算内的等待。）

**流式请求**（`POST /v1/chat/completions` + `stream:true`，逐帧语义与 Deno 路径一致）：

```
客户端 ──SSE──▶ api/index.ts
   │ 复用 extractUserPrompt / mapVariant / sessionKeyFor / stripEcho（CJS require）
   │ engineFetch("/event") 订阅 + engineFetch(POST /session/:id/message)（进程内直调）
   │ 订阅 message.part.delta / message.part.updated / permission.asked 自动放行
   │ api/stream.ts 写器（role 帧 → reasoning_content/content 分片 → usage → stop → [DONE]）
   ▼
OpenAI SSE 帧逐帧直出（端到端无缓冲层，300s 内完成）
```

**断连与超时**：
- 客户端断连 → fluid per-path cancellation → `request.signal` abort 上游 message 请求
  （对齐 Deno 路径的 `clientGone` / Node 路径的 `res.on("close")` 语义）。
- 执行超 300s → 平台 504 FUNCTION_INVOCATION_TIMEOUT；会话锚定
  （`sessions` Map + 首条 user 消息哈希锚点）支持客户端重发完整历史续聊——
  与 Deno Deploy 休眠驱逐后的恢复方式相同，文档如实声明。

**内存与状态语义**（如实声明）：
- 单实例内存态 `sessions` Map + 引擎 SQLite；实例回收即消亡；多实例隔离。
- opencode 引擎 RSS（数百 MB 级）仍是内存大头；2GB 相对 768MiB 的余量是本次迁移
  的核心收益；不再需要应用层熔断。
- 引擎数据目录 `$TMPDIR/opencode-data`（对齐 Deno 路径的临时语义）。

## 5. 路由与鉴权（单门制，与 Deno 路径同语义）

```
fetch(request):
  OPTIONS *                  → 204 + CORS（不鉴权）
  checkAuth(headers)         → Bearer PROXY_API_KEY，fail closed（未配置 → 401）
  GET  /v1/health            → 200 {status, engine, memory{rss/heap/external/buffers, limitMB:2048}, uptimeSec}
  GET  /v1/models            → 进程内 /config/providers → OpenAI list；失败回退静态 ZEN_MODELS
  POST /v1/chat/completions  → stream:true → 真流式；否则 → 翻译层一次成帧返回
  其余一切路径                → engineFetch 原样透传（状态码/头/body 零加工；
                                剥 hop-by-hop / content-length / content-encoding / vary）
  兜底                        → 未捕获异常 → 502 OpenAI 风格 {error:{message,type}}
```

- **单门制**：进程内 `app.fetch` 外部不可达，只有 `PROXY_API_KEY` 一道门；
  无内部 Basic 双门（Node 常驻形态保持双门不变）。
- **CORS**：沿用 Deno 路径的 CORS 常量值（与 bridge.js 一致）。
- WebSocket：Vercel Functions 不支持 upgrade；`/pty` 系列在 Vercel 路径明确返回错误。

## 6. 错误处理对照表

| 场景 | Vercel 路径行为 | 与现有路径一致性 |
|---|---|---|
| 鉴权失败 | 401 + `WWW-Authenticate`（仅透传路径带） | 同 `bridge.unauthorized` / Deno 路径 |
| 引擎初始化失败 | 502 `upstream_error` + message 含原因 | 同 Deno/Node 路径 |
| opencode 业务错误 | 原样透传 | 同 bridge 透传 |
| 客户端断连 | `request.signal` → abort 上游 | 同 Deno `clientGone` / Node `res.on("close")` |
| 会话失效 | 重试一次全新会话（`sessions` Map 复用口径） | 同 `handleChat` 重试 |
| 执行超 300s | 平台 504；客户端重发历史续聊（会话锚定） | 新增限制（文档声明） |
| 请求体 > 4.5MB | 平台 413（大图片 file parts 受限） | 新增限制（文档声明） |
| WebSocket upgrade | 明确错误（平台不支持） | Deno 路径可用，Vercel 路径声明不支持 |

## 7. 风险清单与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | Node 24.x runtime 加载 bundle 出现 npm 兼容缝隙（vendor 冒烟是 node 22 验证的） | 低·前置 | 本地先用 `node api/local.mjs` 跑 D1–D10 全绿再推；若 24 有缝隙 → `engines.node: "22.x"` 一行回退（22.5+ 同样有稳定 node:sqlite） |
| 2 | Vercel 打包漏掉动态 import 的 bundle/wasm | 中·前置 | `includeFiles: "vendor/dist/**"` 显式声明；线上 `/v1/health` + `/v1/models` 首验 |
| 3 | 300s 上限切断长 agent 任务 | 中 | 如实文档声明；会话锚定支持续跑；升级 Pro 可放宽到 800s（只改 vercel.json） |
| 4 | 引擎冷启动 30–48s 占用首请求预算 | 中 | 模块加载即后台预热（沿用 Deno 方案实测经验）；fluid 保活使预热跨请求有效 |
| 5 | /pty（WebSocket）不可用造成功能回退 | 低 | Deno 路径的 /pty 依赖 TUI 场景本就少用；透传层对 upgrade 请求明确报错；真需要时走 Node 常驻形态 |
| 6 | `sessions` Map 在多实例/回收下丢失（与 Deno 同语义） | 低 | 客户端重发历史续聊（既有语义），文档声明 |

## 8. 测试策略（TDD）

- `scripts/test-api.mjs`（黑盒，自起 `node api/local.mjs`）：
  D1 无凭据 401 / D2 OPTIONS 204+CORS / D3 health 200 / D4 models 200 list /
  D5 非流式 OpenAI 结构 / D6 流式首帧+[DONE] / D7 透传 providers 非 502 /
  D8 透传未知路由非 502 / D9 错误结构 400 / D10 usage 帧。
  （断言清单 = `test-deno.mjs` D1–D10 平移，boot 目标更换。）
- Node 常驻形态回归关卡不动：`node scripts/smoke-test.mjs` 5/5 +
  `node scripts/test-bridge.mjs` 21/21。
- vendor 冒烟沿用（bundle 未变更，无需重跑；如跑则 node+deno 双加载口径改为
  node 单加载仍 4/4，deno 侧不再强制）。
- 线上验收：`/v1/health` 200 → 流式冒烟（逐帧 + [DONE]）→ 多轮续聊上下文延续。

## 9. 部署步骤（Vercel GitHub 集成，用户操作仅两步）

1. **[代码先行]** 本仓库合入 Vercel 方案（api/ 三件套 + vercel.json + 删除 deno/），
   `node scripts/test-api.mjs` 全绿后推送 main。
2. **[用户·一步]** dash.vercel.com → Add New… → Project → Import
   `fskanokano/opencode-scw` → Framework Preset 选 **Other** → Deploy。
   （Vercel 读 vercel.json；Install/Build 留默认即可——无前端构建产物，函数即服务。）
3. **[用户·一步]** Project → Settings → Environment Variables 添加
   `PROXY_API_KEY` 与 `OPENCODE_API_KEY` → Deployments 里最新一次 **Redeploy**。
4. 此后 push 到 main 自动部署；线上验收：

```bash
curl -s https://<project>.vercel.app/v1/health -H "Authorization: Bearer <PROXY_API_KEY>"
# → {"status":"ok","engine":"ready","memory":{...,"limitMB":2048},...}
curl -sN https://<project>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_API_KEY>" -H "content-type: application/json" \
  -d '{"model":"opencode/big-pickle","stream":true,"messages":[{"role":"user","content":"数到三"}]}'
```

## 10. 明确不做（YAGNI）

- 不保留 Deno 双路径（用户确认完全替换）。
- 不做 Pro 档位的 800s/4GB 预配置（Hobby 口径交付，升级只改 vercel.json 一处）。
- 不做跨实例会话持久化（内存态 + 客户端重发历史已满足；同 Deno 方案口径）。
- 不做 Vercel Edge Runtime 版本（bundle 依赖 node:sqlite 等 Node 内建，必须 Node runtime）。
- 不做多账号 / 限额轮换（红线，与既有 spec 同口径）。
- 不改 Node 常驻形态与 vendor bundle 任何行为（现有测试为回归关卡）。

## 11. 验收标准

1. `node scripts/test-api.mjs` D1–D10 全绿（本地 shim，Node 24 本地或 ≥22.5 均可跑）。
2. `node scripts/smoke-test.mjs` 5/5 + `node scripts/test-bridge.mjs` 21/21（零回归）。
3. 仓库内无 `deno/`、`deno.json`、Deno 侧测试残留；README/env.example 无 Deno 主路径口径。
4. Vercel GitHub 集成部署成功：线上 `/v1/health` 200（engine ready、memory.limitMB=2048）。
5. 线上流式冒烟：逐帧 SSE、[DONE] 收尾、include_usage 生效、多轮续聊上下文延续。
