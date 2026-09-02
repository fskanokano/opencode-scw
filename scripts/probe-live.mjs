#!/usr/bin/env node
/**
 * Deno Deploy 线上验收（spec §11 第 5 条）。
 *
 * 用法：node scripts/probe-live.mjs [base-url]
 *   base-url 默认 https://opencode-scw.fskanokano.deno.net
 *
 * 五关：
 *   L1 鉴权门（无凭据 401 / 错凭据 401 / 对凭据 200）
 *   L2 /v1/models 载荷形状
 *   L3 非流式 chat（JSON 完整响应 + tokens）
 *   L4 流式 chat（SSE 帧序 role→delta→stop→[DONE]，多帧真流式）
 *   L5 多轮续聊（同 x-session-id 第二轮回忆第一轮暗号）
 *
 * 凭据：只从 .env / .env.local 内存加载使用，绝不打印。
 */

import { readFileSync } from "node:fs"

const BASE = (process.argv[2] || "https://opencode-scw.fskanokano.deno.net").replace(/\/$/, "")
const MODEL = process.env.OPENCODE_DEFAULT_MODEL || "opencode/big-pickle"

// ---- 凭据加载（内存，不打印）----
function loadEnv(file) {
  let raw
  try {
    raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  } catch {
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#|^\s*$/.test(line)) continue
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2]
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    process.env[m[1]] = v
  }
}
loadEnv(".env.local")
loadEnv(".env")

const KEY = process.env.PROXY_API_KEY || ""
if (!KEY) {
  console.error("❌ 未找到 PROXY_API_KEY（.env / .env.local 均未提供），无法验收")
  process.exit(1)
}

let pass = 0
let fail = 0
function ok(name, cond, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS ${name}${detail ? " — " + detail : ""}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`)
  }
}

function authHeaders() {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" }
}

async function timedFetch(path, init = {}, timeoutMs = 120_000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal })
    return { res, ms: Date.now() - started }
  } finally {
    clearTimeout(t)
  }
}

// ---- L1 鉴权门 ----
async function l1Auth() {
  console.log("\n[L1] 鉴权门（fail-closed）")
  const a = await timedFetch("/v1/health")
  ok("无凭据 → 401", a.res.status === 401, `实际 ${a.res.status}`)

  const b = await timedFetch("/v1/health", { headers: { authorization: "Bearer wrong-" + Date.now() } })
  ok("错凭据 → 401", b.res.status === 401, `实际 ${b.res.status}`)

  const c = await timedFetch("/v1/health", { headers: authHeaders() })
  let healthy = c.res.status === 200
  if (healthy) {
    const body = await c.res.json().catch(() => null)
    healthy = Boolean(body && (body.healthy === true || body.ok === true || body.status === "ok"))
  }
  ok("对凭据 → 200 healthy", healthy, `实际 ${c.res.status}，${c.ms}ms`)
}

// ---- L2 /v1/models ----
async function l2Models() {
  console.log("\n[L2] /v1/models")
  const { res, ms } = await timedFetch("/v1/models", { headers: authHeaders() })
  ok("HTTP 200", res.status === 200, `实际 ${res.status}，${ms}ms`)
  if (res.status !== 200) return
  const data = await res.json().catch(() => null)
  const ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
  ok("object=list 且 data 非空", data?.object === "list" && ids.length > 0, `${ids.length} 个模型`)
  ok("模型 id 为 provider/model 形状", ids.length > 0 && ids.every((id) => typeof id === "string" && id.includes("/")))
  console.log(`  样例: ${ids.slice(0, 3).join(", ")}`)
}

// ---- L3 非流式 ----
async function l3NonStream() {
  console.log("\n[L3] 非流式 chat/completions")
  const body = {
    model: MODEL,
    stream: false,
    messages: [{ role: "user", content: "只回复两个字：在线" }],
  }
  const { res, ms } = await timedFetch(
    "/v1/chat/completions",
    { method: "POST", headers: authHeaders(), body: JSON.stringify(body) },
    180_000,
  )
  ok("HTTP 200", res.status === 200, `实际 ${res.status}，${ms}ms`)
  if (res.status !== 200) {
    console.log("  响应:", (await res.text().catch(() => "")).slice(0, 300))
    return
  }
  const data = await res.json().catch(() => null)
  const text = data?.choices?.[0]?.message?.content
  ok("choices[0].message.content 非空", typeof text === "string" && text.length > 0, `「${String(text || "").slice(0, 40)}」`)
  ok("finish_reason=stop", data?.choices?.[0]?.finish_reason === "stop")
  const usage = data?.usage
  ok("usage.tokens 存在", Boolean(usage && typeof usage === "object" && Object.keys(usage).length > 0), JSON.stringify(usage || {}).slice(0, 80))
}

// ---- L4 流式 ----
async function l4Stream() {
  console.log("\n[L4] 流式 chat/completions（真流式帧序）")
  const body = {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
  }
  const { res, ms } = await timedFetch(
    "/v1/chat/completions",
    { method: "POST", headers: authHeaders(), body: JSON.stringify(body) },
    180_000,
  )
  ok("HTTP 200 + text/event-stream", res.status === 200 && (res.headers.get("content-type") || "").includes("text/event-stream"), `实际 ${res.status} ${res.headers.get("content-type")}`)
  if (res.status !== 200 || !res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let frames = 0
  let sawRole = false
  let sawDelta = false
  let sawStop = false
  let sawDone = false
  let sawUsage = false
  let text = ""
  let firstFrameMs = -1
  const started = Date.now()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstFrameMs < 0) firstFrameMs = Date.now() - started
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
      if (!data) continue
      if (data === "[DONE]") {
        sawDone = true
        continue
      }
      let ev
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      frames++
      const choice = ev?.choices?.[0]
      if (choice?.delta?.role === "assistant") sawRole = true
      const piece = choice?.delta?.content
      if (typeof piece === "string" && piece) {
        sawDelta = true
        text += piece
      }
      if (choice?.finish_reason === "stop") sawStop = true
      if (ev?.usage && Array.isArray(ev?.choices) && ev.choices.length === 0) sawUsage = true
    }
  }

  ok("SSE 帧数 > 3（真流式多帧）", frames > 3, `${frames} 帧，首帧 ${firstFrameMs}ms，总 ${ms}ms`)
  ok("role 帧", sawRole)
  ok("content delta 帧", sawDelta, `累计 ${text.length} 字`)
  ok("finish_reason=stop 帧", sawStop)
  ok("usage 帧（include_usage）", sawUsage)
  ok("[DONE] 收尾", sawDone)
}

// ---- L5 多轮 ----
const SECRET = "菠萝-" + Math.random().toString(36).slice(2, 8)
async function chat(messages, sessionId) {
  const { res } = await timedFetch(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: { ...authHeaders(), "x-session-id": sessionId },
      body: JSON.stringify({ model: MODEL, stream: false, messages }),
    },
    180_000,
  )
  if (res.status !== 200) return { status: res.status, text: "" }
  const data = await res.json().catch(() => null)
  return { status: res.status, text: String(data?.choices?.[0]?.message?.content || "") }
}

async function l5Multiturn() {
  console.log("\n[L5] 多轮续聊（x-session-id 上下文锚定）")
  const sid = "live-" + Date.now()
  const r1 = await chat(
    [{ role: "user", content: `请记住这个暗号：${SECRET}。只回复：已记住` }],
    sid,
  )
  ok("第一轮 200", r1.status === 200, `「${r1.text.slice(0, 30)}」`)

  const r2 = await chat(
    [{ role: "user", content: "我刚才告诉你的暗号是什么？只回复暗号本身。" }],
    sid,
  )
  ok("第二轮 200", r2.status === 200)
  ok("第二轮准确回忆暗号", r2.text.includes(SECRET), `回答「${r2.text.slice(0, 60)}」期望含「${SECRET}」`)
}

// ---- 主流程 ----
console.log(`目标: ${BASE}`)
console.log(`模型: ${MODEL}`)
try {
  await l1Auth()
  await l2Models()
  await l3NonStream()
  await l4Stream()
  await l5Multiturn()
} catch (e) {
  fail++
  console.error("\n验收脚本异常:", (e && e.message) || e)
}

console.log(`\n========== 结果: ${pass} PASS / ${fail} FAIL ==========`)
process.exit(fail > 0 ? 1 : 0)
