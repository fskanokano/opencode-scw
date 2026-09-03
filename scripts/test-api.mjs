#!/usr/bin/env node
/**
 * Vercel 路径黑盒测试（自 scripts/test-deno.mjs D1-D10 平移，spec §8）。
 *
 * 用法：node scripts/test-api.mjs [PORT]
 *   - PORT 缺省时自动拉起 `node --experimental-strip-types server/local.mjs`
 *     （与线上同一 handler：api/index.ts，经 node:http ↔ Web Request 桥接）
 *   - 传入 PORT 则只跑断言（外部已起好服务）
 *
 * 断言清单（与 Deno 路径逐条同语义）：
 *   D1  无凭据          → 401 + authentication_error
 *   D2  OPTIONS 预检     → 204 + CORS（不鉴权）
 *   D3  GET /v1/health  → 200 {status:"ok"}（引擎就绪）
 *   D4  GET /v1/models  → 200 object:list（进程内 providers 或静态回退）
 *   D5  POST /v1/chat/completions（stream:false）→ 200 OpenAI 结构 + content 非空
 *   D6  POST /v1/chat/completions（stream:true）→ 200 text/event-stream，首帧非空 + [DONE] 收尾
 *   D7  透传：GET /config/providers → 非 502（原样转发 opencode 响应）
 *   D8  透传：GET /definitely-not-a-route → 上游原样响应（非 502；上游对未知路由
 *       实际返回 200 + web UI HTML，对齐 test-bridge T12 口径：非 502 即透传成功）
 *   D9  错误结构：无效 JSON body → 400 {error:{message,type}}
 *   D10 usage：stream+include_usage → 结尾 usage 帧
 */

const PORT = process.argv[2] || null
const KEY = process.env.PROXY_API_KEY || "test-proxy-key"
const BASE = PORT ? `http://127.0.0.1:${PORT}` : null

let child = null
let bootLog = ""

async function waitForReady(base, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) throw new Error("api 进程提前退出\n" + bootLog.slice(-1500))
    try {
      const r = await fetch(`${base}/v1/health`, {
        headers: { authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error("服务就绪超时\n" + bootLog.slice(-1500))
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${KEY}`, ...extra }
}

function assert(cond, name, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
  return ok
}

async function main() {
  let base = BASE

  if (!base) {
    base = "http://127.0.0.1:18432"
    console.log(`==> 拉起 node --experimental-strip-types server/local.mjs（PORT=18432）`)
    const { spawn } = await import("node:child_process")
    child = spawn(process.execPath, ["--experimental-strip-types", "server/local.mjs"], {
      env: { ...process.env, PORT: "18432", PROXY_API_KEY: KEY },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (d) => { bootLog += String(d) })
    child.stderr.on("data", (d) => { bootLog += String(d) })
    await waitForReady(base)
  }

  // D1 无凭据 → 401
  {
    const r = await fetch(`${base}/v1/models`)
    const j = await r.json().catch(() => ({}))
    assert(r.status === 401, "D1 无凭据 401", `status=${r.status}`)
    assert(j.error && j.error.type === "authentication_error", "D1 错误结构", JSON.stringify(j).slice(0, 120))
  }

  // D2 OPTIONS → 204 + CORS
  {
    const r = await fetch(`${base}/v1/models`, { method: "OPTIONS" })
    assert(r.status === 204, "D2 OPTIONS 204", `status=${r.status}`)
    assert(r.headers.get("access-control-allow-origin") === "*", "D2 CORS 头")
  }

  // D3 health（顺带触发引擎预热，供 D5-D10 的进程内请求使用）
  {
    const r = await fetch(`${base}/v1/health`, { headers: authHeaders() })
    const j = await r.json().catch(() => ({}))
    assert(r.status === 200 && j.status === "ok", "D3 health 200 ok", JSON.stringify(j).slice(0, 120))
  }

  // D4 models + 动态解析本地引擎真实可用的模型（本地无 Zen key 时
  // 清单里只有 free 模型；不存在的模型上游会 500，那是数据问题不是桥接缺陷）
  let MODEL = "gpt-5.6-luna"
  {
    const r = await fetch(`${base}/v1/models`, { headers: authHeaders() })
    const j = await r.json().catch(() => ({}))
    assert(r.status === 200 && j.object === "list" && Array.isArray(j.data) && j.data.length > 0, "D4 models list", `data=${(j.data || []).length}`)
    if (Array.isArray(j.data) && j.data.length > 0) {
      // 优先引擎默认模型 big-pickle（实测响应快）；不在清单时退而取第一个
      const ids = j.data.map((m) => m.id)
      MODEL = ids.includes("opencode/big-pickle") ? "opencode/big-pickle" : ids[0]
      console.log(`      本地引擎模型：${MODEL}`)
    }
  }

  // D5 非流式 chat
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "回复两个字：OK" }] }),
    })
    const j = await r.json().catch(() => ({}))
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
    assert(r.status === 200, "D5 chat 200", `status=${r.status} ${JSON.stringify(j).slice(0, 160)}`)
    assert(typeof content === "string" && content.length > 0, "D5 content 非空", String(content).slice(0, 60))
  }

  // D6 流式 chat：首帧非空 + [DONE]
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "数到三" }] }),
    })
    assert(r.status === 200 && /text\/event-stream/.test(r.headers.get("content-type") || ""), "D6 SSE 头", `status=${r.status}`)
    if (r.body) {
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = "", firstFrameAt = -1, sawDone = false, frames = 0
      const t0 = Date.now()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (!line.startsWith("data:")) continue
          frames++
          if (firstFrameAt < 0) firstFrameAt = Date.now() - t0
          if (line.slice(5).trim() === "[DONE]") sawDone = true
        }
      }
      assert(frames > 0, "D6 帧数>0", `frames=${frames}`)
      assert(sawDone, "D6 [DONE] 收尾")
      console.log(`      首帧 ${firstFrameAt}ms`)
    }
  }

  // D7 透传 /config/providers 非 502
  {
    const r = await fetch(`${base}/config/providers`, { headers: authHeaders() })
    assert(r.status !== 502 && r.status !== 0, "D7 透传 providers 非 502", `status=${r.status}`)
  }

  // D8 透传未知路由 → 上游原样响应（非 502；上游实测返回 200 + web UI HTML，
  // 口径对齐 test-bridge T12：非 502 即为透传成功）
  {
    const r = await fetch(`${base}/definitely-not-a-route`, { headers: authHeaders() })
    assert(r.status !== 502 && r.status !== 0, "D8 未知路由上游透传（非 502）", `status=${r.status}`)
  }

  // D9 无效 JSON → 400 错误结构
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{not-json",
    })
    const j = await r.json().catch(() => ({}))
    assert(r.status === 400 && j.error && typeof j.error.message === "string", "D9 400 错误结构", `status=${r.status}`)
  }

  // D10 usage 帧
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        model: MODEL, stream: true, stream_options: { include_usage: true },
        messages: [{ role: "user", content: "回一个字" }],
      }),
    })
    if (r.body) {
      const text = await new Response(r.body).text()
      const usageFrame = text.split("\n").find((l) => l.startsWith("data:") && l.includes('"usage"'))
      assert(Boolean(usageFrame), "D10 usage 帧", usageFrame ? usageFrame.slice(0, 120) : "未找到")
    }
  }

  console.log(process.exitCode ? "\nAPI-TEST: FAIL" : "\nAPI-TEST: ALL PASS")
}

main()
  .catch((e) => { console.error("test fatal:", String((e && e.message) || e), "\n" + bootLog.slice(-800)); process.exit(1) })
  .finally(() => {
    if (child) {
      try { child.kill("SIGKILL") } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 300)
  })
