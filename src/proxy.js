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

// 用首条 user 消息做会话锚点：同一段对话（首条相同）稳定复用同一个
// opencode 会话，多轮上下文得以延续；不同对话（首条不同）自然隔离。
// 之前用"去掉最后一条消息后的历史"做 key，导致每轮历史变化都会开新会话、
// 上下文丢失。
function sessionKeyFor(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let anchor = null;
  for (const m of list) {
    if (m && m.role === "user" && m.content != null) {
      anchor = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      break;
    }
  }
  const raw = anchor !== null ? anchor : JSON.stringify(list);
  return crypto.createHash("sha1").update(String(raw).slice(0, 1024)).digest("hex");
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

// 裁剪模型对用户问题的复读：Muse 等弱模型会在回答开头生成一个"完整复读
// 最后一条 user 文本"的独立 part。opencode 直连没有这个问题（协议/提示词差异），
// 这里在输出侧做对齐：text 以最后 user 文本原文开头 → 裁掉该前缀。
// 正常回答不会以用户问题开头，因此零误伤；纯复读 part 裁剪后为空则丢弃。
function stripEcho(text, userText) {
  if (!text || !userText) return text;
  const t = text.trimStart();
  const u = String(userText).trim();
  if (!u || !t.startsWith(u)) return text;
  const rest = t.slice(u.length).trimStart();
  return rest || "";
}
module.exports.stripEcho = stripEcho;

// OpenAI content 数组里 image_url 的 url → opencode FilePart 的 mime 推断
function mimeForUrl(url) {
  const u = String(url || "");
  const dm = u.match(/^data:([^;,]+)[;,]/);
  if (dm) return dm[1];
  const map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", pdf: "application/pdf" };
  const m = u.match(/\.(png|jpe?g|gif|webp|bmp|svg|avif|pdf)(\?|#|$)/i);
  return (m && map[m[1].toLowerCase()]) || "image/png";
}

function extractUserPrompt(messages) {
  // 对齐 opencode 原生协议：system 消息走独立的 system 通道（message 的 system 字段），
  // user 消息只保留纯用户文本。不再把 system 拼成 "[系统指令]..." 明文塞进 user 文本 ——
  // 那是代理独有的伪系统提示，Muse 等 LLaMA 系弱模型会把 user 消息里的长指令块原样复读
  // （opencode 直连没这个问题，因为它的 system 是独立 system 角色消息）。
  // 多模态：content 数组里的 image_url part 转成 opencode 原生 file part（mime + url 透传）。
  const textParts = [];
  const systemTexts = [];
  const fileParts = [];
  for (const m of messages || []) {
    const role = m && m.role;
    const content = m && m.content;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && p.text != null) {
          const t = String(p.text);
          if (role === "user") textParts.push(t);
          else if (role === "system") systemTexts.push(t);
        } else if (p.type === "image_url" && p.image_url) {
          const url = typeof p.image_url === "string" ? p.image_url : (p.image_url && p.image_url.url);
          if (url) fileParts.push({ type: "file", mime: mimeForUrl(url), url: String(url) });
        }
      }
    } else if (typeof content === "string" && content.trim()) {
      if (role === "user") textParts.push(content);
      else if (role === "system") systemTexts.push(content);
    }
  }
  const lastUser = textParts[textParts.length - 1] || "";
  const system = systemTexts.join("\n\n").trim();
  return { prompt: lastUser, system, fileParts };
}
module.exports.extractUserPrompt = extractUserPrompt;
module.exports.mimeForUrl = mimeForUrl;

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
  const variant = mapVariant(reqBody); // reasoning_effort → opencode 原生 variant（思考强度）

  const { prompt, system, fileParts } = extractUserPrompt(reqBody.messages);
  if (!prompt && !(fileParts && fileParts.length)) {
    return errorResponse(400, "没有找到可用的用户消息文本或图片");
  }

  const clientKey = (lowercaseHeaderMap(headers)["x-session-id"] || "").trim() || sessionKeyFor(reqBody.messages);

  const runtime = await ensureRuntime();
  const sessionID = sessions.get(clientKey) || null;

  const result = await runPrompt(runtime, { prompt, model, sessionID, system, fileParts, ...(variant ? { variant } : {}) });

  if (!result.ok) {
    // 会话可能已失效（例如上次崩了），重试一次全新会话
    if (sessionID) {
      const retry = await runPrompt(runtime, { prompt, model, sessionID: null, system, fileParts, ...(variant ? { variant } : {}) });
      if (retry.ok) {
        if (retry.sessionID) sessions.set(clientKey, retry.sessionID);
        return finishResult(retry, requestedModel, stream);
      }
    }
    return errorResponse(502, `opencode 处理失败：${result.statusMessage || "未知错误"}`);
  }

  if (result.sessionID) sessions.set(clientKey, result.sessionID);
  return finishResult(result, requestedModel, stream, prompt);
}

function finishResult(result, requestedModel, stream, lastUserText) {
  const content = stripEcho(stripThink(result.text), lastUserText || "");
  // OpenAI 兼容：思考过程放在 message.reasoning_content（推理模型标准字段）
  const reasoning = stripThink(result.reasoning || "");
  const usage =
    result.tokens || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage,
    });
  }

  // 流式：分片成 SSE。思考过程先以 reasoning_content delta 发出（
  // OpenAI 推理模型标准字段），正文再以 content delta 发出。
  let sse = sseSend({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  if (reasoning) {
    for (const piece of chunkText(reasoning)) {
      sse += sseSend({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
      });
    }
  }
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

// ---- 请求日志包装：记录 方法/路径/状态码/耗时/错误摘要（不记录请求体与密钥） ----
const _handleRequest = module.exports.handleRequest;
module.exports.handleRequest = async function handleRequestLogged(event, sessions) {
  const start = Date.now();
  try {
    const out = await _handleRequest(event, sessions);
    console.log(
      `[proxy] ${String(event.method || event.httpMethod || "?")} ${event.path || event.httpPath || "/"} -> ${out.statusCode || 0} (${Date.now() - start}ms)`
    );
    return out;
  } catch (err) {
    console.log(
      `[proxy] ${String(event.method || event.httpMethod || "?")} ${event.path || event.httpPath || "/"} -> ERROR (${Date.now() - start}ms): ${String((err && err.message) || err)}`
    );
    throw err;
  }
};

// ======================= 真流式（SSE 实时增量） =======================
// 直连共享 opencode server：POST /session/:id/message 触发 agent，同时订阅
// /event 事件总线，把 message.part.updated 的 reasoning/text 增量实时转发给
// 客户端（delta.reasoning_content / delta.content），聊天过程可见。
// 参考实现：function/handler.js（container 变体）。

const { getServerUrl, serverFetch, mapVariant } = require("./opencode");

async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
  if (buf.trim()) yield buf.trim();
}

class SseWriter {
  constructor(res) {
    this.res = res;
    this.started = false;
    this.roleSent = false;
    this.base = null;
    // 顺序写队列：所有 SSE 帧都经 push 排队，保证 stop/done/end 在分片后
    this._q = Promise.resolve();
  }
  // 排一帧（delayMs 后写）。opencode 后端对弱模型是大块 part 一次性 emit，
  // 这里按打字机节奏切成小块推给客户端（OpenAI SSE 分片合法）。
  push(fn, delayMs) {
    this._q = this._q.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            try {
              fn();
            } catch {}
            resolve();
          }, delayMs || 0);
        })
    );
    return this._q;
  }
  alive() {
    return !this.res.writableEnded && !this.res.destroyed;
  }
  start(base, extraHeaders) {
    if (this.started) return;
    this.started = true;
    this.base = base;
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
      ...(extraHeaders || {}),
    });
    this.res.flushHeaders && this.res.flushHeaders();
  }
  sse(payloadObj) {
    this.push(() => {
      if (!this.alive()) return;
      this.res.write("data: " + JSON.stringify(payloadObj) + "\n\n");
    }, 0);
  }
  chunk(field, text) {
    if (!text) return;
    this.start(this.base);
    if (!this.roleSent) {
      this.roleSent = true;
      this.sse({
        ...this.base,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    }
    const smooth = process.env.OPENCODE_STREAM_SMOOTHING !== "false";
    // 每块字符数/块间隔（默认 8 字符 / 45ms ≈ 178 字符每秒）：
    // 上游是大块 part，值太小会读成"腹泻式"整屏跳出，太大则拖沓。
    const size = smooth
      ? Number(process.env.OPENCODE_STREAM_CHUNK || 8)
      : text.length;
    const delay = smooth ? Number(process.env.OPENCODE_STREAM_DELAY_MS || 45) : 0;
    for (let i = 0; i < text.length; i += size) {
      const piece = text.slice(i, i + size);
      this.push(() => {
        if (!this.alive()) return;
        this.res.write(
          "data: " +
            JSON.stringify({
              ...this.base,
              choices: [{ index: 0, delta: { [field]: piece }, finish_reason: null }],
            }) +
            "\n\n"
        );
      }, delay);
    }
  }
  stop() {
    this.start(this.base);
    this.push(() => {
      if (!this.alive()) return;
      this.res.write("data: " + JSON.stringify({ ...this.base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
    }, 0);
  }
  done() {
    this.push(() => {
      if (!this.alive()) return;
      try {
        this.res.write("data: [DONE]\n\n");
      } catch {}
    }, 0);
  }
  end() {
    this.push(() => {
      try {
        this.res.end();
      } catch (_e) {
        /* client gone */
      }
    }, 0);
  }
}

function flushDelta(sse, state, full, field) {
  if (typeof full !== "string" || full.length <= state.emitted.length) return;
  const delta = full.slice(state.emitted.length);
  state.emitted = full;
  if (delta) sse.chunk(field, delta);
}

function autoApproveStream() {
  return process.env.OPENCODE_AUTO_APPROVE !== "false";
}

function parseModelPair(model) {
  const raw = String(model || "");
  const idx = raw.indexOf("/");
  return idx > 0
    ? { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) }
    : { providerID: "opencode", modelID: raw };
}

/**
 * 真流式聊天（仅独立 HTTP 服务器模式使用，res 可直接写）。
 * 返回 true 表示已处理（包括中途出错），false 表示参数不合法应走原逻辑。
 */
module.exports.streamChat = async function streamChat(res, event, sessions) {
  const base = {
    id: completionId("chatcmpl"),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "opencode",
  };

  const headers = lowercaseHeaderMap(event.headers || {});
  const auth = checkAuth(headers);
  if (!auth.allowed) {
    const body = JSON.stringify({
      error: { message: auth.message, type: "authentication_error", param: null, code: null },
    });
    res.writeHead(401, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(body);
    return true;
  }

  let reqBody;
  try {
    reqBody = JSON.parse(event.body || "{}");
  } catch (_e) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "请求体不是合法的 JSON", type: "invalid_request_error" } }));
    return true;
  }
  if (!reqBody || typeof reqBody !== "object" || !Array.isArray(reqBody.messages) || !reqBody.messages.length) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "请求体需要包含非空 messages 字段", type: "invalid_request_error" } }));
    return true;
  }

  const requestedModel = reqBody.model || process.env.OPENCODE_DEFAULT_MODEL || "gpt-5.6-luna";
  const model = normalizeModel(requestedModel);
  const variant = mapVariant(reqBody); // reasoning_effort → opencode 原生 variant（思考强度）
  const { prompt, system, fileParts } = extractUserPrompt(reqBody.messages);
  if (!prompt && !(fileParts && fileParts.length)) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "没有找到可用的用户消息文本或图片", type: "invalid_request_error" } }));
    return true;
  }
  base.model = requestedModel;

  const clientKey =
    (lowercaseHeaderMap(headers)["x-session-id"] || "").trim() || sessionKeyFor(reqBody.messages);
  let sessionID = sessions.get(clientKey) || null;

  const runtime = await ensureRuntime().catch((e) => e);
  const serverUrl = getServerUrl();
  if (!runtime || !serverUrl) {
    const msg = String((runtime && runtime.message) || "opencode server 未就绪");
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: `opencode 处理失败：${msg}`, type: "upstream_error" } }));
    return true;
  }

  const sse = new SseWriter(res);
  // 增量状态机：兼收 message.part.delta（真正的小步增量流）与
  // message.part.updated（整块/累积文本，也承载推理明文短 burst）。
  // 每个 partID 一行状态：type（text/reasoning）、acc（累积文本）、
  // emitted（已推给客户端的字符数，相对裁剪后文本）、skip（复读前缀裁剪）。
  const partStates = new Map(); // partID -> { type, acc, emitted, skip }
  const partTypes = new Map(); // partID -> 已确认类型（delta 先行时用）
  const pendingClassify = new Map(); // partID -> Promise<type>

  async function classifyPart(partID, messageID) {
    try {
      const r = await serverFetch(
        `${serverUrl}/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`
      );
      const j = await r.json().catch(() => null);
      const parts = (j && (j.parts || (j.data && j.data.parts))) || [];
      const p = parts.find((x) => x && x.id === partID);
      if (p && (p.type === "text" || p.type === "reasoning")) return p.type;
    } catch {}
    return "text"; // 判定失败按 text 处理（不丢内容）
  }

  function ensureState(partID, type) {
    let s = partStates.get(partID);
    if (!s) {
      s = { type, acc: "", emitted: 0, skip: null };
      partStates.set(partID, s);
    }
    if (type) s.type = type;
    return s;
  }

  // 把累积文本推给客户端（只在新增部分时发帧；text part 先做复读前缀裁剪）
  function flushState(s) {
    const u = String(prompt || "").trim();
    if (s.type === "text" && s.skip === null) {
      // 前缀未定：攒到 >= 问题长度再判定，避免把问题原文复读放出去
      if (!u) {
        s.skip = 0;
      } else if (s.acc.length >= u.length) {
        s.skip = s.acc.startsWith(u) ? u.length : 0;
      } else {
        return; // 继续攒
      }
    }
    const full = s.acc.slice(s.skip);
    if (full.length <= s.emitted) return;
    const delta = full.slice(s.emitted);
    s.emitted = full.length;
    if (delta) {
      if (s.type === "reasoning") sse.chunk("reasoning_content", delta);
      else sse.chunk("content", delta);
    }
  }

  // part.updated：累积全文（可能比 acc 长 → 延伸；加密清零 → 不动）
  function pushUpdate(partID, type, fullText) {
    const s = ensureState(partID, type);
    if (typeof fullText === "string" && fullText.length > s.acc.length) {
      s.acc = fullText;
    }
    flushState(s);
  }

  // part.delta：真正的增量（field=text 时逐段累加）
  async function pushDelta(partID, messageID, deltaText) {
    let type = partTypes.get(partID);
    if (!type) {
      if (!pendingClassify.has(partID)) {
        pendingClassify.set(partID, classifyPart(partID, messageID).then((t) => {
          partTypes.set(partID, t);
          return t;
        }));
      }
      type = await pendingClassify.get(partID);
    }
    const s = ensureState(partID, type);
    s.acc += deltaText;
    flushState(s);
  }

  const eventCtrl = new AbortController();
  let eventLoop = Promise.resolve();

  try {
    const evtRes = await serverFetch(`${serverUrl}/event`, { signal: eventCtrl.signal });
    if (evtRes.ok && evtRes.body) {
      eventLoop = (async () => {
        for await (const data of sseLines(evtRes)) {
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (!ev || typeof ev !== "object") continue;
          const props = ev.properties;
          if (!props || typeof props !== "object") continue;
          if (props.sessionID && props.sessionID !== sessionID) continue;
          if (ev.type === "message.part.updated" && props.part && typeof props.part === "object") {
            const part = props.part;
            if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
              pushUpdate(part.id, part.type, part.text);
            }
          } else if (ev.type === "message.part.delta" && props.field === "text" && typeof props.delta === "string") {
            // 真正的增量流（opencode 以 ~1500ch/s 频率推 message.part.delta）：
            // 只转发新增字节，文本从此不再"整块到货"
            await pushDelta(props.partID, props.messageID, props.delta);
          } else if (ev.type === "permission.asked" && props.id && autoApproveStream()) {
            // 自动放行 agent 的工具权限（调用方已通过 PROXY_API_KEY 鉴权）
            serverFetch(`${serverUrl}/session/${encodeURIComponent(sessionID)}/permissions/${props.id}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              // bundle schema：payload = { response: "once"|"always"|"reject" }。
              // （之前误发 { response: "allow", remember: true }：字段名对但枚举值
              //  非法（allow 不在 once/always/reject 中），schema 校验失败 → 400 →
              //  agent 永远等权限 → message POST 永不返回 → 客户端零帧卡死；
              //  "once" = 本次放行，"always" = 记住放行）
              body: JSON.stringify({ response: "once" }),
            })
              .then((r) => {
                // 放行失败会让 agent 一直等权限 → 客户端零帧卡死；不能静默吞掉
                if (!r.ok) console.error(`[proxy] 权限自动放行失败: HTTP ${r.status}`);
              })
              .catch((e) => console.error(`[proxy] 权限自动放行失败: ${String((e && e.message) || e)}`));
          }
        }
      })().catch((e) => {
        // 结束时的主动 abort 是正常收尾，不打日志
        if (!(e && e.name === "AbortError")) console.error("[proxy] event loop:", e.message);
      });
    }
  } catch (_e) {
    /* 事件总线不可用，退化为完成后 flush */
  }

  let payload;
  try {
    // 建立/复用 opencode 会话
    if (!sessionID) {
      const created = await serverFetch(`${serverUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: (prompt || "OpenAI proxy session").slice(0, 60) }),
      });
      const createdJson = await created.json().catch(() => ({}));
      sessionID = createdJson.id || createdJson.data?.id;
      if (!sessionID) {
        throw new Error("opencode 会话创建失败");
      }
    }

    payload = {
      parts: [{ type: "text", text: prompt }, ...(fileParts || [])],
      model: parseModelPair(model),
      // opencode 原生 system 通道：与直连 opencode 完全一致的协议
      ...(system ? { system } : {}),
      // 思考强度：opencode 原生 variant 机制（与直连 opencode 完全一致的协议）
      ...(variant ? { variant } : {}),
    };

    const msgRes = await serverFetch(`${serverUrl}/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!msgRes.ok) {
      const j = await msgRes.json().catch(() => ({}));
      const msg = (j && (j.message || (j.error && j.error.message))) || `HTTP ${msgRes.status}`;
      if (sse.started) {
        sse.chunk("content", `\n[error] ${msg}`);
        sse.stop();
        sse.done();
        sse.end();
      } else {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: `opencode 处理失败：${msg}`, type: "upstream_error" } }));
      }
      return true;
    }

    const json = await msgRes.json().catch(() => null);
    const parts = (json && json.parts) || [];

    // 引擎把 provider 级失败放在 message.info.error（如 401 No payment method）；
    // 若整轮没产出任何正文，把它透出给客户端，而不是静默返回空回复
    const infoErr = (json && json.info && json.info.error) || undefined;
    const errMsg = infoErr && (infoErr.message || (infoErr.data && infoErr.data.message));
    const hasText = (parts || []).some(
      (p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0
    );

    // 事件可能有遗漏（如订阅晚于生成），用最终 parts 按 part.id 分别补齐，
    // 避免多 part 场景下重复/残缺（pushUpdate 与增量路径共用状态，天然去重）
    for (const p of parts) {
      if (!p || typeof p.text !== "string") continue;
      if (p.type === "text" || p.type === "reasoning") {
        pushUpdate(p.id, p.type, p.text);
      }
    }

    if (errMsg && !hasText) {
      sse.chunk("content", `\n[error] ${errMsg}`);
    }

    // stream_options.include_usage：结尾附上真实 token 用量（OpenAI 标准）
    if (reqBody.stream_options && reqBody.stream_options.include_usage && json && json.info) {
      const t = json.info.tokens || {};
      sse.sse({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: t.input || 0,
          completion_tokens: (t.output || 0) + (t.reasoning || 0),
          total_tokens: t.total || 0,
        },
      });
    }

    if (sessionID) sessions.set(clientKey, sessionID);
    sse.stop();
    sse.done();
    sse.end();
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (sse.started) {
      sse.chunk("content", `\n[error] ${msg}`);
      sse.stop();
      sse.done();
    } else {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: `opencode 处理失败：${msg}`, type: "upstream_error" } }));
    }
  } finally {
    eventCtrl.abort();
    await eventLoop.catch(() => {});
  }
  return true;
};

// streamChat 同样打请求日志（预览/部署里排查用）：方法/路径/状态/耗时，不记内容
const _streamChat = module.exports.streamChat;
module.exports.streamChat = async function streamChatLogged(res, event, sessions) {
  const start = Date.now();
  try {
    const out = await _streamChat(res, event, sessions);
    console.log(
      `[proxy] ${String(event.method || event.httpMethod || "?")} ${event.path || event.httpPath || "/"} -> stream ${out === true ? "done" : "handoff"} (${Date.now() - start}ms)`
    );
    return out;
  } catch (err) {
    console.log(
      `[proxy] ${String(event.method || event.httpMethod || "?")} ${event.path || event.httpPath || "/"} -> stream ERROR (${Date.now() - start}ms): ${String((err && err.message) || err)}`
    );
    throw err;
  }
};