// Scaleway Serverless Function 的入口。
// 该文件导出 `handle`，被 Scaleway Node 运行时调用；直接运行时（node dist/handler.js）
// 会启动一个本地 HTTP 服务器，用于本地联调。

const fs = require("fs");
const path = require("path");

// 轻量加载 .env / .env.local（避免引入 dotenv 依赖）。
// 只补齐未设置的环境变量，不覆盖平台注入的值，也不输出任何内容。
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, file), "utf8");
  } catch (_e) {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#|^\s*$/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const { handleRequest, streamChat } = require("./src/proxy");
const bridge = require("./src/bridge");

// 每个对话 sessionId 放在内存里（容器保持热时会一直有效，
// 冷启动后会重新开一个新的 opencode 会话，属正常现象）。
const sessions = new Map();

exports.handle = async function handle(event) {
  const p = String(event.path || event.httpPath || "/");
  // 事件模式（Scaleway Function）一次调用返回一个响应，无法承载长连接路由；
  // 非 /v1 路径（opencode 原生接口 / web UI / SSE / WebSocket）明确 501。
  // 常驻形态（node handler.js）的非 /v1 由 server 分支的 bridge 透传，不走这里。
  if (!/^\/v1(\/|$)/.test(p)) {
    return {
      statusCode: 501,
      headers: { "content-type": "application/json; charset=utf-8" },
      isBase64Encoded: false,
      body: JSON.stringify({
        error: {
          message: "非 /v1 路径（opencode 原生接口 / web UI / SSE / WebSocket）仅支持常驻 HTTP 服务器形态（node handler.js）",
          type: "not_implemented",
        },
      }),
    };
  }
  return handleRequest(event, sessions);
};

// 粗略检查请求体是否请求了 stream（避免在热路径上完整解析两次）
function reqBodyStream(rawBody) {
  try {
    return JSON.parse(rawBody || "{}").stream === true;
  } catch (_e) {
    return false;
  }
}

// ---- 本地开发服务器（不是部署产物的一部分） ----
if (require.main === module) {
  const http = require("http");
  const port = Number(process.env.PORT || 8787);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      try {
        const url = new URL(req.url, "http://localhost");
        const event = {
          method: req.method,
          httpMethod: req.method,
          path: url.pathname,
          httpPath: url.pathname,
          queryStringParameters: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body: rawBody,
          isBase64Encoded: false,
        };
        // 流式请求走真流式通路（实时推送 reasoning/text 增量）
        if (event.method === "POST" && /\/v1\/chat\/completions$/.test(event.path) && reqBodyStream(rawBody)) {
          await streamChat(res, event, sessions);
          return;
        }
        // 非 /v1 路径 → opencode 原生接口 + web UI 全接口透传（常驻形态）
        if (!/^\/v1(\/|$)/.test(event.path)) {
          await bridge.forwardStream(res, event);
          return;
        }
        const out = await exports.handle(event);
        res.writeHead(out.statusCode || 200, out.headers || {});
        res.end(out.body == null ? "" : String(out.body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: String((err && err.stack) || err), type: "internal_error" } }));
      }
    });
  });

  // WebSocket 中继（/pty/**/connect 等）：字节级向上游转发
  server.on("upgrade", (req, socket, head) => {
    bridge.forwardUpgrade(req, socket, head).catch((e) => {
      try { socket.destroy(); } catch {}
      console.error("[bridge] upgrade error:", String((e && e.message) || e));
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[opencode-scw] 代理已启动：`);
    console.log(`   base            : http://127.0.0.1:${port}`);
    console.log(`   OpenAI 接口     : GET  http://127.0.0.1:${port}/v1/models`);
    console.log(`                   : POST http://127.0.0.1:${port}/v1/chat/completions`);
    console.log(`   opencode 原生   : 其余全部路径原样透传（web UI: http://127.0.0.1:${port}/app）`);
    console.log(`   凭据           : Bearer <PROXY_API_KEY> 或 Basic opencode:<密码>`);
  });
}