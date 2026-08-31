// Scaleway Serverless Function 的入口。
// 该文件导出 `handle`，被 Scaleway Node 运行时调用；直接运行时（node dist/handler.js）
// 会启动一个本地 HTTP 服务器，用于本地联调。

const { handleRequest } = require("./src/proxy");

// 每个对话 sessionId 放在内存里（容器保持热时会一直有效，
// 冷启动后会重新开一个新的 opencode 会话，属正常现象）。
const sessions = new Map();

exports.handle = async function handle(event) {
  return handleRequest(event, sessions);
};

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
        const out = await exports.handle(event);
        res.writeHead(out.statusCode || 200, out.headers || {});
        res.end(out.body == null ? "" : String(out.body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: String((err && err.stack) || err), type: "internal_error" } }));
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[opencode-scw] 本地 OpenAI 兼容代理已启动：`);
    console.log(`   base            : http://127.0.0.1:${port}`);
    console.log(`   模型列表         : GET  http://127.0.0.1:${port}/v1/models`);
    console.log(`   聊天接口         : POST http://127.0.0.1:${port}/v1/chat/completions`);
  });
}