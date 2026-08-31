/**
 * opencode-scw — OpenAI-compatible proxy backed by a real opencode agent.
 *
 * Deploy target: Scaleway Serverless Function (zip upload, Node runtime).
 *   - Exports `handle(event, context)` and returns a complete HTTP response
 *     (the platform buffers responses; SSE streams are still delivered, but
 *     only after the agent finishes).
 *
 * Local dev only: when the `PORT` environment variable is set, a standalone
 * HTTP server is started instead (scripts/dev.mjs) so you can iterate on the
 * translation logic and watch true streaming locally. This is NOT a container
 * deployment path — production is always the Serverless Function zip.
 *
 * The LLM conversation is handled entirely by the real opencode binary (the
 * same one from https://github.com/anomalyco/opencode) running in `web` mode
 * inside the function. This file only translates OpenAI chat/completions
 * requests to opencode's HTTP API and back — it never talks to an LLM itself.
 *
 * Zero npm dependencies — only Node.js built-ins. The opencode binary must be
 * placed next to this file (see scripts/build-function.sh).
 */

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INTERNAL_PORT = Number(process.env.OPENCODE_INTERNAL_PORT || 4096);
const INTERNAL_BASE = `http://127.0.0.1:${INTERNAL_PORT}`;
const BINARY = path.join(__dirname, "opencode");

// The two required env vars (see README):
//   OPCODE_ZEN_API_KEY — the opencode Zen API key; injected into opencode's
//                        auth.json so the real opencode talks to the LLM.
//   PROXY_API_KEY      — the API key clients must send as `Authorization:
//                        Bearer <key>` to this proxy. If empty, auth is off.
const ZEN_API_KEY = process.env.OPCODE_ZEN_API_KEY || "";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const KEEP_SESSIONS = process.env.KEEP_SESSIONS === "true";
const AUTO_APPROVE = process.env.AUTO_APPROVE !== "false";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_REQUEST_BYTES = 6 * 1024 * 1024; // Scaleway function payload limit

const DEFAULT_PERMISSIONS = {
  bash: "allow",
  edit: "allow",
  webfetch: "allow",
  websearch: "allow",
  read: "allow",
  glob: "allow",
  grep: "allow",
  task: "allow",
  todowrite: "allow",
  skill: "allow",
  lsp: "allow",
  mcp: "allow",
};

// ---------------------------------------------------------------------------
// opencode child process lifecycle
// ---------------------------------------------------------------------------
let child = null;
let childReady = false;
let spawnPromise = null;
const createdSessions = new Set(); // session ids created by this instance

async function waitHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) {
      throw Object.assign(new Error(`opencode exited with code ${child.exitCode} during startup`), {
        status: 500,
        hint: "startup",
      });
    }
    try {
      const res = await fetch(`${INTERNAL_BASE}/global/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw Object.assign(new Error("timed out waiting for opencode to become healthy"), { status: 500, hint: "startup" });
}

function ensureOpencode() {
  if (childReady && child && child.exitCode == null) return Promise.resolve();
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    if (!existsSync(BINARY)) {
      throw Object.assign(
        new Error("opencode binary not found next to handler.js — run scripts/build-function.sh first"),
        { status: 500, hint: "binary" }
      );
    }
    const dataHome = process.env.OPENCODE_DATA_HOME || path.join(process.env.HOME || "/tmp", ".opencode-scw");
    mkdirSync(dataHome, { recursive: true });
    const workspace = process.env.OPENCODE_WORKSPACE || path.join(dataHome, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configDir = path.join(dataHome, "config");
    mkdirSync(configDir, { recursive: true });

    // Credentials: write opencode's auth.json (Global.Path.data/auth.json —
    // dataHome is used as HOME, see env below). `opencode auth login` for the
    // Zen provider stores exactly this shape: { opencode: { type: "api", key } }.
    // This is how the REAL opencode authenticates to the LLM provider — the
    // proxy never sees or forwards this key to anything but opencode itself.
    const authPath = path.join(dataHome, "auth.json");
    if (process.env.OPENCODE_AUTH_JSON) {
      // Advanced escape hatch: full auth.json override (any provider).
      writeFileSync(authPath, process.env.OPENCODE_AUTH_JSON);
    } else if (ZEN_API_KEY) {
      writeFileSync(authPath, JSON.stringify({ opencode: { type: "api", key: ZEN_API_KEY } }));
    } else {
      console.warn("[opencode-scw] OPCODE_ZEN_API_KEY is not set — opencode has no LLM credentials");
    }

    const env = {
      ...process.env,
      HOME: dataHome,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || JSON.stringify(DEFAULT_PERMISSIONS),
      NO_COLOR: "1",
    };

    console.log(`[opencode-scw] spawning opencode web on 127.0.0.1:${INTERNAL_PORT} (workspace: ${workspace})`);
    child = spawn(BINARY, ["web", "--hostname", "127.0.0.1", "--port", String(INTERNAL_PORT)], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => console.log("[opencode]", String(d).trimEnd()));
    child.stderr.on("data", (d) => console.error("[opencode]", String(d).trimEnd()));
    child.on("exit", (code, sig) => {
      childReady = false;
      spawnPromise = null;
      child = null;
      console.error(`[opencode-scw] opencode exited code=${code} signal=${sig}`);
    });

    await waitHealth();
    childReady = true;
  })();
  return spawnPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function ocFetch(route, { method = "GET", body, signal, timeout } = {}) {
  const res = await fetch(INTERNAL_BASE + route, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeout ? AbortSignal.timeout(timeout) : signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

function getHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v);
  }
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  };
}

function parseJsonBody(req) {
  if (!req.body || req.body.length === 0) return null;
  if (req.body.length > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("request body too large"), { status: 413 });
  }
  try {
    return JSON.parse(req.body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Output adapters (collecting for functions, live for servers)
// ---------------------------------------------------------------------------
function createCollectingOut() {
  const chunks = [];
  let meta = null;
  return {
    start(m) {
      meta = m;
    },
    write(c) {
      chunks.push(c);
    },
    end() {},
    result() {
      const headers = { ...meta.headers };
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      return { statusCode: meta.status, headers, body: chunks.join(""), isBase64Encoded: false };
    },
  };
}

function createServerOut(res) {
  let started = false;
  return {
    start(m) {
      if (!started) {
        started = true;
        res.writeHead(m.status, m.headers);
      }
    },
    write(c) {
      if (!started) this.start({ status: 200, headers: { "Content-Type": "text/plain" } });
      res.write(c);
    },
    end() {
      if (!started) {
        started = true;
        res.writeHead(200, { "Content-Type": "application/json" });
      }
      res.end();
    },
  };
}

function outJson(out, status, json, extraHeaders = {}) {
  out.start({ status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } });
  out.write(JSON.stringify(json));
  out.end();
}

function outError(out, status, type, message, hint) {
  const err = { error: { message: message || "Something went wrong", type: type || "internal_error", code: status } };
  if (hint) err.error.hint = hint;
  return outJson(out, status, err);
}

function opencodeError(out, status, json) {
  const raw =
    json && typeof json === "object"
      ? json.message || (json.error && json.error.message)
      : null;
  const msg = raw || `opencode server error (${status})`;
  return outError(out, status >= 200 && status < 500 ? status : 502, "opencode_error", msg);
}

// ---------------------------------------------------------------------------
// OpenAI <-> opencode translation
// ---------------------------------------------------------------------------
function extractText(m) {
  if (m == null) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "image_url" || p.type === "input_image") return "[image]";
          return "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatHistoryMessage(m) {
  const role = m.role || "user";
  if (role === "tool") return `--- tool result ---\n${extractText(m)}`;
  if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const calls = m.tool_calls
      .map((tc) => {
        const fn = (tc && tc.function) || {};
        return `${fn.name || "function"}(${fn.arguments || ""})`;
      })
      .join("\n");
    return `--- assistant (tool calls) ---\n${calls}${m.content ? `\n\n${extractText(m)}` : ""}`;
  }
  return `--- ${role} ---\n${extractText(m)}`;
}

function buildParts(messages, isNew) {
  const parts = [];
  if (isNew && messages.length > 1) {
    const history = messages.slice(0, -1);
    const transcript = history.map(formatHistoryMessage).join("\n\n");
    parts.push({
      type: "text",
      text:
        "You are continuing an existing conversation as the assistant. The transcript below is the " +
        "conversation history so far; the final message of this request is the user's current prompt. " +
        "Respond to that prompt as a continuation of this conversation.\n\n" +
        transcript,
    });
  }
  const last = messages[messages.length - 1];
  parts.push({ type: "text", text: extractText(last) });
  return parts;
}

/**
 * Map an OpenAI `model` string to opencode's `{ providerID, modelID }` object
 * (the shape opencode's /session/:id/message endpoint validates).
 *
 *   "opencode/gpt-5.5" -> { providerID: "opencode", modelID: "gpt-5.5" }
 *   "gpt-5.5"         -> { providerID: <default provider>, modelID: "gpt-5.5" }
 *   "opencode"/"default"/"auto" -> null (let opencode pick its default)
 */
async function resolveModel(requested) {
  if (!requested) return null;
  const id = String(requested).trim();
  if (!id || id === "opencode" || id === "default" || id === "auto") return null;
  const idx = id.indexOf("/");
  if (idx > 0) {
    const providerID = id.slice(0, idx);
    const modelID = id.slice(idx + 1);
    if (providerID && modelID) return { providerID, modelID };
    return null;
  }
  const def = await getDefaultModel();
  if (def && def.providerID) return { providerID: def.providerID, modelID: id };
  return null;
}

function extractTextParts(parts, type) {
  return (parts || [])
    .filter((p) => p && p.type === type && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function extractTokens(info, parts) {
  const t = (info && (info.tokens || info.usage)) || {};
  const input = Number(t.input || t.prompt_tokens || 0);
  const output = Number(t.output || t.completion_tokens || 0);
  const total = Number(t.total || t.total_tokens || input + output);
  return { input, output, total };
}

function toCompletion(requestedModel, msgJson, sessionId) {
  const { info, parts } = msgJson || {};
  const text = extractTextParts(parts, "text");
  const reasoning = extractTextParts(parts, "reasoning");
  const tokens = extractTokens(info, parts);
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: now(),
    model: requestedModel || "opencode",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length ? text : null,
          reasoning_content: reasoning.length ? reasoning : undefined,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.total },
    x_opencode_session: sessionId,
  };
}

async function cleanupSession(sessionId, isNew) {
  if (!isNew) return; // reused sessions belong to the client
  if (KEEP_SESSIONS) return;
  createdSessions.delete(sessionId);
  ocFetch(`/session/${sessionId}`, { method: "DELETE", timeout: 10_000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
// Cache of { providerID, modelID } resolved from opencode's /config/providers.
let defaultModelCache = null;
let defaultModelCacheAt = 0;

async function getDefaultModel() {
  if (defaultModelCache && Date.now() - defaultModelCacheAt < 60_000) return defaultModelCache;
  try {
    const { status, json } = await ocFetch("/config/providers", { timeout: 15_000 });
    if (status === 200 && json && json.default && typeof json.default === "object") {
      const k = Object.keys(json.default)[0];
      if (k && json.default[k]) {
        defaultModelCache = { providerID: k, modelID: json.default[k] };
        defaultModelCacheAt = Date.now();
        return defaultModelCache;
      }
    }
  } catch (e) {
    console.error("[opencode-scw] failed to read default model:", e.message);
  }
  return defaultModelCache || null;
}

async function handleModels(out) {
  await ensureOpencode();
  const data = [];
  let defaultModel = null;
  try {
    const { status, json } = await ocFetch("/config/providers", { timeout: 15_000 });
    if (status === 200 && json && Array.isArray(json.providers)) {
      // NOTE: `models` is a Record keyed by model id (not an array).
      for (const p of json.providers) {
        for (const m of Object.values(p.models || {})) {
          if (m && typeof m === "object" && m.id) {
            data.push({ id: `${p.id}/${m.id}`, object: "model", owned_by: p.id, created: 0 });
          }
        }
      }
      const def = await getDefaultModel();
      if (def) defaultModel = `${def.providerID}/${def.modelID}`;
    }
  } catch (e) {
    console.error("[opencode-scw] failed to list providers:", e.message);
  }
  if (process.env.OPENCODE_MODELS_CSV) {
    for (const id of process.env.OPENCODE_MODELS_CSV.split(",").map((s) => s.trim()).filter(Boolean)) {
      data.push({ id, object: "model", owned_by: "custom", created: 0 });
    }
  }
  data.unshift({ id: "opencode", object: "model", owned_by: "opencode", created: 0 });
  if (defaultModel) data.unshift({ id: defaultModel, object: "model", owned_by: "opencode", created: 0 });
  return outJson(out, 200, { object: "list", data });
}

async function handleChat(req, out) {
  const body = parseJsonBody(req);
  if (!body || typeof body !== "object") {
    return outError(out, 400, "invalid_request_error", "Request body must be a JSON object");
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return outError(out, 400, "invalid_request_error", "messages is required and must be a non-empty array");
  }
  await ensureOpencode();

  const stream = body.stream === true;
  const requestedModel = typeof body.model === "string" && body.model ? body.model : null;

  // Resolve session: reuse if the client passes a known session id
  const headerSession = getHeader(req.headers, "x-opencode-session");
  let sessionId = typeof body.session_id === "string" ? body.session_id : headerSession;
  const isNew = !(sessionId && createdSessions.has(sessionId));
  if (isNew) {
    const titleText = extractText(messages[messages.length - 1]).slice(0, 80) || "opencode session";
    const { status, json } = await ocFetch("/session", { method: "POST", body: { title: titleText } });
    if (status !== 200) return opencodeError(out, status, json);
    sessionId = json.id;
    createdSessions.add(sessionId);
  }

  const parts = buildParts(messages, isNew);
  const ocModel = await resolveModel(requestedModel);
  const payload = { parts, ...(ocModel ? { model: ocModel } : {}) };

  if (stream) {
    return handleStreamingChat(req, out, sessionId, payload, requestedModel, isNew);
  }

  const { status, json } = await ocFetch(`/session/${sessionId}/message`, {
    method: "POST",
    body: payload,
    signal: req.signal,
  });
  if (status !== 200) {
    cleanupSession(sessionId, isNew);
    return opencodeError(out, status, json);
  }
  const completion = toCompletion(requestedModel, json, sessionId);
  cleanupSession(sessionId, isNew);
  return outJson(out, 200, completion, { "x-opencode-session": sessionId });
}

// --- Streaming ---------------------------------------------------------------
class SseSession {
  constructor(out, base) {
    this.out = out;
    this.base = base;
    this.started = false;
    this.roleSent = false;
  }
  start() {
    if (!this.started) {
      this.started = true;
      this.out.start({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...corsHeaders(),
        },
      });
    }
  }
  write(s) {
    this.start();
    if (!this.roleSent) {
      this.roleSent = true;
      this.out.write(`data: ${JSON.stringify({ ...this.base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    }
    this.out.write(s);
  }
  end() {
    this.start();
    this.out.end();
  }
}

function flushDelta(sse, state, full, field) {
  if (typeof full !== "string" || full.length <= state.emitted.length) return;
  const delta = full.slice(state.emitted.length);
  state.emitted = full;
  if (!delta) return;
  sse.write(`data: ${JSON.stringify({ ...sse.base, choices: [{ index: 0, delta: { [field]: delta }, finish_reason: null }] })}\n\n`);
}

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

async function handleStreamingChat(req, out, sessionId, payload, requestedModel, isNew) {
  const base = {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion.chunk",
    created: now(),
    model: requestedModel || "opencode",
  };
  const sse = new SseSession(out, base);
  const textState = { emitted: "" };
  const reasoningState = { emitted: "" };

  // Open opencode's event bus first so we catch incremental parts live.
  const eventCtrl = new AbortController();
  let eventLoop = Promise.resolve();
  try {
    const evtRes = await fetch(`${INTERNAL_BASE}/event`, { signal: eventCtrl.signal });
    if (evtRes.ok && evtRes.body) {
      eventLoop = consumeEvents(evtRes, sessionId, textState, reasoningState, sse).catch((e) =>
        console.error("[opencode-scw] event loop error:", e.message)
      );
    }
  } catch {
    /* event bus unavailable — fall back to buffered SSE below */
  }

  let msgRes;
  try {
    msgRes = await ocFetch(`/session/${sessionId}/message`, {
      method: "POST",
      body: payload,
      signal: req.signal,
    });
  } catch (e) {
    eventCtrl.abort();
    cleanupSession(sessionId, isNew);
    if (e && e.name === "AbortError") return; // client disconnected
    return outError(out, 502, "opencode_error", e.message);
  }

  if (msgRes.status !== 200) {
    eventCtrl.abort();
    cleanupSession(sessionId, isNew);
    if (sse.started) {
      // We already streamed something — emit the error as an SSE event.
      sse.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `\n[error] ${(msgRes.json && msgRes.json.message) || msgRes.status}` }, finish_reason: null }] })}\n\n`);
      sse.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      sse.write("data: [DONE]\n\n");
      sse.end();
      return;
    }
    return opencodeError(out, msgRes.status, msgRes.json);
  }

  // Flush whatever live events missed, then finish.
  const { info, parts } = msgRes.json || {};
  flushDelta(sse, textState, extractTextParts(parts, "text"), "content");
  flushDelta(sse, reasoningState, extractTextParts(parts, "reasoning"), "reasoning_content");
  sse.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  sse.write("data: [DONE]\n\n");
  sse.end();

  eventCtrl.abort();
  await eventLoop;
  cleanupSession(sessionId, isNew);
}

// opencode /event SSE events are shaped { type, properties: { ... } }.
// Relevant types: "message.part.updated" (properties.part) and
// "permission.asked" (properties = { sessionID, id, permission, patterns }).
async function consumeEvents(res, sessionId, textState, reasoningState, sse) {
  for await (const data of sseLines(res)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const props = ev.properties;
    if (!props || typeof props !== "object") continue;
    if (props.sessionID && props.sessionID !== sessionId) continue;
    if (ev.type === "message.part.updated" && props.part && typeof props.part === "object") {
      const part = props.part;
      if (part.type === "text" && typeof part.text === "string") {
        flushDelta(sse, textState, part.text, "content");
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        flushDelta(sse, reasoningState, part.text, "reasoning_content");
      }
    }
    if (AUTO_APPROVE && ev.type === "permission.asked" && props.id) {
      ocFetch(`/session/${sessionId}/permissions/${props.id}`, {
        method: "POST",
        body: { response: "allow", remember: true },
        timeout: 10_000,
      }).catch(() => {});
    }
  }
}

// --- Raw proxy (opencode web UI + native API) ---------------------------------
async function proxyRaw(req, url, out) {
  await ensureOpencode();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = String(k).toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(key)) continue;
    headers[key] = String(v);
  }
  const res = await fetch(INTERNAL_BASE + url.pathname + url.search, {
    method: req.method,
    headers,
    body: req.body || undefined,
    signal: req.signal,
  });
  const ctype = res.headers.get("content-type") || "application/octet-stream";
  out.start({ status: res.status, headers: { "Content-Type": ctype, ...corsHeaders() } });
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(decoder.decode(value, { stream: true }));
    }
  }
  out.end();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function isV1Path(p) {
  return (
    p === "/v1" ||
    p.startsWith("/v1/") ||
    p === "/models" ||
    p === "/chat/completions"
  );
}

function authorized(req) {
  if (!PROXY_API_KEY) return true;
  const auth = getHeader(req.headers, "authorization") || "";
  return auth === `Bearer ${PROXY_API_KEY}`;
}

async function dispatch(req, out) {
  const url = new URL(req.url, "http://internal");
  const pathname = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    out.start({ status: 204, headers: corsHeaders() });
    out.end();
    return;
  }

  if (!isV1Path(pathname)) return proxyRaw(req, url, out);

  if (!authorized(req)) return outError(out, 401, "invalid_request_error", "Invalid API key");

  if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) return handleModels(out);
  if (method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    return handleChat(req, out);
  }
  if (pathname === "/v1/health" || pathname === "/health") {
    return outJson(out, 200, { status: "ok", service: "opencode-proxy" });
  }
  return outError(out, 404, "invalid_request_error", `Unknown endpoint ${pathname}`);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
function eventToRequest(event) {
  let body = null;
  if (event.body != null && event.body !== "") {
    body = Buffer.from(String(event.body), event.isBase64Encoded ? "base64" : "utf8");
  }
  let url = event.path || "/";
  const qs = event.queryStringParameters || {};
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) search.append(k, v == null ? "" : String(v));
  const q = search.toString();
  if (q && !url.includes("?")) url += `?${q}`;
  return {
    method: (event.httpMethod || "GET").toUpperCase(),
    url,
    headers: event.headers || {},
    body,
  };
}

async function handle(event, context) {
  try {
    const out = createCollectingOut();
    await dispatch(eventToRequest(event), out);
    return out.result();
  } catch (e) {
    console.error("[opencode-scw] handler error:", e);
    return {
      statusCode: e.status || 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message: e.message || "Internal error", type: "internal_error", code: e.status || 500 },
      }),
    };
  }
}

module.exports = { handle };

// Standalone mode (local dev only — scripts/dev.mjs). This is never used for
// deployment: production is the Scaleway Serverless Function handler above.
if (process.env.PORT) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const out = createServerOut(res);
    try {
      await dispatch(
        { method: req.method || "GET", url: req.url || "/", headers: req.headers, body: body.length ? body : null, signal: ac.signal },
        out
      );
    } catch (e) {
      console.error("[opencode-scw] request error:", e);
      try {
        if (!res.headersSent) outError(out, 500, "internal_error", e.message);
        else res.end();
      } catch {
        /* ignore */
      }
    }
  });
  server.listen(Number(process.env.PORT), "0.0.0.0", () =>
    console.log(`[opencode-scw] standalone server listening on 0.0.0.0:${process.env.PORT}`)
  );
}
