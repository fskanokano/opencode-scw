/**
 * TransformStream 版 SSE 写器（spec §2，对齐 src/proxy.js SseWriter 语义）。
 *
 * 与 Node 形态差异：Node 用 res.write + flushHeaders，Deno 用 ReadableStream
 * 直出（Deno.serve 原生流式）；帧序契约完全一致：
 *   role 帧 → reasoning_content/content 分片 → stop 帧 → [DONE]
 * usage 帧（stream_options.include_usage）在 stop 之前由调用方排入。
 *
 * 队列语义（对齐 SseWriter.push）：所有帧经串行队列排队，保证 stop/[DONE]
 * 永远在分片之后；打字机节奏（chunk/delay）默认开启，可经环境变量关闭。
 */

// 与 src/bridge.js CORS 常量一致的值（Deno 路径 Response 头重建用）
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
}

function sseSend(obj: unknown): string {
  return "data: " + JSON.stringify(obj) + "\n\n"
}

function sseDone(): string {
  return "data: [DONE]\n\n"
}

export type SseWriter = {
  stream: ReadableStream<Uint8Array>
  /** 排入一帧（任意 OpenAI chunk 结构）。 */
  sse: (payloadObj: unknown) => void
  /** 正文/思考分片（首帧前自动补 role 帧；打字机节奏对齐 src/proxy.js）。 */
  chunk: (field: "content" | "reasoning_content", text: string) => void
  /** stream_options.include_usage 的收尾 usage 帧（choices 为空数组）。 */
  usage: (u: unknown) => void
  /** finish_reason:"stop" 帧。 */
  stop: () => void
  /** data: [DONE] 帧。 */
  done: () => void
  /** 等待队列排空后关闭流。 */
  end: () => Promise<void>
}

/**
 * 创建 SSE 写器。base 为 OpenAI chunk 公共字段
 * （{ id, object: "chat.completion.chunk", created, model }）。
 *
 * opts.onCancel：客户端断连/reader 取消时回调（跨运行时正确语义——
 * Response 返回后 Deno legacy serve 会 abort req.signal，不能用
 * req.signal 探测断连；ReadableStream.cancel 才是可靠信号）。
 */
export function createSseWriter(
  base: Record<string, unknown>,
  opts: { onCancel?: () => void } = {},
): SseWriter {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let roleSent = false
  let queue = Promise.resolve()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
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

  function enqueue(text: string): void {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      closed = true
    }
  }

  function push(fn: () => void, delayMs = 0): Promise<void> {
    queue = queue.then(
      () =>
        new Promise<void>((resolve) => {
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

  function sse(payloadObj: unknown): void {
    push(() => enqueue(sseSend(payloadObj)))
  }

  function chunk(field: "content" | "reasoning_content", text: string): void {
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

  function usage(u: unknown): void {
    sse({ ...base, choices: [], usage: u })
  }

  function stop(): void {
    push(() => {
      enqueue(sseSend({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
    })
  }

  function done(): void {
    push(() => {
      enqueue(sseDone())
    })
  }

  async function end(): Promise<void> {
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
export async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
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
