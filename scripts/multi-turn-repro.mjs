#!/usr/bin/env node
/**
 * 多轮长对话复现（线上真实 PROXY_API_KEY）。
 * 模拟客户端行为：固定 x-session-id → 代理复用同一 opencode 会话，
 * 每轮追加一条 user 消息（历史累积），模型 = free 模型。
 *
 * 每轮采集：
 *   - TTFB（首帧延迟）
 *   - 帧数、每帧间隔（最大间隔 = 卡顿信号）
 *   - 是否收到 [DONE]
 *   - 耗时
 * 判定：某帧后 60s 无新帧且无 [DONE] → 该轮判定“卡住”，打印现场证据后终止。
 */

import fs from "node:fs"
import path from "node:path"

function loadKey() {
  if (process.env.PROXY_API_KEY) return process.env.PROXY_API_KEY
  // 兜底：脚本内部读取 .env（仅本脚本使用，不打印值）
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
  console.error("PROXY_API_KEY 不可用（env 与 .env 均未找到）")
  process.exit(2)
}

const BASE = process.env.BASE || "https://opencode-scw.vercel.app"
const MODEL = process.env.MODEL || "opencode/nemotron-3.5-lightning-free"
const SESSION = "mt-repro-" + Date.now()
const ROUNDS = Number(process.env.ROUNDS || 8)
const HANG_MS = Number(process.env.HANG_MS || 60000) // 无帧判定卡住
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS || 240000) // 单轮上限（maxDuration=300s 留余量）
const STALL_WARN_MS = 20000 // 超过此间隔打 warning

const TASKS = [
  "请实现一个 LRU 缓存类，支持 get/set，容量固定，要求线程安全，并给出使用示例。",
  "请写一个函数把阿拉伯数字转成中文大写金额（如 1234.5 → 壹仟贰佰叁拾肆元伍角），附测试用例。",
  "实现一个简单的发布订阅 EventEmitter，支持 once/off/emit，写 3 个单元测试。",
  "写一个解析 'a=1&b=2&c=3' 查询字符串的工具函数，支持数组和嵌套对象，附边界用例。",
  "实现一个防抖函数 debounce(fn, wait)，要求支持 leading/trailing 选项，并解释与节流的区别。",
  "写一个深拷贝函数，支持 Date/RegExp/Map/Set/循环引用，不要用 structuredClone。",
  "实现一个带优先级的任务队列调度器，支持并发上限和失败重试，给出接口设计。",
  "写一个 TypeScript 的 Maybe/Option 类型，实现 map/chain/unwrapOr，并说明适用场景。",
  "实现一个简单的 WebSocket 心跳保活封装：ping 间隔 30s，断线自动重连，指数退避。",
  "写一个内存版 LRU 之外的消息队列 RingBuffer，支持覆盖写和只读快照，附复杂度分析。",
]

function pick(seed) {
  const i = ((seed * 2654435761) >>> 0) % TASKS.length
  return TASKS[i]
}

async function streamChat(messages, round) {
  const t0 = Date.now()
  let firstFrameAt = -1
  let frames = 0
  let lastFrameAt = t0
  let maxGap = 0
  let sawDone = false
  let content = ""
  let lastChunkAt = t0

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
    console.log(`   [round ${round}] HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return { status: r.status, ms: Date.now() - t0, frames, sawDone, content }
  }

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let lastActivity = Date.now()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    lastActivity = Date.now()
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
      const gap = now - lastFrameAt
      if (gap > maxGap) maxGap = gap
      if (gap > STALL_WARN_MS) console.log(`   [round ${round}] ⚠ 帧间隔 ${gap}ms @帧#${frames}`)
      lastFrameAt = now
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

    // 卡住检测：无新字节且无结束
    if (Date.now() - lastActivity > HANG_MS) {
      console.log(`   [round ${round}] ❌ 疑似卡住：${HANG_MS / 1000}s 无任何数据`)
      console.log(`       已收 ${frames} 帧 / 内容 ${content.length} 字符 / 最后帧 ${maxGap}ms 前`)
      return { status: "hang", ms: Date.now() - t0, frames, sawDone, content, maxGap, lastActivity: Date.now() - lastActivity }
    }
  }

  const ms = Date.now() - t0
  const status = sawDone ? "ok" : "no-done"
  console.log(
    `   [round ${round}] ${status === "ok" ? "✅" : "❌"} TTFB=${firstFrameAt}ms 帧数=${frames} 最大帧间隔=${maxGap}ms 耗时=${ms}ms 内容=${content.length}字符`,
  )
  if (status !== "ok") {
    console.log(`       内容前 200 字符：${content.slice(0, 200)}`)
  }
  return { status, ms, frames, sawDone, content, maxGap }
}

async function main() {
  console.log(`== 多轮长对话复现  BASE=${BASE}  MODEL=${MODEL}  ROUNDS=${ROUNDS}`)
  console.log(`== 判定阈值：帧间隔>${HANG_MS / 1000}s 卡住；单轮上限 ${ROUND_TIMEOUT_MS / 1000}s`)

  // health 基线
  try {
    const h = await fetch(`${BASE}/v1/health`, {
      headers: { authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(10000),
    })
    console.log("== health:", JSON.stringify(await h.json()))
  } catch (e) {
    console.log("== health 失败:", String(e && e.message || e))
  }

  const messages = []
  const results = []
  for (let round = 1; round <= ROUNDS; round++) {
    const task = pick(round * 7919 + 13)
    messages.push({ role: "user", content: task })
    console.log(`\n--- 第 ${round}/${ROUNDS} 轮（历史 ${messages.length} 条消息）---`)
    console.log(`   任务：${task.slice(0, 60)}...`)
    const res = await streamChat([...messages], round)
    results.push(res)
    if (res.status === "hang") {
      console.log("\n❌ 检测到卡住，终止测试")
      break
    }
    if (res.status !== "ok") {
      console.log("\n❌ 该轮未正常完成，终止测试")
      break
    }
    messages.push({ role: "assistant", content: res.content.slice(0, 4000) })
    await new Promise((r) => setTimeout(r, 1500))
  }

  console.log("\n== 汇总 ==")
  results.forEach((r, i) => {
    console.log(
      `  轮${i + 1}: ${r.status}  TTFB=${"firstFrameAt" in r ? r.firstFrameAt + "ms" : "-"} 帧=${r.frames} 间隔=${r.maxGap || 0}ms 耗时=${r.ms}ms`,
    )
  })
  const hangs = results.filter((r) => r.status === "hang")
  console.log(hangs.length ? `\n❌ 复现成功：${hangs.length} 轮卡住` : `\n✅ ${results.length} 轮全部完成，未见卡住`)
}

main().catch((e) => {
  console.error("fatal:", String((e && e.message) || e))
  process.exit(1)
})