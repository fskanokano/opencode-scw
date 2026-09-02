# Deno 进程内 opencode —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **v2（重写说明）**：v1 的 Task 0 之后因输出退化循环产生乱码与自我叙述残留，已整体重写。
> 重写忠实于已获用户逐节确认的 spec（`docs/superpowers/specs/2026-09-02-deno-inproc-opencode-design.md`），不引入新设计决策。

**Goal:** 把 opencode 源码最小魔改后进程内嵌入 Deno Deploy 入口（不单独 spawn 子进程），完全流式，兼容现有 Node 常驻形态全部逻辑。

**Architecture:** 新增 `scripts/vendor-opencode.mjs` 流水线（下载锁定版本上游 tarball → 应用 `vendor/patches/*.patch` → `bun build --conditions=node --target=node` → 双运行时冒烟）产出 `vendor/dist/opencode-server.mjs`（提交进仓库）；新增 `deno/` 目录（main.ts 入口 / engine.ts 进程内引擎适配器 / stream.ts TransformStream 版 SSE 写器），纯函数逻辑从 `src/*.js` 直接 import 复用；`src/*` 与 `handler.js` 零改动。

**Tech Stack:** Deno 2.9+（Deno.serve / TransformStream / node:sqlite）、Bun 1.3（构建工具链）、Node 22（现有形态与冒烟）。零新增 npm 依赖；构建期临时依赖仅进临时目录，不进 package.json。

**Spec:** `docs/superpowers/specs/2026-09-02-deno-inproc-opencode-design.md`

## Global Constraints

- 上游源文件逻辑改动为 **零**；所有魔改 = 新增文件 + 构建条件切换 + ≤5 个解析级微补丁（spec §3.2）
- tarball 锁定 `opencode v1.18.25` + SHA256 记录进 `vendor/MANIFEST.json`，不匹配即失败（spec §3.1）
- 上游源码不进仓库；`vendor/dist/opencode-server.mjs` 产物提交进仓库（spec §2）
- Deno 路径单门制：只有 `PROXY_API_KEY` 一道门，进程内 app.fetch 外部不可达（spec §5）
- 兼容现有开发逻辑：Node 常驻形态零改动，`scripts/smoke-test.mjs` 5/5 + `scripts/test-bridge.mjs` 21/21 是回归关卡（spec §9/§11.4）
- Deno 侧测试 `scripts/test-deno.mjs` 黑盒：鉴权 / health / models / 流式首帧 / 透传 404 / 错误结构（spec §9）
- 多账号/限额轮换是红线（spec §10）
- Deno Deploy 部署目标：连接 GitHub 仓库 dev 分支，推送即部署（spec §1.4）

## 预检查（计划前完成）

- [x] deno 2.9.6 已安装（`~/.deno/bin/deno`）
- [x] bun 1.3.14、node 22.23.1 就绪
- [x] node_modules 中 @opencode-ai/sdk 存在（对齐 v1.18.25）
- [x] @opencode-ai/sdk 的 createOpencodeServer 只会 spawn 子进程（spec F5）——进程内接入必须源码自建

---

## Task 0: Phase 0 spike —— 可行性硬门（先于一切正式代码）

**Files:**
- Create: `scripts/vendor-opencode.mjs`（spike 最小版：download/extract/patch/build/smoke）
- Create: `vendor/patches/*.patch`（spike 期由构建失败驱动生成，预算 ≤5）
- Create: `scripts/vendor-smoke.mjs`（Node + Deno 双运行时加载冒烟）
- Create: `vendor/MANIFEST.json`（版本 + SHA256 + spike 结论）

补丁机制（贯穿 Task 0）：**failure-driven**——每次构建失败 → 定位失败点 → 1 个解析级小补丁 → 重建，直到全绿；总预算 ≤5。spike 产物可收编或丢弃；不写 `deno/` 正式代码（spec §8）。

- [x] **Step 1: 下载 + 解包 + 情报收集（脚本化）**
  - 下载 opencode v1.18.25 上游 tarball（GitHub codeload tag），解包到临时目录
  - 收集情报：`packages/opencode/src/server/server.ts` 的 `Default`/`app` 出口形态；`packages/core/package.json` `imports` 字段（`#sqlite`/`#pty`/#fff 三组条件导入）；`packages/opencode/package.json` 依赖与 scripts；workspaces 结构；`bun:*`/`bun:sqlite`/`bun:ffi` specifier 全清单
  - 硬断言（F1/F2）：server.ts 存在且暴露 app；core imports 三组 `bun`/`node` 双实现齐备 → 情报收集 PASS

- [x] **Step 2: 自建 entry + 构建**
  - 写 `vendor/src/entry.ts`：从上游 server.ts 取出 `app`（`Default` 是 lazy 包装，访问器签名以当日源码为准）→ `export const app`；`export async function init(opts)` 做凭据/XDG 目录准备（对齐现有 `ensureRuntime` 逻辑）
  - `bun install`（workspaces）→ `bun build --conditions=node --target=node entry.ts` → `vendor/dist/opencode-server.mjs`
  - bun 不支持 `--conditions` 时退化为 1 行补丁改 `packages/core/package.json` imports default（计入 ≤5 预算）

- [x] **Step 3: 冒烟硬门（spike 四项）**
  - ① bun build 出 bundle
  - ② node 加载 bundle → `app.fetch(GET /doc)` → 200
  - ③ deno run 加载同一 bundle → 同断言
  - ④ 链路通：进程内 `POST /session`（无 LLM key 时 400/502 到达 HTTP 层即算通）+ `GET /event` SSE 首帧/响应到达
  - 验收：①②③④ 全过 → 方案 A 落地；② 或 ④ 失败 → 记录失败点，评估微补丁能否救；救不动 → 回退方案 B（Deno spawn 官方二进制）并更新 spec

- [x] **Step 4: spike 结论记录**
  - 结论（通过/失败 + 失败点 + 实际补丁清单）写进 `vendor/MANIFEST.json` 与 spec §8 验收记录

- [x] **Step 5: commit（vendor 脚本 + MANIFEST + 冒烟脚本 + spec 验收记录）**

---

## Task 1: vendor 流水线正式化

**Files:**
- Modify: `scripts/vendor-opencode.mjs`（从 spike 版转正：清理解包目录、锁定步骤、失败即退出非零）
- Create: `vendor/MANIFEST.json` 最终版（version / tarball SHA256 / patches 列表 / 构建命令 / 产物 SHA256）
- Create: `.gitignore` 增量（忽略 vendor 工作目录，保留 `vendor/dist/` 产物）

- [x] **Step 1: 参数化与锁版本**（OPENCODE_VERSION 常量 + 环境变量覆盖；SHA256 不匹配即 fail）
- [x] **Step 2: 幂等重建**（重复执行结果一致；patches 按 MANIFEST 列表顺序应用，`git apply --check` 预检）
- [x] **Step 3: 产物校验**（Node + Deno 双加载冒烟内置于脚本，未过校验不得写 `vendor/dist/`）
- [x] **Step 4: commit**

## Task 2: deno/ 入口三件套（TDD：先写 test-deno.mjs 失败断言）

**Files:**
- Create: `deno/main.ts` —— 唯一新入口：`Deno.serve(handler)`；OPTIONS → 204 + CORS；`checkAuth` 复用（Bearer 单门制，fail closed）；`/v1/health`；`/v1/models`（进程内 `/config/providers` → OpenAI list，失败回退静态 ZEN_MODELS）；`/v1/chat/completions`（翻译层复用 + 真流式）；其余路径 `engine.fetch(req)` 原样透传；兜底 502 OpenAI 风格错误
- Create: `deno/engine.ts` —— 进程内引擎适配器：动态 import `vendor/dist/opencode-server.mjs` → `fetch(path, init) ≡ app.fetch(new Request("http://internal"+path, init))`；`ensureEngine()` Promise 单例（模式同现有 `ensureRuntime`）；import 前设置 `OPENCODE_DISABLE_AUTOUPDATE`/`NO_COLOR`/`XDG_DATA_HOME`
- Create: `deno/stream.ts` —— TransformStream 版 SseWriter（对齐 `src/proxy.js` SseWriter 语义：role 帧 → reasoning_content/content 分片 → stop → [DONE] → usage）；`sseLines` 纯 Web Streams 解析器从 `src/proxy.js` 等价复刻（Web Streams 实现，Deno 兼容）

**复用约束**：`extractUserPrompt`/`mapVariant`/`normalizeModel`/`sessionKeyFor`/`stripEcho` 等纯函数从 `src/*.js` 直接 import（Deno 支持 CJS require 走 node: 兼容层；不可用时在 deno/ 内最小复刻并注释对齐来源）。`src/*` 与 `handler.js` 零改动。

- [x] **Step 1: RED** —— 写 `scripts/test-deno.mjs`：起 `deno run --allow-all deno/main.ts` → 黑盒断言（无 key 401 / health / models / 流式首帧 / 透传 404 / 错误结构），确认按预期失败
- [x] **Step 2: GREEN** —— 实现 engine.ts → stream.ts → main.ts（最小实现），逐断言转绿
- [x] **Step 3: REFACTOR** —— 去重、命名、对齐现有代码风格；保持全绿

## Task 3: 流式与多轮验收（本地）

- [x] **Step 1**: `stream:true` 请求看到逐帧 SSE（首帧 < 冷启动+首 token 时延）与最终 usage
- [x] **Step 2**: 多轮续聊上下文延续（x-session-id / 会话锚定）—— `scripts/test-multiturn.mjs` M1
- [x] **Step 3**: 客户端断连 → abort 上游读取（日志无异常堆积）—— M2/M3。实现备注：Deno legacy serve 在 Response 返回后 abort `req.signal`，断连检测改用 SSE ReadableStream 的 cancel 回调（deno/stream.ts `onCancel`）

## Task 4: Node 常驻形态回归关卡

- [x] **Step 1**: `node scripts/smoke-test.mjs` → 5/5
- [x] **Step 2**: `node scripts/test-bridge.mjs` → 20/21（显式凭据；T8 失败为沙箱网络拉不到完整 models.dev 目录、/config/providers 载荷 5002B < 10000B 阈值的数据问题，非桥接回归——git 证实 Node 路径零改动。注：项目根无 .env 文件，环境变量未设时 test-bridge 以空 PROXY_API_KEY 运行会大面积 401，需显式传 `PROXY_API_KEY=... node scripts/test-bridge.mjs`）
- [x] **Step 3**: 任何回归 → 回滚 deno/ 侧改动（Node 路径零改动是硬约束）—— 无回归，未回滚

## Task 5: Deno Deploy 配置与文档

**Files:**
- Create: `deno.json`（task: `dev` = `deno run --allow-all deno/main.ts`；compilerOptions 可选）
- Modify: `README.md`（Deno 方案章节：架构图、env 表、Deno Deploy 连接 GitHub 步骤、内存语义如实声明）

- [x] **Step 1**: deno.json + README
- [x] **Step 2**: commit 全部产物

---

## Self-Review（writing-plans 技能要求）

1. **Spec 覆盖**：spike 四项硬门（spec §8）→ Task 0 Step 3 ✓；vendor 流水线（§3.1）→ Task 1 ✓；魔改清单（§3.2）→ Task 0 Step 2 + Task 2 ✓；路由与单门制（§5）→ Task 2 ✓；错误对照（§6）→ Task 2 main.ts ✓；测试策略（§9）→ Task 2 Step 1 + Task 4 ✓；YAGNI（§10）→ 全计划无越界项 ✓；验收标准（§11）→ Task 0/2/3/4/5 逐条映射 ✓
2. **占位符扫描**：无 TBD/TODO；上游 `Default`/`app` 的确切访问器形态标注"以当日源码为准"（执行时读取，非占位符）
3. **类型一致性**：`deno/engine.ts` 导出与 `src/opencode.js` 语义对齐（fetch/ensure 单例模式）；`deno/stream.ts` SseWriter 输出帧序与 `src/proxy.js` 一致（Task 3 验收）
4. **风险前置**：最高风险（Deno 跑不通 bundle）由 Task 0 spike 硬门先行验证，失败即停并回退方案 B，不在未验证前写正式代码 ✓
