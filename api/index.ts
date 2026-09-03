/**
 * Vercel 入口（spec docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md §2/§5）：
 * 进程内 opencode + OpenAI 翻译层 + 全接口透传（自 deno/main.ts 逐函数移植）。
 *
 * 与 Node 常驻形态（handler.js）的职责对应：
 *   - checkAuth            → src/proxy.js checkAuth 语义复刻（Bearer 单门制）
 *   - handleModels         → 进程内 /config/providers → OpenAI list（失败回退静态 ZEN_MODELS）
 *   - handleChat/stream    → 翻译层复用（extractUserPrompt/mapVariant/sessionKeyFor/stripEcho）
 *                            + server/stream.js 真流式（对齐 src/proxy.js streamChat 状态机）
 *   - 其余路径              → engine.fetch(req) 原样透传（对齐 src/bridge.js forwardStream）
 *
 * 单门制（spec §5）：进程内 app.fetch 外部不可达，只有 PROXY_API_KEY 一道门；
 * Node 形态的内部 Basic 双门在 Vercel 路径不存在。
 */

// CJS 纯函数模块用静态命名导入（Node CJS-ESM 互操作 + esbuild 双兼容）。
// 不要用 createRequire(import.meta.url)：Vercel 把本文件按 CJS 格式打包时
// import.meta 为空，模块加载即崩（线上曾因此全路由 500 FUNCTION_INVOCATION_FAILED）。
// 依赖一律指向 .js 文件：Vercel（@vercel/node）编译本文件为 CJS 时 import 说明符
// 原样保留（不改写 .ts 扩展名），而 nft 只复制 .js 产物 —— .ts 路径会在运行时
// MODULE_NOT_FOUND，函数加载即崩（FUNCTION_INVOCATION_FAILED）。
import { normalizeModel, modelsPayload } from "../src/zen-models.js"
import { extractUserPrompt } from "../src/proxy.js"
import { mapVariant, extractTokens } from "../src/opencode.js"

import { bootUptimeSec, engineFetch, engineReady, ensureEngine, memorySnapshot } from "../server/engine.js"
import { SSE_HEADERS, createSseWriter, sseLines } from "../server/stream.js"

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-session-id",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
} as const

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host",
])

// ---- OpenAI 风格错误 ----
type Json = Record<string, unknown>

function jsonError(status: number, message: string, type = "invalid_request_error"): Response {
  return new Response(
    JSON.stringify({ error: { message, type, param: null, code: null } }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    },
  )
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  })
}

// ---- 鉴权（对齐 src/proxy.js checkAuth：Bearer PROXY_API_KEY，fail closed）----
function checkAuth(headers: Headers): { allowed: boolean; message: string } {
  const expected = process.env.PROXY_API_KEY
  if (!expected) return { allowed: false, message: "PROXY_API_KEY 未配置" }
  const auth = (headers.get("authorization") || "").trim()
  if (/^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, "").trim()
    return token === expected
      ? { allowed: true, message: "" }
      : { allowed: false, message: "无效的 Bearer 凭据" }
  }
  return { allowed: false, message: "缺少或无效的 Authorization" }
}

// ---- 会话锚定（对齐 src/proxy.js sessionKeyFor：首条 user 消息做锚点）----
const sessions = new Map<string, string>()

function sessionKeyFor(messages: unknown[]): string {
  let anchor: string | null = null
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown } | null
    if (msg && msg.role === "user" && msg.content != null) {
      anchor = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
      break
    }
  }
  const raw = anchor !== null ? anchor : JSON.stringify(messages)
  let h = 0
  for (let i = 0; i < 1024 && i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0
  }
  return "s" + (h >>> 0).toString(16).padStart(8, "0")
}

// ---- 透传响应头重建（对齐 src/bridge.js responseHeaders）----
function responseHeaders(upstream: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of upstream.entries()) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key) || key.startsWith("proxy-") || key === "content-length" ||
        key === "content-encoding" || key === "vary" || key === "etag") continue
    out.set(key, v)
  }
  for (const [k, v] of Object.entries(CORS)) out.set(k, v)
  return out
}

// ---- /v1/models（对齐 src/proxy.js handleModels）----
async function handleModels(): Promise<Response> {
  try {
    const res = await engineFetch("/config/providers")
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        providers?: Array<{ id?: string; models?: Record<string, { id?: string }> }>
        default?: Record<string, unknown>
      } | null
      const models: Array<{ id: string; object: string; created: number; owned_by: string }> = []
      if (data && Array.isArray(data.providers)) {
        const created = Math.floor(Date.now() / 1000)
        for (const p of data.providers) {
          if (!p || typeof p !== "object") continue
          for (const m of Object.values(p.models || {})) {
            if (m && typeof m === "object" && m.id) {
              models.push({ id: `${p.id}/${m.id}`, object: "model", created, owned_by: p.id || "opencode" })
            }
          }
        }
        if (models.length) return jsonResponse({ object: "list", data: models })
      }
    }
  } catch {
    /* fall through to static list */
  }
  return jsonResponse(modelsPayload())
}

// ---- /v1/chat/completions ----
type ChatBody = {
  model?: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  messages?: unknown[]
}

// 引擎把 provider 级失败放在 message.info.error（形如 { name: "APIError", data: { message } }），
// 也有直接 { message } 的形态；统一提取人类可读消息。
function engineErrorMessage(info: unknown): string | null {
  if (!info || typeof info !== "object") return null
  const e = (info as { error?: { message?: string; data?: { message?: string } } }).error
  if (!e) return null
  const m = e.message || (e.data && e.data.message)
  return (m && String(m).trim()) || null
}

function completionId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return "chatcmpl-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function parseModelPair(model: string): { providerID: string; modelID: string } {
  const raw = String(model || "")
  const idx = raw.indexOf("/")
  return idx > 0
    ? { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) }
    : { providerID: "opencode", modelID: raw }
}

// 复读裁剪状态机（对齐 src/proxy.js flushState 的 skip 逻辑）
type PartState = { type: string; acc: string; emitted: number; skip: number | null }

async function handleChat(req: Request, reqBody: ChatBody): Promise<Response> {
  if (!reqBody || typeof reqBody !== "object" || !Array.isArray(reqBody.messages) || !reqBody.messages.length) {
    return jsonError(400, "请求体需要包含非空 messages 字段")
  }

  const requestedModel = reqBody.model || process.env.OPENCODE_DEFAULT_MODEL || "gpt-5.6-luna"
  const model = normalizeModel(requestedModel)
  const variant = mapVariant(reqBody as unknown as Record<string, unknown>)
  const { prompt, system, fileParts } = extractUserPrompt(reqBody.messages)
  if (!prompt && !(fileParts && fileParts.length)) {
    return jsonError(400, "没有找到可用的用户消息文本或图片")
  }

  const clientKey =
    (req.headers.get("x-session-id") || "").trim() || sessionKeyFor(reqBody.messages)
  let sessionID = sessions.get(clientKey) || null

  const base = {
    id: completionId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
  }

  // 增量状态机（对齐 src/proxy.js streamChat：partID → 累积/emitted/skip）
  const partStates = new Map<string, PartState>()
  // 客户端断连（reader.cancel）→ abort 上游消息请求（对齐 src/bridge.js res.on("close")）。
  // fluid compute per-path cancellation 会触发 request.signal abort，但流已提交后
  // 信号语义因运行时而异；ReadableStream.cancel 才是跨运行时可靠的断连信号。
  const clientGone = new AbortController()
  const sse = createSseWriter(base as unknown as Record<string, unknown>, {
    onCancel: () => clientGone.abort(),
  })

  function flushState(s: PartState): void {
    const u = String(prompt || "").trim()
    if (s.type === "text" && s.skip === null) {
      // 前缀未定：攒到 >= 问题长度再判定（复读前缀裁剪）
      if (!u) s.skip = 0
      else if (s.acc.length >= u.length) s.skip = s.acc.startsWith(u) ? u.length : 0
      else return
    }
    const full = s.acc.slice(s.skip ?? 0)
    if (full.length <= s.emitted) return
    const delta = full.slice(s.emitted)
    s.emitted = full.length
    if (delta) sse.chunk(s.type === "reasoning" ? "reasoning_content" : "content", delta)
  }

  function pushUpdate(partID: string, type: string, fullText: string): void {
    let s = partStates.get(partID)
    if (!s) {
      s = { type, acc: "", emitted: 0, skip: null }
      partStates.set(partID, s)
    }
    s.type = type
    if (fullText.length > s.acc.length) s.acc = fullText
    flushState(s)
  }

  // /event 订阅句柄（收尾用 body.cancel()，vendor 冒烟验证过的安全路径）
  let evtRes: Response | null = null

  function stopEventLoop(): void {
    const r = evtRes
    evtRes = null
    if (r && r.body) r.body.cancel().catch(() => {})
  }

  // 事件订阅（对齐 src/proxy.js streamChat：/event 总线 → 增量转发）
  async function startEventLoop(): Promise<void> {
    try {
      const res = await engineFetch("/event")
      if (!res.ok || !res.body) return
      evtRes = res
      void (async () => {
        for await (const data of sseLines(res)) {
          let ev: Json | null = null
          try {
            ev = JSON.parse(data)
          } catch {
            continue
          }
          if (!ev || typeof ev !== "object") continue
          const props = ev.properties as Json | undefined
          if (!props || typeof props !== "object") continue
          if (props.sessionID && props.sessionID !== sessionID) continue
          if (ev.type === "message.part.updated" && props.part && typeof props.part === "object") {
            const part = props.part as { id?: string; type?: string; text?: unknown }
            if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.id) {
              pushUpdate(part.id, part.type, part.text)
            }
          } else if (ev.type === "message.part.delta" && props.field === "text" && typeof props.delta === "string") {
            // 真增量：直接累加到对应 part 的 acc（delta 事件先于 part.updated 到达时
            // 该 part 尚无状态，按 text 处理——后续 updated 会校正类型与全文）
            const pid = String(props.partID || "")
            if (!pid) continue
            let s = partStates.get(pid)
            if (!s) {
              s = { type: "text", acc: "", emitted: 0, skip: null }
              partStates.set(pid, s)
            }
            s.acc += props.delta
            flushState(s)
          } else if (ev.type === "permission.asked" && props.id && process.env.OPENCODE_AUTO_APPROVE !== "false") {
            // 自动放行 agent 工具权限（调用方已通过 PROXY_API_KEY 鉴权）
            engineFetch(
              `/session/${encodeURIComponent(String(sessionID))}/permissions/${props.id}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                // bundle schema：payload = { response: "once"|"always"|"reject" }。
                // （之前误发 { response: "allow", remember: true }：字段名对但枚举值
                //  非法（allow 不在 once/always/reject 中），schema 校验失败 → 400 →
                //  agent 永远等权限 → message POST 永不返回 → 客户端零帧卡死；
                //  "once" = 本次放行，"always" = 记住放行）
                body: JSON.stringify({ response: "once" }),
              },
            )
              .then((r) => {
                // 放行失败会让 agent 一直等权限 → 客户端零帧卡死；不能静默吞掉
                if (!r.ok) console.error(`[api] 权限自动放行失败: HTTP ${r.status}`)
              })
              .catch((e) => console.error(`[api] 权限自动放行失败: ${String((e as Error).message || e)}`))
          }
        }
      })().catch((e) => {
        console.error("[api] event loop:", (e as Error).message)
      })
    } catch {
      /* 事件总线不可用，退化为完成后 flush */
    }
  }

  // 先建/复用会话（快路径；此阶段失败仍可返回 JSON 错误而非已提交的 SSE 流）
  try {
    if (!sessionID) {
      const created = await engineFetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: (prompt || "OpenAI proxy session").slice(0, 60) }),
      })
      const createdJson = (await created.json().catch(() => ({}))) as { id?: string; data?: { id?: string } }
      sessionID = createdJson.id || (createdJson.data && createdJson.data.id) || null
      if (!sessionID) throw new Error("opencode 会话创建失败")
    }
    sessions.set(clientKey, sessionID)
    await startEventLoop()
  } catch (err) {
    stopEventLoop()
    return jsonError(502, `opencode 处理失败：${String((err as Error).message || err)}`, "upstream_error")
  }

  const sid = sessionID
  const payload = {
    parts: [{ type: "text", text: prompt }, ...(fileParts || [])],
    model: parseModelPair(model),
    // opencode 原生 system 通道 + variant 思考强度（与 Node 路径协议一致）
    ...(system ? { system } : {}),
    ...(variant ? { variant } : {}),
  }

  // 真流式：先提交 SSE 响应，消息生成在后台推进，/event 增量逐帧推给客户端。
  // 客户端断连 → req.signal abort 上游消息请求（对齐 src/bridge.js res.on("close")）
  void (async () => {
    try {
      const msgRes = await engineFetch(`/session/${encodeURIComponent(sid)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: clientGone.signal,
      })
      if (!msgRes.ok) {
        const j = (await msgRes.json().catch(() => ({}))) as { message?: string; error?: { message?: string } }
        const msg = j.message || (j.error && j.error.message) || `HTTP ${msgRes.status}`
        throw new Error(msg)
      }
      const json = (await msgRes.json().catch(() => null)) as {
        info?: unknown
        parts?: Array<{ id?: string; type?: string; text?: unknown }>
      } | null

      const parts = (json && json.parts) || []

      // 事件可能遗漏（订阅晚于生成），用最终 parts 按 part.id 补齐（状态机天然去重）
      for (const p of parts) {
        if (!p || typeof p.text !== "string") continue
        if ((p.type === "text" || p.type === "reasoning") && p.id) {
          pushUpdate(p.id, p.type, p.text)
        }
      }

      // 引擎把 provider 级失败放在 message.info.error（如 401 No payment method）；
      // 若整轮没产出任何正文，把它透出给客户端，而不是静默返回空回复
      const engineErr = engineErrorMessage(json && json.info)
      const hasText = parts.some(
        (p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0,
      )
      if (engineErr && !hasText) {
        sse.chunk("content", `\n[error] ${engineErr}`)
      }

      // stream_options.include_usage：结尾附真实 token 用量（OpenAI 标准）
      if (reqBody.stream_options && reqBody.stream_options.include_usage && json && json.info) {
        sse.usage(extractTokens(json.info))
      }
      sse.stop()
      sse.done()
    } catch (err) {
      sse.chunk("content", `\n[error] ${String((err as Error).message || err)}`)
      sse.stop()
      sse.done()
      // 客户端断连引发的 AbortError 是正常收尾，不打日志
      if (!(err instanceof Error) || err.name !== "AbortError") {
        console.error(`[api] stream error: ${String((err as Error).message || err)}`)
      }
    } finally {
      await sse.end()
      stopEventLoop()
    }
  })()

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS })
}

// ---- /v1/chat/completions 非流式（对齐 src/proxy.js handleChat 一次成帧）----
async function handleChatNonStream(reqBody: ChatBody, req: Request): Promise<Response> {
  const requestedModel = reqBody.model || process.env.OPENCODE_DEFAULT_MODEL || "gpt-5.6-luna"
  const model = normalizeModel(requestedModel)
  const variant = mapVariant(reqBody as unknown as Record<string, unknown>)
  const { prompt, system, fileParts } = extractUserPrompt(reqBody.messages!)
  if (!prompt && !(fileParts && fileParts.length)) {
    return jsonError(400, "没有找到可用的用户消息文本或图片")
  }

  const clientKey =
    (req.headers.get("x-session-id") || "").trim() || sessionKeyFor(reqBody.messages!)
  let sessionID = sessions.get(clientKey) || null

  async function runOnce(sid: string | null): Promise<Response> {
    if (!sid) {
      const created = await engineFetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: (prompt || "OpenAI proxy session").slice(0, 60) }),
      })
      const cj = (await created.json().catch(() => ({}))) as { id?: string; data?: { id?: string } }
      sid = cj.id || (cj.data && cj.data.id) || null
      if (!sid) throw new Error("opencode 会话创建失败")
      sessions.set(clientKey, sid)
    }
    const payload = {
      parts: [{ type: "text", text: prompt }, ...(fileParts || [])],
      model: parseModelPair(model),
      ...(system ? { system } : {}),
      ...(variant ? { variant } : {}),
    }
    return engineFetch(`/session/${encodeURIComponent(sid)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: req.signal,
    })
  }

  let res: Response
  try {
    res = await runOnce(sessionID)
    // 会话可能失效（实例重启后内存 Map 残留）：重试一次全新会话
    if (!res.ok && sessionID) {
      sessions.delete(clientKey)
      res = await runOnce(null)
    }
  } catch (err) {
    return jsonError(502, `opencode 处理失败：${String((err as Error).message || err)}`, "upstream_error")
  }

  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } }
    const msg = j.message || (j.error && j.error.message) || `HTTP ${res.status}`
    return jsonError(502, `opencode 处理失败：${msg}`, "upstream_error")
  }

  const json = (await res.json().catch(() => ({}))) as {
    info?: unknown
    parts?: Array<{ type?: string; text?: unknown }>
  }
  const parts = json.parts || []
  // 引擎把 provider 级失败放在 message.info.error（如 401 No payment method）；
  // 整轮没有正文时透出真实错误（原来会静默返回空 content 200，客户端无法区分）
  const engineErr = engineErrorMessage(json.info)
  const producedText = parts.some(
    (p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0,
  )
  if (engineErr && !producedText) {
    return jsonError(502, engineErr, "upstream_error")
  }
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()
  const reasoning = parts
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()

  // 复读裁剪（对齐 src/proxy.js finishResult：stripThink + stripEcho）
  const clean = stripEcho(stripThink(text), prompt)
  const cleanReasoning = stripThink(reasoning)

  return jsonResponse({
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: clean,
          ...(cleanReasoning ? { reasoning_content: cleanReasoning } : {}),
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: json.info ? extractTokens(json.info) : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

function stripThink(text: string): string {
  return text
    .replace(/<thinking_effort>[\s\S]*?<\/thinking_effort>\s*/gi, "")
    .trim()
}

function stripEcho(text: string, userText: string): string {
  if (!text || !userText) return text
  const t = text.trimStart()
  const u = String(userText).trim()
  if (!u || !t.startsWith(u)) return text
  const rest = t.slice(u.length).trimStart()
  return rest || ""
}

// ---- 路由（spec §5）----
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // OPTIONS 不鉴权（浏览器预检）
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "content-length": "0" } })
  }

  const auth = checkAuth(req.headers)
  if (!auth.allowed) {
    const r = jsonError(401, auth.message, "authentication_error")
    if (path.startsWith("/v1/")) return r
    // 透传路径带 WWW-Authenticate（对齐 src/bridge.js unauthorized）
    return new Response(r.body, {
      status: 401,
      headers: { ...Object.fromEntries(r.headers.entries()), "www-authenticate": 'Basic realm="opencode"' },
    })
  }

  // /v1/* OpenAI 翻译层
  if (path === "/v1/health" && req.method === "GET") {
    const mem = memorySnapshot()
    return jsonResponse({
      status: "ok",
      engine: engineReady() ? "ready" : "starting",
      memory: {
        rssMB: Math.round(mem.rssMB),
        heapUsedMB: Math.round(mem.heapUsedMB),
        heapTotalMB: Math.round(mem.heapTotalMB),
        externalMB: Math.round(mem.externalMB),
        buffersMB: Math.round(mem.buffersMB),
        limitMB: 2048,
      },
      uptimeSec: bootUptimeSec(),
    })
  }

  if (path === "/v1/models" && req.method === "GET") {
    return handleModels()
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    let reqBody: ChatBody
    try {
      reqBody = await req.json()
    } catch {
      return jsonError(400, "请求体不是合法的 JSON")
    }
    if (reqBody && reqBody.stream === true) return handleChat(req, reqBody)
    return handleChatNonStream(reqBody, req)
  }

  // 其余一切路径 → 进程内引擎原样透传（状态码/头/body 零加工）
  try {
    const upstream = await engineFetch(path + url.search, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      duplex: "half",
    } as RequestInit)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    })
  } catch (err) {
    const msg = String((err as Error).message || err)
    return jsonError(502, `上游转发失败：${msg}`, "upstream_error")
  }
}

// ---- Vercel fetch-export 壳 + 后台预热 ----
// fluid compute：模块加载即后台预热（bundle import + effect runtime 首建 30-48s），
// 实例请求间保活，后续请求直接命中就绪引擎。
void ensureEngine().catch((e) => {
  console.error("[api] 后台引擎预热失败（将由下个请求重试）:", String((e as Error).message || e))
})

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handler(request)
    } catch (err) {
      const msg = String((err as Error).message || err)
      console.error("[api] unhandled:", msg)
      return jsonError(502, msg, "upstream_error")
    }
  },
}

export { handler }
