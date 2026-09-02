#!/usr/bin/env node
/**
 * Task 3 验收：多轮续聊上下文延续 + 客户端断连中止（spec §11.3）。
 *
 * 用法：node scripts/test-multiturn.mjs
 * 自起 `deno run --allow-all deno/main.ts`（DENO_BIN 可覆盖），跑三项断言：
 *   M1 多轮：同一 x-session-id 第二轮能回忆第一轮暗号
 *   M2 断连：流式请求 reader.cancel() → 服务存活且日志无 unhandled 崩溃
 *   M3 复活：断连后服务仍能正常处理新请求
 */

const denoBin = process.env.DENO_BIN || `${process.env.HOME}/.deno/bin/deno`
const PORT = 18445
const KEY = process.env.PROXY_API_KEY || "test-proxy-key"
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = "pineapple-" + Math.random().toString(36).slice(2, 8)

let child = null
let bootLog = ""

function assert(cond, name, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
  return ok
}

const auth = (extra = {}) => ({ authorization: `Bearer ${KEY}`, ...extra })

async function waitForReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) throw new Error("deno 进程提前退出\n" + bootLog.slice(-1500))
    try {
      const r = await fetch(`${BASE}/v1/health`, { headers: auth(), signal: AbortSignal.timeout(2000) })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error("服务就绪超时\n" + bootLog.slice(-1500))
}

async function firstModel() {
  const r = await fetch(`${BASE}/v1/models`, { headers: auth() })
  const j = await r.json()
  return j.data[0].id
}

/** 非流式单轮请求，返回 assistant 文本。 */
async function chatOnce(model, text, sessionId) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: auth({ "content-type": "application/json", "x-session-id": sessionId }),
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: text }] }),
  })
  const j = await r.json().catch(() => ({}))
  return j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "") : ""
}

async function main() {
  console.log(`==> 拉起 ${denoBin} run --allow-all deno/main.ts（PORT=${PORT}）`)
  const { spawn } = await import("node:child_process")
  child = spawn(denoBin, ["run", "--allow-all", "deno/main.ts"], {
    env: { ...process.env, PORT: String(PORT), PROXY_API_KEY: KEY },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => { bootLog += String(d) })
  child.stderr.on("data", (d) => { bootLog += String(d) })
  await waitForReady()
  const model = await firstModel()
  console.log(`      本地引擎模型：${model}`)

  // M1 多轮：round1 埋暗号 → round2 回忆
  const r1 = await chatOnce(model, `记住暗号：${SECRET}。只回复：收到`, "mt-secret")
  assert(r1.length > 0, "M1 第一轮回复非空", r1.slice(0, 40))
  const r2 = await chatOnce(model, "暗号是什么？只回复暗号本身", "mt-secret")
  assert(r2.includes(SECRET), "M1 第二轮回忆暗号", `got=${r2.slice(0, 60)}`)

  // M2 断连：发起流式请求，收到首帧后 cancel
  {
    const ac = new AbortController()
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "写一首关于海的短诗" }] }),
      signal: ac.signal,
    })
    assert(r.status === 200 && /text\/event-stream/.test(r.headers.get("content-type") || ""), "M2 SSE 响应", `status=${r.status}`)
    const reader = r.body.getReader()
    await reader.read() // 首帧到达即断连
    await reader.cancel("client gone")
    ac.abort()
  }
  await new Promise((r) => setTimeout(r, 2000))

  // 服务必须存活
  {
    let alive = false
    try {
      const h = await fetch(`${BASE}/v1/health`, { headers: auth(), signal: AbortSignal.timeout(3000) })
      alive = h.ok
    } catch {}
    assert(alive, "M2 断连后服务存活")
  }
  assert(!/unhandled/.test(bootLog), "M2 日志无 unhandled 崩溃")

  // M3 复活：断连后新请求正常处理
  {
    const r = await chatOnce(model, "回复一个字：好", "mt-after-cancel")
    assert(r.length > 0, "M3 断连后新请求正常", r.slice(0, 30))
  }

  console.log(process.exitCode ? "\nMULTITURN-TEST: FAIL" : "\nMULTITURN-TEST: ALL PASS")
}

main()
  .catch((e) => { console.error("test fatal:", String((e && e.message) || e), "\n" + bootLog.slice(-800)); process.exit(1) })
  .finally(() => {
    if (child) { try { child.kill("SIGKILL") } catch {} }
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  })
