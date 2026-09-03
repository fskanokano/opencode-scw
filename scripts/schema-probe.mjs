#!/usr/bin/env node
/**
 * 权限 reply schema 闭环验证（真实 per_xxx ID，不依赖模型）：
 *  1. 创建 session
 *  2. 创建真实 permission request（POST /api/session/:sid/permission）
 *  3. v1 路径（代理实际使用的路径）POST /session/:sid/permissions/:pid：
 *       旧 payload { response: "allow" } → 期望 400（枚举值非法，根因复现）
 *       新 payload { response: "once" }  → 期望 204（schema 通过，权限放行）
 */
import fs from "node:fs"
import path from "node:path"

function loadKey() {
  if (process.env.PROXY_API_KEY) return process.env.PROXY_API_KEY
  try {
    const p = path.resolve(".env")
    const txt = fs.readFileSync(p, "utf8")
    const m = txt.match(/^\s*PROXY_API_KEY\s*=\s*(.+?)\s*$/m)
    if (m) return m[1].replace(/^["']|["']$/g, "")
  } catch {}
  return null
}

const KEY = loadKey()
if (!KEY) {
  console.error("PROXY_API_KEY 不可用")
  process.exit(2)
}

const BASE = process.argv[2] || process.env.BASE || "http://127.0.0.1:8787"
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" }

const sres = await fetch(BASE + "/session", { method: "POST", headers: H, body: JSON.stringify({ title: "schema probe" }) })
const sjson = await sres.json().catch(() => ({}))
const sid = sjson.id || (sjson.data && sjson.data.id)
if (!sid) {
  console.error("session 创建失败:", sres.status, JSON.stringify(sjson).slice(0, 200))
  process.exit(2)
}
console.log("session:", sid)

const pres = await fetch(`${BASE}/api/session/${sid}/permission`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ action: "write", resources: ["/tmp/schema-probe.txt"] }),
})
const pjson = await pres.json().catch(() => ({}))
const pid = (pjson.data && pjson.data.id) || pjson.id
if (!pid) {
  console.error("permission 创建失败:", pres.status, JSON.stringify(pjson).slice(0, 300))
  process.exit(2)
}
console.log("permission:", pid)

async function reply(body, label) {
  const r = await fetch(`${BASE}/session/${sid}/permissions/${pid}`, { method: "POST", headers: H, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  const msg = (j && j.error && j.error.message) || (j && j.message) || ""
  console.log(`${label} -> HTTP ${r.status}  ${String(msg).slice(0, 140)}`)
  return r.status
}

const oldStatus = await reply({ response: "allow", remember: true }, "v1 旧 payload {response,allow}")
const newStatus = await reply({ response: "once" }, "v1 新 payload {response,once}")

const ok = oldStatus === 400 && newStatus === 204
console.log(
  ok
    ? "\n✅ 闭环验证通过：旧 payload 400（枚举值非法 → 线上卡死根因），新 payload 204（放行成功）"
    : `\n❌ 未达预期：旧=${oldStatus}(期望400) 新=${newStatus}(期望204)`,
)
process.exit(ok ? 0 : 1)