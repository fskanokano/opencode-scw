#!/usr/bin/env node
/**
 * 权限自动放行验证：任务明确要求 agent 调用 bash 工具，
 * 若 permission.asked 被自动放行 → agent 能完成；否则卡住。
 * 用法：node scripts/perm-check.mjs [base]
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
const MODEL = process.env.MODEL || "opencode/nemotron-3.5-lightning-free"
const SESSION = "perm-check-" + Date.now()
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS || 90000)

async function streamChat(messages, label) {
  const t0 = Date.now()
  let firstFrameAt = -1
  let frames = 0
  let sawDone = false
  let content = ""
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-session-id": SESSION,
    },
    body: JSON.stringify({ model: MODEL, stream: true, messages }),
    signal: AbortSignal.timeout(ROUND_TIMEOUT_MS),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    console.log(`[${label}] HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return "http-" + r.status
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      frames++
      const now = Date.now()
      if (firstFrameAt < 0) firstFrameAt = now - t0
      if (data === "[DONE]") {
        sawDone = true
        break
      }
      try {
        const j = JSON.parse(data)
        const delta = j.choices && j.choices[0] && j.choices[0].delta
        if (delta && typeof delta.content === "string") content += delta.content
        if (delta && typeof delta.reasoning_content === "string") content += delta.reasoning_content
      } catch {}
    }
    if (sawDone) break
  }
  const ms = Date.now() - t0
  console.log(
    `[${label}] ${sawDone ? "✅ DONE" : "❌ NO-DONE"} TTFB=${firstFrameAt}ms 帧数=${frames} 耗时=${ms}ms 内容=${content.length}字符`,
  )
  return sawDone ? "ok" : "no-done"
}

async function main() {
  console.log(`== 权限验证 BASE=${BASE} MODEL=${MODEL}`)
  // 轮1：要求调用 bash 工具
  const r1 = await streamChat(
    [{ role: "user", content: "请在终端里运行命令 `echo PERM_TEST_OK_12345`，然后原样报告命令输出，不要做其他事。" }],
    "round 1",
  )
  if (r1 !== "ok") process.exit(1)
  // 轮2：复用会话再要求一次工具调用（多轮场景）
  const r2 = await streamChat(
    [
      { role: "user", content: "请在终端里运行命令 `echo PERM_TEST_OK_12345`，然后原样报告命令输出，不要做其他事。" },
      { role: "assistant", content: "已运行。输出：PERM_TEST_OK_12345" },
      { role: "user", content: "再运行一次 `echo SECOND_TOOL_CALL_67890` 并报告输出。" },
    ],
    "round 2",
  )
  console.log(r2 === "ok" ? "\n✅ 权限自动放行工作正常（两轮工具调用均完成）" : "\n❌ 权限流程仍有问题")
  process.exit(r2 === "ok" ? 0 : 1)
}

main().catch((e) => {
  console.error("fatal:", String((e && e.message) || e))
  process.exit(1)
})