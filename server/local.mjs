#!/usr/bin/env node
/**
 * 本地 shim：node:http ↔ Web Request 桥接（仅本地/测试用，不参与部署）。
 * 与线上同一 handler（api/index.ts），测试结论可信。
 * 用法：node --experimental-strip-types server/local.mjs（PORT 环境变量，默认 8787）
 */
import { createServer } from "node:http"

const PORT = Number(process.env.PORT || 8787)
const mod = await import("../api/index.ts")
const handler = mod.handler

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const ac = new AbortController()
  res.on("close", () => ac.abort())

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, String(item))
  }
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)
  const hasBody = body.length > 0 && req.method !== "GET" && req.method !== "HEAD"
  const request = new Request(url, {
    method: req.method || "GET",
    headers,
    body: hasBody ? new Uint8Array(body) : undefined,
    signal: ac.signal,
    // duplex 在 Node fetch 的 RequestInit 里必填（body 为流时）；此处仅文档性
    duplex: "half",
  })

  try {
    const response = await handler(request)
    const resHeaders = {}
    response.headers.forEach((v, k) => {
      resHeaders[k] = v
    })
    res.writeHead(response.status, resHeaders)
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk)
    }
    res.end()
  } catch (e) {
    console.error("[local] request error:", e)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(e?.message || e), type: "internal_error" } }))
    } else {
      res.end()
    }
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[api] local shim listening on 0.0.0.0:${PORT}`)
})
