/**
 * server/stream.js 的类型声明（实现见 stream.js，纯 JS + JSDoc）。
 * Vercel 编译形态要求依赖为 .js 文件（.ts 扩展名会在运行时 MODULE_NOT_FOUND），
 * 类型由此文件补齐。
 */

/** 与 src/bridge.js CORS 常量一致的值（Deno 路径 Response 头重建用）。 */
export const SSE_HEADERS: Record<string, string>

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
 */
export function createSseWriter(
  base: Record<string, unknown>,
  opts?: { onCancel?: () => void },
): SseWriter

/** sseLines：纯 Web Streams SSE 解析器，输入 opencode /event 的 Response，逐条 yield data 载荷。 */
export function sseLines(res: Response): AsyncGenerator<string>