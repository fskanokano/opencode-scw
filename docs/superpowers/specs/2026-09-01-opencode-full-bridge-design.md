# opencode 全接口桥接 —— 设计文档

**日期**: 2026-09-01
**状态**: 已获用户逐节确认（架构 / 鉴权 / 转发 / 测试四节）
**关联**: 目标 = 让代理完全桥接 opencode 共享 server 的全部原生功能接口

## 1. 背景与目标

- 现状：代理只暴露 OpenAI 兼容的 `/v1/models` 与 `/v1/chat/completions`，opencode
  server 的其余能力（78 个原生 HTTP 路由 + 官方 web UI + pty 终端会话）无法被外部使用。
- 目标：外部客户端可以**当 opencode server 直接连** —— 结构/字段/错误信息零加工透传；
  同时保持现有 `/v1` OpenAI 翻译层完全不变。
- 运行形态（用户已确认）：**常驻 HTTP 服务器**（`node handler.js`）。SSE / WebSocket
  长连接只在常驻形态下成立；Scaleway 事件模式入口对非 `/v1` 路径返回明确 501，不做
  buffered 分支（YAGNI）。

## 2. 架构与组件边界

```
请求进入 handler.js
  ├─ /v1/*            → 现有 src/proxy.js 翻译层（业务逻辑不变）
  └─ 其它一切路径      → src/bridge.js 透传层（新增）
       ├─ 鉴权：Bearer <PROXY_API_KEY> 或 Basic opencode:<密码>
       ├─ 普通请求/SSE：undici fetch 上行 + 响应管道直通
       ├─ WebSocket：/pty/**/connect 字节级 TCP 中继
       └─ 上行统一注入内部 Basic 凭据
```

| 组件 | 改动 | 职责 |
|---|---|---|
| `src/bridge.js` | 新建（~250 行） | 鉴权判定、请求头重建、响应透传、SSE 管道、WS 中继；不含业务逻辑 |
| `src/opencode.js` | 小改 | ① spawn 时注入 `OPENCODE_SERVER_PASSWORD`（缺省回退 `PROXY_API_KEY`）；② 新增 `serverFetch()`（内部调用统一 Basic）；③ `fetchProviders` 内部改原生 HTTP（对外签名不变） |
| `handler.js` | 小改 | 非 `/v1` 走 `bridge.forwardStream`；挂 `server.on("upgrade")` |
| `src/proxy.js` | 机械小改 | 业务逻辑不动；`streamChat` 内 4 处直连 fetch（/event、/session、message、permissions）替换为 `serverFetch` |
| 事件模式 `exports.handle` | 小改 | 非 `/v1` → 501 明确提示 |

## 3. 鉴权与凭据流

- 凭据三元组：
  - `/v1/*`：`Bearer <PROXY_API_KEY>`（不变）
  - 原生 API：`Bearer <PROXY_API_KEY>` 或 `Basic opencode:<密码>`
  - web UI：浏览器 Basic 弹窗（用户名固定 `opencode`）
  - 密码 = `OPENCODE_SERVER_PASSWORD`，缺省回退 `PROXY_API_KEY`（一把钥匙开两道门）
- **fail closed**：`PROXY_API_KEY` 未配置 → 全部 401；凭据缺失/错误 → 401 +
  `WWW-Authenticate: Basic`（浏览器原生登录框）。
- **凭据分离**：client→proxy 与 proxy→upstream 解耦；上行 Authorization 统一替换为
  内部 Basic；客户端凭据不达上游、不落日志、不进错误消息。
- 冷启动：bridge 首请求触发共享 `ensureRuntime()`；未就绪 → 502 `upstream_error`
  （OpenAI 风格错误结构，与 /v1 同语义）。

## 4. 转发与数据流

### 4.1 普通请求与 SSE（forwardStream）

- 目标 = `serverUrl + 原始路径 + 查询参数`。
- 请求头重建：剥 hop-by-hop（connection/keep-alive/transfer-encoding/upgrade/host/
  content-length/proxy-*）；`accept-encoding: identity`；`authorization` 换内部 Basic。
- 响应：透传状态码 + 头，**剥** `content-length`/`content-encoding`/`vary`（undici
  已透明解压，保留 gzip 头会使客户端死等——实测教训）；补 CORS 头；body 流式管道
  （背压感知），大响应与 SSE 长连接同路径，不整读内存。

### 4.2 WebSocket（forwardUpgrade）

- 不用 node `http.request`（对 upgrade 行为差异导致 400——实测教训），用**原始 socket
  字节中继**：重建请求头（剥 hop-by-hop/authorization → 注内部 Basic → 补 host /
  connection: Upgrade / upgrade: websocket）→ 连 upstream → 附带 head 字节 → 双向
  pipe，101 之后纯字节流、零解析。
- 上游返回非 101：状态行 + 头 + 体完整回写客户端再关闭。
- 任一端断开 → 销毁对端。

### 4.3 错误透传

| 场景 | 行为 |
|---|---|
| 上游 4xx/5xx（opencode 业务错误） | 原样透传（状态码 + 响应体） |
| 网关自身故障（未就绪/连不上） | 502 + OpenAI 风格 `{error:{message,type:"upstream_error"}}` |

### 4.4 预检与日志

- `OPTIONS` 任意路径 → 204 + CORS 头。
- 日志沿用 `[proxy]` 格式（方法/路径/状态/耗时）；SSE/WS 记录连接建立/关闭；不含凭据。

## 5. 测试策略（TDD）

脚本：`scripts/test-bridge.mjs`（黑盒 e2e：真实 handler + 真实 opencode）+ 纯函数单测
（node 内置 assert，零新依赖）。用例 19 项：

1. 鉴权：无凭据/错误 Bearer → 401 + WWW-Authenticate；Bearer/Basic → 200；
   /v1 无 Bearer → 401（语义不变）
2. 透传：/agent、/experimental/tool/ids、/config/providers（~79KB 大响应完整、无
   content-encoding 残留）；POST /session → PATCH 改名 → GET todo；未知路径透传上游响应
3. SSE：/event 带鉴权 → event-stream 首帧 <8s 连接保持
4. Web UI：/ 无鉴权 401；带 Basic 200 text/html
5. WebSocket：POST /pty + 合法 16 字节 nonce → 101；无鉴权 upgrade → 401
6. /v1 回归：smoke-test 5/5 保持通过

**验收标准**：test-bridge 全绿 + smoke 5/5 + 预览重启后 web UI 可交互（Basic 登录框）。

## 6. 明确不做（YAGNI）

- 不做逐端点 SDK 封装（方案 2，维护成本高、违反原样语义）
- 不做端口级转发（方案 3，绕过网关鉴权）
- 不做 buffered 分支 / 事件模式长连接（用户确认常驻形态）
- 不改 /v1 语义、不改会话锚定/真流式/权限放行行为
- 不引入新 npm 依赖