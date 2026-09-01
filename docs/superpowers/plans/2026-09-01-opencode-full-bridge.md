# opencode 全接口桥接 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让代理完全桥接 opencode 共享 server 的全部原生功能接口（78 路由 + web UI + WebSocket），/v1 OpenAI 翻译层保持零语义变化。

**Architecture:** 新增 `src/bridge.js` 路径级透传层（鉴权 → 请求头重建 → 响应管道/WS 中继）；`src/opencode.js` 增加凭据工具（serverFetch/Basic）并在 spawn 时注入 `OPENCODE_SERVER_PASSWORD`；`handler.js` 分派非 /v1 路径；`proxy.js` 仅 4 处内部 fetch 机械替换。常驻服务器形态全能力；事件模式非 /v1 返回 501。

**Tech Stack:** Node.js ≥18（undici fetch / http / net 内置），CJS，零新依赖。现有：`@opencode-ai/sdk`、`handler.js`、`src/proxy.js`、`src/opencode.js`。

**Spec:** `docs/superpowers/specs/2026-09-01-opencode-full-bridge-design.md`

## Global Constraints

- 不引入新 npm 依赖；不新增进程/端口；`/v1/*` 行为与现有冒烟测试 5/5 完全一致
- client→proxy 凭据（Bearer/Basic）与 proxy→upstream 凭据（Basic opencode:<密码>）严格分离；凭据不落日志、不进错误消息
- 透传响应必须剥 `content-length`/`content-encoding`/`vary`；请求头剥 hop-by-hop，`accept-encoding: identity`
- WebSocket 中继用原始 socket（不用 `http.request`）；`Sec-WebSocket-Key` 必须是合法 16 字节 base64
- 密码 = `OPENCODE_SERVER_PASSWORD`，缺省回退 `PROXY_API_KEY`；fail closed
- 事件模式（`exports.handle`）非 /v1 → 501 明确提示，不做 buffered 分支

---

### Task 1: opencode.js 凭据工具（serverPassword / basicAuthHeader / serverFetch）

**Files:**
- Modify: `src/opencode.js`（顶部，`let starting = null;` 之后插入）
- Test: 内联断言（无单测文件，直接 node -e 验证 + 后续任务真实验证）

**Interfaces:**
- Produces:
  - `module.exports.serverPassword()` → string（`OPENCODE_SERVER_PASSWORD || PROXY_API_KEY || ""`）
  - `module.exports.basicAuthHeader()` → string|null（`Basic base64("opencode:"+pw)`，无密码时 null）
  - `module.exports.serverFetch(url, options)` → Promise<Response>（注入 authorization 头，不覆盖调用方已给的头）

- [ ] **Step 1: 写失败断言**（先验证当前缺失：调 serverFetch 会 TypeError）

```bash
node -e "require('./src/opencode.js').serverFetch('http://x'); console.log('should not reach')"
```
期望：`TypeError: ...serverFetch is not a function`

- [ ] **Step 2: 实现**

```js
// ---- 内部凭据工具（server 设置密码后所有内部调用需带 Basic） ----
function serverPassword() {
  return process.env.OPENCODE_SERVER_PASSWORD || process.env.PROXY_API_KEY || "";
}
module.exports.serverPassword = serverPassword;

function basicAuthHeader() {
  const pw = serverPassword();
  if (!pw) return null;
  return "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
}
module.exports.basicAuthHeader = basicAuthHeader;

async function serverFetch(url, options) {
  const auth = basicAuthHeader();
  const headers = { ...((options && options.headers) || {}) };
  if (auth && !headers.authorization) headers.authorization = auth;
  return fetch(url, { ...(options || {}), headers });
}
module.exports.serverFetch = serverFetch;
```

- [ ] **Step 3: 验证通过**

```bash
node -e "
const oc = require('./src/opencode.js');
const kw = require('crypto').randomBytes(8).toString('hex');
process.env.PROXY_API_KEY = kw;
const h = oc.basicAuthHeader();
const expect = 'Basic ' + Buffer.from('opencode:' + kw).toString('base64');
console.assert(h === expect, 'basic header mismatch');
delete process.env.PROXY_API_KEY;
console.assert(oc.basicAuthHeader() === null, 'should be null without key');
console.log('T1 OK');
"
```
期望输出：`T1 OK`（无断言异常）

- [ ] **Step 4: 暂不提交**（Freebuff Changes 面板统一交付）

---

### Task 2: 内部调用统一走 serverFetch + fetchProviders 改原生 HTTP

**Files:**
- Modify: `src/opencode.js`（`postJson`、`subscribeEvents` 内 fetch、`bridgePrompt` 内 message fetch、`fetchProviders`）
- Modify: `src/proxy.js`（`streamChat` 内 4 处：/event、POST /session、message、permissions）
- Test: 真实链路验证（/v1/models + 流式）

**Interfaces:**
- Consumes: Task 1 的 `serverFetch`
- Produces: `fetchProviders(oc)` 签名不变（内部不再用 `oc.client`，参数保留兼容调用处 `handleModels`）

**为什么此时不注入密码**：先替换调用再开密码，保证每个中间状态可测试（此任务完成后行为应完全不变）。

- [ ] **Step 1: 写失败测试**（暂时无法让 serverFetch 路径失败 —— 等价断言：改完前后 /v1/models 结果一致）。基线先记录：

```bash
node scripts/smoke-test.mjs 2>&1 | tail -2
```
期望：`5/5 checks passed`（基线）

- [ ] **Step 2: 替换 src/opencode.js 4 处**（fetch → serverFetch）

`postJson`、`subscribeEvents` 的 `${serverUrl}/event`、`bridgePrompt` 的 message POST：

```js
// postJson 内
const res = await serverFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// subscribeEvents 内
const res = await serverFetch(`${serverUrl}/event`, { signal: ctrl.signal });
// bridgePrompt 内
const res = await serverFetch(`${serverUrl}/session/${encodeURIComponent(sessionId)}/message`, { ... });
```

- [ ] **Step 3: fetchProviders 改原生 HTTP（签名不变）**

```js
module.exports.fetchProviders = async function fetchProviders(oc) {
  try {
    const serverUrl = getServerUrl();
    if (!serverUrl) return null;
    const res = await serverFetch(`${serverUrl}/config/providers`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    // 以下 models 组装逻辑与现有一致（p.models 展开 + default）
    if (data && Array.isArray(data.providers)) { /* 原样保留 */ }
    return null;
  } catch (_e) { return null; }
};
```

- [ ] **Step 4: 替换 src/proxy.js `streamChat` 4 处**（`fetch(`${serverUrl}/event`...` 等 → `serverFetch(...)`；`const { getServerUrl } = require("./opencode")` → 同时解构 `serverFetch`）

- [ ] **Step 5: 验证无回归**

```bash
node scripts/smoke-test.mjs 2>&1 | tail -3
```
期望：`5/5 checks passed`；且 `GET /v1/models`（带 Bearer）返回 86 模型（真实 providers，非静态兜底）

---

### Task 3: ensureRuntime 注入 OPENCODE_SERVER_PASSWORD

**Files:**
- Modify: `src/opencode.js`（`ensureRuntime` 的 env 构造处）

- [ ] **Step 1: 实现**（在 env 对象构造后、`Object.assign(process.env, env)` 前）

```js
const pw = serverPassword();
if (pw && !env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = pw;
```

- [ ] **Step 2: 验证 server 带密码后内部链路仍通**

```bash
node -e "
const oc = require('./src/opencode.js');
(async () => {
  const kw = process.env.PROXY_API_KEY;           // 来自 .env，脚本内加载
  await oc.ensureRuntime();
  const p = await oc.fetchProviders(null);
  console.log('providers under password:', p ? p.models.length : 'null');
  console.assert(p && p.models.length > 0, 'fetchProviders failed under password');
})();
"
```
期望：`providers under password: 86`、无断言异常。（若失败：确认 Task 1/2 的 serverFetch 已带 Basic —— 否则排查顺序见 Task 5 回归。）

- [ ] **Step 3: 验证 /v1 流式仍通**（密码开启后 streamChat 的 serverFetch 生效）

```bash
node scripts/smoke-test.mjs 2>&1 | tail -2
```
期望：`5/5 checks passed`

---

### Task 4: src/bridge.js 透传层（鉴权 + 普通请求/SSE + CORS/OPTIONS）

**Files:**
- Create: `src/bridge.js`
- Modify: `handler.js`（非 /v1 路由分派 + banner）
- Test: `scripts/test-bridge.mjs`（T1–T16：鉴权 5 项、透传 7 项、SSE 2 项、UI 2 项）

**Interfaces:**
- Produces:
  - `bridge.checkAuth(headers) → {allowed, message}`
  - `bridge.unauthorized() → {statusCode:401, headers, body}`（含 `WWW-Authenticate: Basic realm="opencode"`）
  - `bridge.forwardStream(res, event, auth)`（async，常驻模式）
  - `bridge.forwardUpgrade(req, socket, head, auth)`（Task 5）

- [ ] **Step 1: 写失败测试** `scripts/test-bridge.mjs`（骨架：起 handler、等就绪、断言 T1–T16；暂时不写 WS 章节）

```js
// 核心断言示例（完整文件见提交）
r = await req("/agent");                          // 无凭据
check("无鉴权 -> 401 + WWW-Authenticate", r.status === 401 && r.headers.get("www-authenticate")?.includes("Basic"));
r = await req("/agent", { headers: { authorization: `Bearer ${API_KEY}` } });
check("Bearer -> 200 real agents", r.status === 200 && Array.isArray(r.json));
r = await req("/config/providers", { headers: { authorization: `Bearer ${API_KEY}` } });
check("大响应完整且无 content-encoding 残留", r.status === 200 && r.text.length > 10000 && !r.headers.get("content-encoding"));
// SSE: fetch(BASE+"/event") 首帧 <8s 且 content-type 含 event-stream
// UI: GET / 无鉴权 401；带 Basic 200 text/html
```

- [ ] **Step 2: 运行确认失败**（`require('./src/bridge')` → MODULE_NOT_FOUND；请求非 /v1 路径返回现有 404 JSON）

- [ ] **Step 3: 实现 src/bridge.js**

```js
const net = require("net");
const { getServerUrl } = require("./opencode");

function serverPassword() { return process.env.OPENCODE_SERVER_PASSWORD || process.env.PROXY_API_KEY || ""; }
function parseAuthorization(headers) { /* Bearer/Basic 解析，返回 {scheme, token|password} */ }
function checkAuth(headers) {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) return { allowed: false, message: "PROXY_API_KEY 未配置" };
  const cred = parseAuthorization(headers);
  if (cred.scheme === "bearer" && cred.token === expected) return { allowed: true };
  const pw = serverPassword();
  if (cred.scheme === "basic" && pw && cred.password === pw) return { allowed: true };
  return { allowed: false, message: "缺少或无效的 Authorization" };
}
const HOP_BY_HOP = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade","host","content-length"]);
function forwardHeaders(headers) { /* 剥 hop-by-hop + accept-encoding: identity + authorization 换内部 Basic */ }
function responseHeaders(headers) { /* 剥 content-length/content-encoding/vary/hop-by-hop + 补 CORS */ }
async function forwardStream(res, event, auth) {
  if (!auth.allowed) return write401(res);
  await ensureReady();                      // require("./opencode").ensureRuntime()
  const url = /*** serverUrl + path + queryStringParameters（URLSearchParams） ***/;
  const upstream = await serverFetch(url, { method, headers: forwardHeaders(event.headers), body: GET/HEAD ? undefined : event.body });
  res.writeHead(upstream.status, responseHeaders(Object.fromEntries(upstream.headers)));
  /* reader 循环：res.write(value)，返回 false 时 await drain；done 后 res.end()（背压感知） */
}
module.exports = { serverPassword, parseAuthorization, checkAuth, unauthorized, forwardHeaders, responseHeaders, forwardStream, forwardUpgrade };
```

- [ ] **Step 4: handler.js 路由分派**

```js
// http.createServer 回调内、/v1 流式分支之后：
if (!event.path.startsWith("/v1/")) {
  const auth = bridge.checkAuth(event.headers);
  await bridge.forwardStream(res, event, auth);
  return;
}
```
（banner 增加 `opencode 原生接口: http://127.0.0.1:<port>/session /config /event /agent …` 与 web UI 提示。）

- [ ] **Step 5: 运行 test-bridge，T1–T16 全绿**

```bash
node scripts/test-bridge.mjs 2>&1 | tail -5
```
期望：`16 passed, 0 failed`（本任务范围内；WS 两例在 Task 5 补）

---

### Task 5: WebSocket 中继（forwardUpgrade + upgrade 监听 + 非 101 回写）

**Files:**
- Modify: `src/bridge.js`（forwardUpgrade）
- Modify: `handler.js`（`server.on("upgrade", ...)`）
- Test: `scripts/test-bridge.mjs` 补 T17–T18

- [ ] **Step 1: 写失败测试**（test-bridge 补 WS 用例）

```js
// 手写 upgrade 请求（合法 16 字节 nonce: dGhlIHNhbXBsZSBub25jZQ==）+ Bearer
// 建 pty: POST /pty {command:"bash"} → GET /pty/{id}/connect 期望 101
// 无鉴权 upgrade 期望 401
```

- [ ] **Step 2: 运行确认失败**（当前 handler 无 upgrade 监听 → node 默认行为：socket 被直接关闭）

- [ ] **Step 3: 实现 forwardUpgrade（原始 socket 字节中继）**

```js
function forwardUpgrade(req, socket, head, auth) {
  if (!auth.allowed) { /* 回写 401 状态行+头+体，socket.end()，return */ }
  ensureReady().then(() => {
    const u = new URL(req.url, getServerUrl());
    let requestHead = `${req.method || "GET"} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === "authorization" || lk.startsWith("proxy-")) continue;
      requestHead += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
    }
    requestHead += `authorization: ${basicAuthHeader()}\r\nhost: ${u.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n`;
    const upstream = net.connect(Number(u.port) || 80, u.hostname || "127.0.0.1", () => {
      upstream.write(requestHead);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
      socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
    });
    upstream.on("error", () => { try { socket.destroy(); } catch (_e) {} });
  }).catch(() => { /* 502 回写 */ });
}
```

- [ ] **Step 4: handler.js 挂 upgrade 监听**

```js
server.on("upgrade", async (req, socket, head) => {
  try {
    const event = { method: req.method, path: new URL(req.url, "http://localhost").pathname, headers: req.headers };
    const auth = bridge.checkAuth(event.headers);
    await bridge.forwardUpgrade(req, socket, head, auth);
  } catch (err) { console.error("[upgrade] proxy error:", (err && err.message) || err); try { socket.destroy(); } catch (_e) {} }
});
```

- [ ] **Step 5: 验证**（真实 pty 101 握手 + 非法 nonce 会被上游 400 且透传该 400）

```bash
node scripts/test-bridge.mjs 2>&1 | tail -3
```
期望：`19 passed, 0 failed`

---

### Task 6: 事件模式 501 + 文档 + 全量回归

**Files:**
- Modify: `src/proxy.js`（`handleRequest` 末尾 404 之前：非 /v1 → 501）
- Modify: `README.md`（"全接口桥接"章节 + 结构清单 + 架构图）、`env.example`（OPENCODE_SERVER_PASSWORD 注释块）
- Test: 全量

- [ ] **Step 1: 事件模式 501**

```js
// handleRequest 内、auth 检查之后、/v1/models 之前：
if (!path.startsWith("/v1/")) {
  return {
    statusCode: 501,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
    isBase64Encoded: false,
    body: JSON.stringify({ error: { message: "原生 opencode 接口需要常驻 HTTP 服务器模式（node handler.js）", type: "invalid_request_error" } }),
  };
}
```

- [ ] **Step 2: 文档**（按 spec 第 1/3/4 节内容落 README；env.example 加注释：`# OPENCODE_SERVER_PASSWORD=` 缺省回退 PROXY_API_KEY、浏览器 Basic 登录 `opencode/<密码>`）

- [ ] **Step 3: 全量回归**

```bash
node scripts/test-bridge.mjs 2>&1 | tail -3   # 19/19
node scripts/smoke-test.mjs 2>&1 | tail -2    # 5/5
node -e "require('./handler.js'); require('./src/bridge.js'); require('./src/proxy.js'); require('./src/opencode.js'); console.log('MODULES OK')"
```
期望：`19 passed, 0 failed` + `5/5 checks passed` + `MODULES OK`

- [ ] **Step 4: 预览重启 + 浏览器验收**（Freebuff UI 重启预览；打开根路径期望 Basic 登录框；登录后 web UI 可交互；/v1 请求不变）

---

## Self-Review（writing-plans 技能要求）

1. **Spec 覆盖**：架构（T1–T6 任务映射）✓；鉴权三元组（T1/T3/T4）✓；转发/SSE（T4）✓；WS（T5）✓；事件模式 501 + 文档（T6）✓；测试 19 项（T4 起 T1–T16，T5 补 T17–T18，T6 回归）✓
2. **占位符扫描**：无 TBD/TODO；`/**/` 注释处的 URL 拼装/模型组装为指向既有实现的引用（"原样保留"），非占位符
3. **类型一致性**：`checkAuth`/`forwardStream`/`forwardUpgrade` 签名在 T4/T5/T6 中一致；`fetchProviders(oc)` 签名在 T2/T3 一致；`serverFetch/basicAuthHeader` 在 T1–T5 一致