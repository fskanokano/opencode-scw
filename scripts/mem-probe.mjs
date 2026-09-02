#!/usr/bin/env node
/**
 * 内存水位探针：诊断 Deno Deploy 768MiB OOM。
 * 用法：node scripts/mem-probe.mjs [bundle路径]
 * 阶段：import → 预热 /doc → POST /session → GET /event（短暂）→ 结束
 * 每阶段打印 rss/heapUsed/heapTotal/maxRSS（KB）。
 */
const bundle = process.argv[2] || "vendor/dist/opencode-server.mjs"

function peakRssMb() {
  try {
    if (process.resourceUsage) return process.resourceUsage().maxRSS / 1024
  } catch {}
  return 0 // Deno 无 resourceUsage，用当前 rss 近似
}

function mem(tag) {
  const mu = process.memoryUsage()
  const max = peakRssMb()
  const fmt = (n) => (n / 1024 / 1024).toFixed(1) + "MB"
  console.log(
    `[mem] ${tag.padEnd(18)} rss=${fmt(mu.rss).padStart(9)} heapUsed=${fmt(mu.heapUsed).padStart(9)} heapTotal=${fmt(mu.heapTotal).padStart(9)} external=${fmt(mu.external).padStart(8)} peakRSS=${max ? max.toFixed(1) + "MB" : "n/a"}`,
  )
}

mem("before-import")
const t0 = Date.now()
const mod = await import(new URL(`../${bundle}`, import.meta.url).href)
mem(`after-import(${Date.now() - t0}ms)`)

const app = mod.app
if (!app || typeof app.fetch !== "function") {
  console.error("app 不可用")
  process.exit(1)
}

async function stage(tag, fn) {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`[stage] ${tag} → ${r && r.status} (${Date.now() - t}ms)`)
  } catch (e) {
    console.log(`[stage] ${tag} → ERROR ${String((e && e.message) || e).slice(0, 120)} (${Date.now() - t}ms)`)
  }
  mem(tag)
}

// 预热（触发 effect runtime 构建）
await stage("warmup /doc", () => app.fetch(new Request("http://internal/doc")))

// 全局 GC（如暴露）后看稳态水位
if (globalThis.gc) { globalThis.gc(); mem("after-gc") }

// 建会话
let sid = null
await stage("POST /session", async () => {
  const r = await app.fetch(new Request("http://internal/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "mem-probe" }),
  }))
  const j = await r.json().catch(() => ({}))
  sid = j.id || (j.data && j.data.id) || null
  return r
})
console.log(`[info] sessionID=${sid}`)

// 订阅事件总线（短暂）
const evt = await stage("GET /event", () => app.fetch(new Request("http://internal/event")))

// 发一条消息（无 key 时上游报错，仍可测请求路径内存）
if (sid) {
  await stage("POST message", () => app.fetch(new Request(`http://internal/session/${sid}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], model: { providerID: "opencode", modelID: "gpt-5.6-luna" } }),
  })))
}

if (evt && evt.body) evt.body.cancel().catch(() => {})
mem("final")
const peak = peakRssMb() || process.memoryUsage().rss / 1024 / 1024
console.log(`\npeakRSS=${peak.toFixed(1)}MB（768MiB 上限的 ${(peak / 768 * 100).toFixed(0)}%）`)
setTimeout(() => process.exit(0), 200)
