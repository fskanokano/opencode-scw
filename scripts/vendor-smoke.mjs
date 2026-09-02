#!/usr/bin/env node
/**
 * vendor 冒烟：Node + Deno 双运行时加载 bundle，验证进程内 app.fetch 链路。
 *
 * spike 四项硬门（spec §8）：
 *   ② node scripts/vendor-smoke.mjs vendor/dist/opencode-server.mjs
 *      → app.fetch(GET /doc) → 200
 *   ③ ~/.deno/bin/deno run --allow-all scripts/vendor-smoke.mjs ...
 *      → 同断言
 *   ④ 链路通：进程内 POST /session（到达 HTTP 层即算通）
 *      + GET /event SSE 响应到达（不要求收到业务帧）
 *
 * 退出码：0 = 全部断言通过；非 0 = 任一失败（错误摘要打到 stderr）。
 */

import { pathToFileURL } from "node:url"
import path from "node:path"

const rawArg = process.argv[2] || "vendor/dist/opencode-server.mjs"
const bundlePath = path.isAbsolute(rawArg) ? rawArg : path.resolve(process.cwd(), rawArg)
const bundleURL = pathToFileURL(bundlePath).href
const isDeno = typeof globalThis.Deno !== "undefined"

const checks = []
let failed = 0

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  const mod = await import(bundleURL)
  const app = mod.app
  record("bundle loads + app export", Boolean(app && typeof app.fetch === "function"))

  // ② / ③：进程内 app.fetch(GET /doc) → 200（无套接字）
  try {
    const res = await app.fetch(new Request("http://internal/doc"))
    record("app.fetch(GET /doc) -> 200", res.status === 200, `status=${res.status}`)
  } catch (e) {
    record("app.fetch(GET /doc) -> 200", false, String((e && e.message) || e))
  }

  // ④a：链路通 —— POST /session 到达 HTTP 层（无 LLM key 允许 400/5xx，只要不是网络异常）
  let sessionID = null
  try {
    const res = await app.fetch(new Request("http://internal/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "vendor-smoke" }),
    }))
    const ok = res.status >= 200 && res.status < 600 // 到达 HTTP 层即算通
    record("app.fetch(POST /session) reaches HTTP layer", ok, `status=${res.status}`)
    try {
      const j = await res.json()
      sessionID = (j && (j.id || (j.data && j.data.id))) || null
    } catch {}
  } catch (e) {
    record("app.fetch(POST /session) reaches HTTP layer", false, String((e && e.message) || e))
  }

  // ④b：链路通 —— GET /event SSE 响应到达（body 存在即可，立即取消）
  try {
    const res = await app.fetch(new Request("http://internal/event"))
    const ok = Boolean(res.body) && res.status >= 200 && res.status < 600
    record("app.fetch(GET /event) SSE response arrives", ok, `status=${res.status}`)
    if (res.body) await res.body.cancel().catch(() => {})
  } catch (e) {
    record("app.fetch(GET /event) SSE response arrives", false, String((e && e.message) || e))
  }

  console.log(`\nruntime=${isDeno ? "deno" : "node"} bundle=${rawArg}`)
  console.log(`checks: ${checks.length - failed}/${checks.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error("smoke fatal:", String((e && e.message) || e))
  process.exit(1)
})
