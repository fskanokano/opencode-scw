// OpenAI 兼容适配层。
//
// 对外暴露标准的 OpenAI 接口（/v1/models、/v1/chat/completions），
// 内部把请求转发给"原汁原味"的 opencode 去执行，然后把 opencode 的回复
// 翻译回 OpenAI 格式。这里不包含任何自己的大模型逻辑。

const crypto = require("crypto");
const { normalizeModel, modelsPayload } = require("./zen-models");
const { ensureRuntime, runPrompt, fetchProviders } = require("./opencode");

function jsonResponse(statusCode, payload, extraHeaders) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-session-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      ...(extraHeaders || {}),
    },
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };
}

function errorResponse(statusCode, message, type) {
  return jsonResponse(statusCode, {
    error: { message, type: type || "invalid_request_error", param: null, code: null },
  });
}

function lowercaseHeaderMap(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
  return out;
}

function checkAuth(headers) {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) {
    return { allowed: false, message: "PROXY_API_KEY 未配置：请先在函数环境变量里设置它。" };
  }
  const auth = (headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!auth || auth !== expected) {
    return { allowed: false, message: "缺少或无效的 Authorization: Bearer <代理密钥>" };
  }
  return { allowed: true };
}

// 用消息历史（去掉最后一条用户消息）推导会话 key，实现"同一段对话自动续上、
// 新对话自动开新会"的语义，对无状态的 OpenAI 客户端也很友好。
function sessionKeyFor(messages) {
  const history = Array.isArray(messages) ? messages.slice(0, -1) : [];
  return crypto.createHash("sha1").update(JSON.stringify(history)).digest("hex");
}

function sleepWithJitter(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 60)));
}

function stripThink(text) {
  // 去掉 opencode 可能有的思考块（<thinking_effort> 包裹的内容），保留正文
  return text
    .replace(/<thinking_effort>[\s\S]*?<\/thinking_effort>\s*/gi, "")
    .trim();
}

function extractUserPrompt(messages) {
  const textParts = [];
  const systemTexts = [];
  for (const m of messages || []) {
    const role = m && m.role;
    const content = m && m.content;
    const str = Array.isArray(content)
      ? content
          .filter((p) => p && p.type === "text" && p.text != null)
          .map((p) => p.text)
          .join("\n")
      : typeof content === "string"
        ? content
        : "";
    if (!str.trim()) continue;
    if (role === "user") textParts.push(str);
    else if (role === "system") systemTexts.push(str);
  }
  const lastUser = textParts[textParts.length - 1] || "";
  const system = systemTexts.join("\n\n").trim();
  return { prompt: system ? `[系统指令]\n${system}\n\n[用户问题]\n${lastUser}` : lastUser };
}

function completionId(prefix) {
  return (prefix || "chatcmpl") + "-" + crypto.randomBytes(8).toString("hex");
}

function sseSend(payloadObj) {
  return "data: " + JSON.stringify(payloadObj) + "\n\n";
}

function sseDone() {
  return "data: [DONE]\n\n";
}

// 把 opencode 返回的整段文本切成接近"流式"的片段。opencode 是 agent，
// 本身不一定逐 token 吐出，这里在返回后对客户端做一次近似分片。
function chunkText(text, size) {
  const n = size || 24;
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  if (out.length === 0) out.push("");
  return out;
}

async function handleChat(reqBody, headers, sessions) {
  if (!reqBody || typeof reqBody !== "object" || !reqBody.messages) {
    return errorResponse(400, "请求体需要包含 messages 字段");
  }
  const requestedModel = reqBody.model || process.env.OPENCODE_DEFAULT_MODEL || "gpt-5.6-luna";
  const model = normalizeModel(requestedModel);
  const stream = Boolean(reqBody.stream);

  const { prompt } = extractUserPrompt(reqBody.messages);
  if (!prompt) {
    return errorResponse(400, "没有找到可用的用户消息文本");
  }

  const clientKey = (lowercaseHeaderMap(headers)["x-session-id"] || "").trim() || sessionKeyFor(reqBody.messages);

  const runtime = await ensureRuntime();
  const sessionID = sessions.get(clientKey) || null;

  const result = await runPrompt(runtime, { prompt, model, sessionID });

  if (!result.ok) {
    // 会话可能已失效（例如上次崩了），重试一次全新会话
    if (sessionID) {
      const retry = await runPrompt(runtime, { prompt, model, sessionID: null });
      if (retry.ok) {
        if (retry.sessionID) sessions.set(clientKey, retry.sessionID);
        return finishResult(retry, requestedModel, stream);
      }
    }
    return errorResponse(502, `opencode 处理失败：${result.statusMessage || "未知错误"}`);
  }

  if (result.sessionID) sessions.set(clientKey, result.sessionID);
  return finishResult(result, requestedModel, stream);
}

function finishResult(result, requestedModel, stream) {
  const content = stripThink(result.text);
  const created = Math.floor(Date.now() / 1000);
  const id = completionId("chatcmpl");

  if (!stream) {
    return jsonResponse(200, {
      id,
      object: "chat.completion",
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // 流式：分片成 SSE。
  let sse = sseSend({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (const piece of chunkText(content)) {
    sse += sseSend({
      id,
      object: "chat.completion.chunk",
      created,
      model: requestedModel,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
  }
  sse += sseSend({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  sse += sseDone();

  return {
    statusCode: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    },
    isBase64Encoded: false,
    body: sse,
  };
}

async function handleModels() {
  // 优先返回 opencode server 报告的真实模型清单；
  // server 不可用时退回静态 ZEN_MODELS 列表。
  try {
    const oc = await ensureRuntime();
    const providers = await fetchProviders(oc);
    if (providers && providers.models.length) {
      const created = Math.floor(Date.now() / 1000);
      const data = providers.models.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: m.owned_by || "opencode",
      }));
      return jsonResponse(200, { object: "list", data });
    }
  } catch (_e) {
    /* fall through to static list */
  }
  return jsonResponse(200, modelsPayload());
}

function splitPath(p) {
  // 去掉可能的网关前缀（如 /api/v1/... -> /v1/...），路由时以 /v1 为起点
  const idx = p.indexOf("/v1/");
  return idx >= 0 ? p.slice(idx) : p.replace(/\/+$/, "") || "/";
}

module.exports.handleRequest = async function handleRequest(event, sessions) {
  const method = String(event.method || event.httpMethod || "GET").toUpperCase();
  const rawPath = String(event.path || event.httpPath || "/");
  const path = splitPath(rawPath);
  const headers = lowercaseHeaderMap(event.headers || {});
  let body = "";
  try {
    body = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : Buffer.isBuffer(event.body)
          ? event.body.toString("utf8")
          : String(event.body)
      : "";
  } catch (_e) {
    return errorResponse(400, "无法解析请求体");
  }

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, x-session-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
      isBase64Encoded: false,
      body: "",
    };
  }

  const auth = checkAuth(headers);
  if (!auth.allowed) return errorResponse(401, auth.message, "authentication_error");

  if (path === "/v1/models" && method === "GET") {
    return handleModels();
  }

  if (path === "/v1/chat/completions" && method === "POST") {
    let reqBody;
    try {
      reqBody = JSON.parse(body || "{}");
    } catch (_e) {
      return errorResponse(400, "请求体不是合法的 JSON");
    }
    return handleChat(reqBody, headers, sessions);
  }

  if (path === "/v1/health" && method === "GET") {
    // 健康检查同时探测 opencode server 是否可用。
    try {
      await ensureRuntime();
      return jsonResponse(200, { status: "ok" });
    } catch (err) {
      return jsonResponse(200, { status: "degraded", detail: String((err && err.message) || err) });
    }
  }

  return errorResponse(404, `未支持的接口：${method} ${path}（仅支持 GET /v1/models、POST /v1/chat/completions）`);
};