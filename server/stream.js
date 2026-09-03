/**
 * TransformStream 版 SSE 写器（spec docs/superpowers/specs/2026-09-03-vercel-inproc-opencode-design.md §2，
 * 对齐 src/proxy.js SseWriter 语义；自 deno/stream.ts 原样移植——纯 Web Streams，零运行时专属 API）。
 *
 * 与 Node 形态差异：Node 用 res.write + flushHeaders，Deno 用 ReadableStream
 * 直出（Deno.serve 原生流式）；帧序契约完全一致：
 *   role 帧 → reasoning_content/content 分片 → stop 帧 → [DONE]
 * usage 帧（stream_options.include_usage）在 stop 之前由调用方排入。
 *
 * 队列语义（对齐 SseWriter.push）：所有帧经串行队列排队，保证 stop/[DONE]
 * 永远在分片之后；打字机节奏（chunk/delay）默认开启，可经环境变量关闭。
 *
 * 为什么是 .js 而不是 .ts：同 server/engine.js（Vercel 编译形态下 .ts 扩展名
 * 的 import 路径会在运行时找不到文件，导致 FUNCTION_INVOCATION_FAILED）。
 * 本文件用纯 JS + 同目录 stream.d.ts 声明。
 */

// 与 src/bridge.js CORS 常量一致的值（Deno 路径 Response 头重建用）
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
}

function sseSend(obj) {
  return "data: " + JSON.stringify(obj) + "\n\n"
}

function sseDone() {
  return "data: [DONE]\n\n"
}

/**
 * 创建 SSE 写器。base 为 OpenAI chunk 公共字段
 * （{ id, object: "chat.completion.chunk", created, model }）。
 *
 * opts.onCancel：客户端断连/reader 取消时回调（跨运行时正确语义——
 * Response 返回后 Deno legacy serve 会 abort req.signal，不能用
 * req.signal 探测断连；ReadableStream.cancel 才是可靠信号）。
 */
export function createSseWriter(base, opts = {}) {
  let controller = null
  let closed = false
  let roleSent = false
  let queue = Promise.resolve()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
    // 客户端断连：后续 enqueue 全部 no-op（对齐 Node 版 alive() 检查）
    cancel() {
      closed = true
      try {
        opts.onCancel?.()
      } catch {}
    },
  })

  function enqueue(text) {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      closed = true
    }
  }

  function push(fn, delayMs = 0) {
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            try {
              fn()
            } catch {}
            resolve()
          }, delayMs)
        }),
    )
    return queue
  }

  function sse(payloadObj) {
    push(() => enqueue(sseSend(payloadObj)))
  }

  function chunk(field, text) {
    if (!text) return
    if (!roleSent) {
      roleSent = true
      sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
    }
    const smooth = process.env.OPENCODE_STREAM_SMOOTHING !== "false"
    // 每块字符数/块间隔（默认 8 字符 / 45ms）：对齐 src/proxy.js SseWriter.chunk
    const size = smooth ? Number(process.env.OPENCODE_STREAM_CHUNK || 8) : text.length
    const delay = smooth ? Number(process.env.OPENCODE_STREAM_DELAY_MS || 45) : 0
    for (let i = 0; i < text.length; i += size) {
      const piece = text.slice(i, i + size)
      push(() => {
        enqueue(
          sseSend({ ...base, choices: [{ index: 0, delta: { [field]: piece }, finish_reason: null }] }),
        )
      }, delay)
    }
  }

  function usage(u) {
    sse({ ...base, choices: [], usage: u })
  }

  function stop() {
    push(() => {
      enqueue(sseSend({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
    })
  }

  function done() {
    push(() => {
      enqueue(sseDone())
    })
  }

  async function end() {
    await queue.catch(() => {})
    try {
      if (controller) controller.close()
    } catch {}
    closed = true
  }

  return { stream, sse, chunk, usage, stop, done, end }
}

/**
 * sseLines：纯 Web Streams SSE 解析器（等价复刻 src/proxy.js sseLines，
 * Deno 兼容）。输入 opencode /event 的 Response，逐条 yield data 载荷。
 */
export async function* sseLines(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
      if (data) yield data
    }
  }
  if (buf.trim()) yield buf.trim()
}