# opencode 进程内嵌入 + Deno Deploy 方案 —— 设计文档

**日期**: 2026-09-02
**分支**: dev
**状态**: 三节设计已获用户逐节确认（架构 / vendor 与数据流 / 路由与风险）
**目标**: 放弃 Scaleway Function，全面转向 Deno 方案——把 opencode 源码以最小魔改
引入本仓库，进程内跟随 Deno Deploy 实例启动（不单独 spawn 子进程），完全流式，
单运行时省内存；GitHub 连接仓库推送即部署；兼容现有全部开发逻辑。

---

## 0. 已核实的关键事实（设计依据）

| # | 事实 | 核实方式 |
|---|---|---|
| F1 | opencode v1.18.25 的 server 本体已是 Node 兼容实现：`packages/opencode/src/server/server.ts` 用 `node:http` `createServer` + `@effect/platform-node`；官方为 Electron 桌面版进程内嵌入完成了去 Bun 化（"no longer using any bun specific apis"，thdxr 2026-04/06；dev.to 官方博客） | 上游源码直接核实 + 官方博客 |
| F2 | opencode 的运行时切换点是 Node 标准条件导入：`packages/core/package.json` 的 `imports` 字段定义 `#sqlite`/`#pty`/`#fff` 三组 `bun`/`node` 双实现（`bun:sqlite` vs `node:sqlite` 等），默认落 bun 变体 | 上游源码直接核实 |
| F3 | `node:sqlite` 自 Deno 2.2 起原生支持；Deno `Deno.serve` 原生支持 `Response(ReadableStream)` 流式（官方 SSE/streaming 示例） | Deno 官方文档 |
| F4 | Deno Deploy 新运行时 = 隔离 Linux 环境中的标准 Deno 2.5 + `--allow-all`：支持文件系统读写、spawn 子进程、FFI 与 node native addons；空闲 5s~10min 休眠，冷启动 100ms~几百 ms；GitHub 连接仓库推送即部署是标准流程；多实例完全隔离 | docs.deno.com/deploy/reference/runtime |
| F5 | `@opencode-ai/sdk@1.18.25` 的 `createOpencodeServer` 只会 spawn 子进程，无进程内入口；npm 包 `opencode-ai` 只发编译二进制——**进程内接入必须源码自建** | 本地 node_modules 核实 |
| F6 | server.ts 暴露 `Default = lazy(() => ({ app }))`，`app.fetch(request)` 是 Web 标准签名（Request→Response），进程内调用零套接字；`Server.listen()` 只是 `app.fetch` 的 node:http 套壳 | 上游源码直接核实 |
| F7 | Scaleway Serverless Function 只支持五种固定托管运行时（Node/Python/Go/PHP/Rust），无 Deno；Function 的 `handle(event)` 事件模型无法真流式（本仓库 `streamChat` 仅常驻形态可用的根因）——这是放弃 Function 的依据 | Scaleway 官方文档 |

## 1. 需求与约束（用户口径）

1. **不单独启动进程**：opencode 必须进程内跟随平台实例启动（杜绝双运行时双份内存）。
2. **完全流式**：OpenAI SSE 与 opencode 原生 SSE 端到端逐帧直通。
3. **兼容现有开发逻辑**：Node 常驻形态（`node handler.js`）原样保留，OpenAI 翻译层语义
   （会话锚定 / variant 映射 / reasoning_content / 复读裁剪 / usage 透传）逐函数复用。
4. **部署目标**：Deno Deploy，连接本 GitHub 仓库，推送即部署。
5. **最小魔改**：上游源文件逻辑零改动，所有魔改 = 新增文件 + 解析条件切换 + ≤5 个微补丁。
6. **省内存**：单进程单运行时；如实声明 opencode 自身 RSS（数百 MB 级）是内存大头，
   进程内省掉的是第二份运行时与子进程管理开销。

## 2. 架构总览

```
GitHub 仓库（dev 分支）
   │ git push → Deno Deploy GitHub 集成自动构建部署
   ▼
┌─ Deno Deploy 实例（标准 Deno 运行时，--allow-all）─────────────┐
│  deno/main.ts —— 唯一新入口                                      │
│    Deno.serve(async (req) => {                                  │
│      ├─ OPTIONS          → 204 + CORS                           │
│      ├─ checkAuth        → 复用 src/proxy.js 的 checkAuth        │
│      ├─ /v1/health       → 200（含引擎就绪状态）                 │
│      ├─ /v1/models       → 进程内 /config/providers → OpenAI list│
│      ├─ /v1/chat/*       → 翻译层（复用现有纯函数）+ 真流式       │
│      └─ 其余路径          → engine.fetch(req) 原样透传            │
│    })                                                            │
│  deno/engine.ts —— 进程内 opencode 引擎适配器                     │
│    import { app } from "../vendor/dist/opencode-server.mjs"      │
│    fetch(path, init) ≡ app.fetch(new Request("http://internal"+path, init))│
│    ensureEngine() = Promise 单例（模式同现有 ensureRuntime）      │
│  deno/stream.ts —— TransformStream 版 SSE 写器                   │
│    sseLines（现有纯 Web Streams 实现）原样复用                    │
│  vendor/dist/opencode-server.mjs —— 预编译 bundle（提交进仓库）   │
└───────────────────────────────────────────────────────────────────┘
```

**组件边界与改动面**：

| 组件 | 动作 | 说明 |
|---|---|---|
| `vendor/` + `scripts/vendor-opencode.mjs` | 新增 | 下载上游 tarball（锁版本+SHA256）→ 应用 `vendor/patches/*.patch` → `bun build --conditions=node --target=node` → 产物 `vendor/dist/opencode-server.mjs` 提交进仓库。上游源码本身不进仓库 |
| `deno/main.ts` / `deno/engine.ts` / `deno/stream.ts` | 新增 | Deno 入口、进程内引擎适配器、TransformStream 版 SSE 写器 |
| `src/proxy.js` / `src/bridge.js` / `src/zen-models.js` / `handler.js` | **不动** | Node 常驻形态原样保留；纯函数逻辑被 Deno 侧直接 import 复用 |
| `src/opencode.js` 的角色 | 分裂 | Deno 侧等价物是 `deno/engine.ts`：`serverFetch()` → 进程内 `app.fetch()`；`getServerUrl()` 不再需要；内部 Basic 双门机制在 Deno 路径取消（外部摸不到 `app.fetch`） |

## 3. Vendor 流水线与魔改清单

### 3.1 流水线（`scripts/vendor-opencode.mjs`）

```
bun scripts/vendor-opencode.mjs
  1. 下载上游 tarball（OPENCODE_VERSION=v1.18.25，SHA256 记录进 vendor/MANIFEST.json，不匹配即失败）
  2. 解包到临时目录 → 应用 vendor/patches/*.patch
  3. bun install（workspaces）→ bun build --conditions=node --target=node
     入口 = vendor/src/entry.ts → 产物 vendor/dist/opencode-server.mjs
  4. 冒烟校验：node 加载 bundle → app.fetch(GET /doc) 200；
     deno 加载同 bundle → 同断言；两者通过才允许提交产物
```

### 3.2 魔改清单

| # | 对象 | 内容 | 规模 |
|---|---|---|---|
| 1 | 条件导入解析 | build 传 `--conditions=node` 使 `#sqlite`/`#pty`/`#fff` 落 node 变体；若构建器不支持该 flag，退化为 1 行补丁改 `packages/core/package.json` imports default | 0~1 行补丁 |
| 2 | `vendor/src/entry.ts`（自建） | `import { Default } from 上游 server.ts` → 取出 `app`（`Default` 是上游 `lazy()` 包装，访问器签名以当日源码为准，entry 统一 re-export 一次，其余代码只 import entry）→ `export const app`；`export async function init(opts)` 做 auth.json 写入 / XDG 目录准备（对齐现有 `ensureRuntime` 凭据逻辑） | ~30 行 |
| 3 | 环境前置 | `OPENCODE_DISABLE_AUTOUPDATE` / `NO_COLOR` / `XDG_DATA_HOME` 在 Deno 入口 import bundle 前设置 | 入口内 |

上游源文件逻辑改动为 **零**。升级 opencode = 重跑流水线 + 补丁重放（预期无冲突）。

## 4. 数据流

**冷启动**：
```
首请求 → Deno.serve 回调 → ensureEngine()（Promise 单例）
  → 动态 import bundle（effect runtime 初始化）→ app.fetch 就绪 → 处理请求
后续请求直接命中已初始化实例
```

**流式请求**（`POST /v1/chat/completions` + `stream:true`）：
```
客户端 ──SSE──▶ Deno.serve
   │ 翻译层复用 extractUserPrompt/mapVariant/sessionKeyFor/stripEcho
   │ 进程内 app.fetch(GET /event)  ← ReadableStream 直出
   │ 进程内 app.fetch(POST /session/:id/message)
   │ 订阅 message.part.delta / message.part.updated / permission.asked
   │ sseLines（纯 Web Streams）原样复用；SseWriter → TransformStream 版
   ▼
OpenAI SSE 帧 ──逐帧──▶ 客户端（端到端无缓冲层）
```

**内存与状态语义**（如实声明）：
- 单进程单运行时；opencode 自身 RSS 是内存大头，进程内省掉第二份运行时 + 子进程开销。
- Deno Deploy 空闲休眠后，会话内存 Map 与 SQLite 随实例消亡（与 Scaleway 冷启动语义一致，
  现有 `sessions` Map 本就是内存态）。
- 多实例完全隔离，无跨实例共享状态；单实例即可满足当前流量。

## 5. 路由与鉴权（Deno 路径单门制）

```
Deno.serve(handler):
  OPTIONS *                  → 204 + CORS（不鉴权）
  鉴权检查（除 OPTIONS 外）   → checkAuth(headers)（复用 src/proxy.js）
       fail closed：PROXY_API_KEY 未配置 → 401
  GET  /v1/health            → 200（含引擎就绪状态）
  GET  /v1/models            → 进程内 /config/providers → OpenAI list；失败回退静态 ZEN_MODELS
  POST /v1/chat/completions  → stream:true → deno/stream.ts 真流式
                                否则 → 翻译层一次成帧返回
  其余一切路径                → engine.fetch(req) 原样透传（状态码/头/body 零加工）
  兜底                        → 未捕获异常 → 502 OpenAI 风格 {error:{message,type}}
```

- **单门制**：Deno 路径只有 `PROXY_API_KEY` 一道门（进程内 `app.fetch` 外部不可达）；
  Node 常驻形态保持现有双门不变。
- **CORS**：沿用 `src/bridge.js` 的 CORS 常量值。
- 透传响应头：剥 hop-by-hop / `content-encoding`（沿用现有 `responseHeaders` 规则），补 CORS。

## 6. 错误处理对照表

| 场景 | Deno 路径行为 | 与 Node 路径一致性 |
|---|---|---|
| 鉴权失败 | 401 + `WWW-Authenticate`（仅透传路径带） | 同 `bridge.unauthorized` |
| 引擎初始化失败 | 502 `upstream_error` + message 含原因 | 同 `handleRequest` 502 语义 |
| opencode 业务错误 | 原样透传 | 同 bridge 透传 |
| 客户端断连 | `req.signal` → abort 上游读取 | 同 `res.on("close")` |
| 会话失效 | 重试一次全新会话（`sessions` Map 复用） | 同 `handleChat` 重试 |

## 7. 风险清单与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | Deno 跑不通 bundle（npm 兼容缝隙、node:sqlite 差异、effect 兼容性） | **高·前置** | Phase 0 spike 硬门（§8）：失败则回退方案 B（Deno spawn 官方二进制）或重新评估，决策留痕本 spec |
| 2 | bundle 体积与部署限制 | 中 | spike 实测；`--minify` + 排除 dev 依赖；Deno Deploy 无 Function 式 100MB 硬上限 |
| 3 | 上游升级破坏补丁 | 中 | 补丁 ≤5 个且全为解析级小改；vendor 脚本锁版本可复现 |
| 4 | Deno Deploy 实例驱逐中断长请求 | 中 | 与 Scaleway 冷启动同级风险；客户端重连 + 会话锚定天然支持；文档声明 |
| 5 | opencode agent 需要写文件系统 | 低 | Deno Deploy 新运行时支持 fs 写；数据目录指向实例本地盘（临时语义与现状一致） |

## 8. Phase 0 spike（先于一切正式代码，验收即门）

```
spike 范围（一次性验证，产物丢弃或收编，不算正式实现）：
  1. bun build --target=node --conditions=node 出 bundle
  2. node 加载 bundle → app.fetch(GET /doc) 200
  3. deno run 加载同 bundle → 同断言
  4. deno run 下 POST /session + /event SSE 首帧（无 API key 允许 502，验证链路通）
验收：
  ①②③④ 全过 → 方案 A 落地，本 spec 转正式
  ② 或 ④ 失败 → 记录失败点，评估微补丁能否救；救不动 → 回退方案 B 并更新本 spec
```

### §8.1 验收记录（2026-09-02，spike 已执行）

**结论：①②③④ 全部通过 → 方案 A 落地。**

| # | 硬门 | 结果 | 说明 |
|---|---|---|---|
| ① | bun build 出 bundle | ✅ | 3246 模块 / ~0.9s / 14.0MB + 4 wasm 资源（`Bun.build` target=node conditions=node minify） |
| ② | node 加载 → app.fetch(GET /doc) 200 | ✅ | `scripts/vendor-smoke.mjs` 4/4；进程内零套接字 |
| ③ | deno 加载同 bundle | ✅ | 同脚本 deno 2.9.6 `--allow-all` 4/4 |
| ④ | 链路通 | ✅ | 超预期：`POST /session` 直接 200（opencode server 进程内完整初始化，无需 LLM key）；`GET /event` SSE 响应到达 |

**情报收集核实（对 §0 事实表）**：
- F6 ✅ 实测：`Default = lazy(() => ({ app }))`，`Default()` → `{ app }`；`app.fetch(Request)` 纯 Web 签名
- F2 ✅ 实测：core `#sqlite`/`#pty`/`#fff` + opencode `#db` 四组条件导入齐备；`--conditions=node` 下自动落 node 变体
- `bun:*` 残留：仅 2 处 type-only import（编译期消失）；`bun:sqlite`/`bun-pty` 全部隔离在 `.bun.ts` 变体文件

**唯一构建期修正（0 文件补丁）**：`jsonc-parser` 的 UMD 构建（`factory(require, exports)` 模式）bun 打包后留下运行时相对 `require("./impl/format")`，bundle 加载即崩。解法：`Bun.build` 插件把它重定向到包内自带 ESM 构建（`lib/esm/main.js`），纯静态 import 内联成功。不占 ≤5 补丁预算（补丁数保持 0）。

**产物与留痕**：`vendor/dist/opencode-server.mjs` + `vendor/MANIFEST.json`（版本/SHA256/补丁清单/冒烟记录）；流水线脚本 `scripts/vendor-opencode.mjs`（可重复构建），冒烟脚本 `scripts/vendor-smoke.mjs`。

## 9. 测试策略（TDD）

- Deno 侧新增 `scripts/test-deno.mjs`（黑盒）：鉴权 / health / models / 流式首帧 / 透传 404 / 错误结构。
- Node 侧现有 `scripts/smoke-test.mjs` + `scripts/test-bridge.mjs` 全绿 = 固定回归关卡。
- vendor 冒烟（Node + Deno 双加载）内置于 vendor 脚本，产物未过校验不得提交。

## 10. 明确不做（YAGNI）

- 不做 Deno Deploy 之外的平台适配（Vercel/CF Workers 等）。
- 不做跨实例会话持久化（实例内存态已满足当前流量；后续需要时落 KV 一档）。
- 不移植 opencode web UI 静态资源的缓存策略（透传即可）。
- 不改 Node 常驻形态任何行为（现有测试为回归关卡）。
- 不做多账号 / 限额轮换（红线，与 freebuff-serve-fork spec §7 同口径）。

## 11. 验收标准

1. Phase 0 spike 四项全过（§8）。
2. `deno/task`（`deno run --allow-all deno/main.ts`）本地启动：`test-deno.mjs` 全绿。
3. `stream=true` 请求看到逐帧 SSE 与最终 usage；多轮续聊上下文延续。
4. `node scripts/smoke-test.mjs` 5/5 + `node scripts/test-bridge.mjs` 21/21（Node 路径零回归）。
5. Deno Deploy 连接 GitHub 仓库后：push 到 dev → 自动部署 → 线上 `/v1/health` 200 →
   线上流式冒烟通过。
