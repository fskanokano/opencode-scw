// opencode 全接口透传桥（路径级反向代理）。
//
// /v1/* 继续走 src/proxy.js 的 OpenAI 翻译层；其余一切路径（78 个原生路由 +
// 官方 web UI 静态资源 + SSE 长连接）由本模块字节级原样转发给共享 opencode
// server。不解析、不加工任何业务内容 —— 结构/字段/错误信息零改动。
//
// 鉴权：Bearer <PROXY_API_KEY> 或 Basic opencode:<密码>（密码缺省回退
// PROXY_API_KEY，"一把钥匙开两道门"）。上行转发统一替换为内部 Basic 凭据，
// 客户端凭据不达上游。

const net = require("net");
const { getServerUrl, serverFetch, basicAuthHeader, serverPassword, ensureRuntime } = require("./opencode");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-session-id",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};

// hop-by-hop 头（RFC 2616 13.5.1）＋ 由 undici/fetch 负责的实体头
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host",
]);

/**
 * 网关侧鉴权：Bearer PROXY_API_KEY 或 Basic（用户名不限，密码 == serverPassword()）。
 * fail closed：PROXY_API_KEY 未配置 → 拒绝一切请求。
 */
function checkAuth(headers) {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) return { allowed: false, message: "PROXY_API_KEY 未配置" };
  const auth = (headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token === expected) return { allowed: true };
    return { allowed: false, message: "无效的 Bearer 凭据" };
  }
  if (/^Basic\s+/i.test(auth)) {
    const b64 = auth.replace(/^Basic\s+/i, "").trim();
    let decoded = "";
    try { decoded = Buffer.from(b64, "base64").toString("utf8"); } catch {}
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    const pw = serverPassword();
    if (pw && password === pw) return { allowed: true };
    return { allowed: false, message: "无效的 Basic 凭据" };
  }
  return { allowed: false, message: "缺少或无效的 Authorization" };
}

/** 401 响应（含 WWW-Authenticate，浏览器原生弹 Basic 登录框）。 */
function unauthorized() {
  return {
    statusCode: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Basic realm="opencode"',
      ...CORS,
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      error: { message: "缺少或无效的 Authorization（Bearer <PROXY_API_KEY> 或 Basic opencode:<密码>）", type: "authentication_error", param: null, code: null },
    }),
  };
}

/** 上行请求头重建：剥 hop-by-hop → accept-encoding: identity → authorization 换内部 Basic。 */
function forwardHeaders(headers) {
  const out = {};
  const h = headers || {};
  for (const key of Object.keys(h)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k.startsWith("proxy-") || k === "content-length" || k === "accept-encoding" || k === "authorization") continue;
    const v = h[key];
    if (v != null) out[k] = String(v);
  }
  out["accept-encoding"] = "identity";
  const auth = basicAuthHeader();
  if (auth) out.authorization = auth;
  return out;
}

/** 响应头：剥 hop-by-hop/压缩相关（undici 已透明解压，保留会让客户端死等）＋ 补 CORS。 */
function responseHeaders(headers) {
  const out = {};
  const h = headers || {};
  for (const key of Object.keys(h)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k.startsWith("proxy-") || k === "content-length" || k === "content-encoding" || k === "vary" || k === "etag") continue;
    const v = h[key];
    if (v != null) out[k] = String(v);
  }
  return { ...out, ...CORS };
}

/** OPTIONS 预检：任意路径 204 + CORS。 */
function handleOptions(res) {
  res.writeHead(204, { ...CORS, "content-length": "0" });
  res.end();
  return true;
}

/**
 * 流式透传（常驻 HTTP 服务器形态）：鉴权 → ensureRuntime → 上行 fetch →
 * 状态码/头透传 → body 背压管道直通。SSE 长连接（/event）与普通响应同路径。
 * @returns {Promise<boolean>} true = 已处理
 */
async function forwardStream(res, event) {
  const start = Date.now();
  const method = String(event.method || event.httpMethod || "GET").toUpperCase();
  const rawPath = String(event.path || event.httpPath || "/");
  const logLine = (status) =>
    console.log(`[bridge] ${method} ${rawPath} -> ${status} (${Date.now() - start}ms)`);

  try {
    // OPTIONS 不鉴权（浏览器预检）
    if (method === "OPTIONS") {
      handleOptions(res);
      logLine(204);
      return true;
    }

    const headers = {};
    const srcHeaders = event.headers || {};
    for (const k of Object.keys(srcHeaders)) headers[k.toLowerCase()] = srcHeaders[k];

    const auth = checkAuth(headers);
    if (!auth.allowed) {
      const u = unauthorized();
      res.writeHead(u.statusCode, u.headers);
      res.end(u.body);
      logLine(u.statusCode);
      return true;
    }

    // 首次请求触发共享 server 懒启动（与 /v1 同一实例）
    await ensureRuntime();
    const serverUrl = getServerUrl();
    if (!serverUrl) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8", ...CORS });
      res.end(JSON.stringify({ error: { message: "opencode server 未就绪", type: "upstream_error" } }));
      logLine(502);
      return true;
    }

    const url = new URL(rawPath, "http://internal");
    const target = serverUrl + url.pathname + url.search;
    const body = method === "GET" || method === "HEAD" ? undefined : (event.body || undefined);

    const upstream = await serverFetch(target, {
      method,
      headers: forwardHeaders(headers),
      body,
    });

    res.writeHead(upstream.status, responseHeaders(Object.fromEntries(upstream.headers)));

    if (method === "HEAD" || !upstream.body) {
      res.end();
      logLine(upstream.status);
      return true;
    }

    const reader = upstream.body.getReader();
    res.on("close", () => { try { reader.cancel().catch(() => {}); } catch {} });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((r) => res.once("drain", r));
        }
      }
    } finally {
      res.end();
    }
    logLine(upstream.status);
    return true;
  } catch (err) {
    const msg = String((err && err.message) || err);
    try {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", ...CORS });
      }
      res.end(JSON.stringify({ error: { message: `上游转发失败：${msg}`, type: "upstream_error" } }));
    } catch {}
    logLine("ERROR");
    return true;
  }
}

/**
 * WebSocket 中继（常驻形态）：字节级原始 socket 管道，零帧解析。
 * 重建请求头（剥 hop-by-hop/authorization → 注内部 Basic → 补 host）后连上游，
 * 附带 head 字节一并发出，然后双向 pipe —— 101 之后是纯字节流，WebSocket 帧
 * 由两端自己编解码。上游返回非 101（如 400/404）时，pipe 天然把完整响应
 * （状态行 + 头 + 体）原样回写客户端，然后随上游关闭收尾。
 * 不用 node http.request：其 upgrade 请求行为与原始 socket 有差异（实测 400）。
 */
async function forwardUpgrade(req, socket, head) {
  const t0 = Date.now();
  const method = String(req.method || "GET");
  const rawPath = String(req.url || "/");
  const log = (s) => console.log(`[bridge] WS ${method} ${rawPath} -> ${s} (${Date.now() - t0}ms)`);

  try {
    // 鉴权（与普通请求同模型）
    const headers = {};
    for (const k of Object.keys(req.headers || {})) headers[String(k).toLowerCase()] = req.headers[k];
    const auth = checkAuth(headers);
    if (!auth.allowed) {
      const body = JSON.stringify({
        error: { message: "缺少或无效的 Authorization（Bearer <PROXY_API_KEY> 或 Basic opencode:<密码>）", type: "authentication_error" },
      });
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\n` +
        `www-authenticate: Basic realm="opencode"\r\n` +
        `content-type: application/json; charset=utf-8\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        `connection: close\r\n\r\n` + body
      );
      socket.end();
      log(401);
      return;
    }

    // 冷启动：共享 server 未就绪时等它起来（客户端在握手前不会发业务数据，安全）
    await ensureRuntime();
    const serverUrl = getServerUrl();
    if (!serverUrl) {
      socket.write(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json; charset=utf-8\r\nconnection: close\r\n\r\n` +
        JSON.stringify({ error: { message: "opencode server 未就绪", type: "upstream_error" } }));
      socket.end();
      log(502);
      return;
    }

    const u = new URL(rawPath, serverUrl);
    const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = String(k).toLowerCase();
      if (HOP_BY_HOP.has(key) || key === "authorization" || key === "host" || key === "accept-encoding" || key === "content-length") continue;
      if (v != null) lines.push(`${key}: ${v}`);
    }
    lines.push(`host: ${u.host}`);
    lines.push("connection: Upgrade");
    lines.push("upgrade: websocket");
    const authHdr = basicAuthHeader();
    if (authHdr) lines.push(`authorization: ${authHdr}`);
    const request = lines.join("\r\n") + "\r\n\r\n";

    const conn = net.connect(Number(u.port) || 80, u.hostname);
    conn.once("connect", () => {
      conn.write(request);
      if (head && head.length) conn.write(head);
      socket.pipe(conn);
      conn.pipe(socket);
    });
    conn.once("error", (e) => { log(`upstream error: ${String((e && e.message) || e)}`); try { socket.destroy(); } catch {} });
    socket.once("error", () => { try { conn.destroy(); } catch {} });
    socket.once("close", () => { try { conn.destroy(); } catch {} });
    conn.once("close", () => { try { socket.end(); } catch {} });
    log("relay");
  } catch (err) {
    log(`ERROR ${String((err && err.message) || err)}`);
    try { socket.destroy(); } catch {}
  }
}

module.exports = {
  checkAuth,
  unauthorized,
  forwardHeaders,
  responseHeaders,
  forwardStream,
  forwardUpgrade,
};