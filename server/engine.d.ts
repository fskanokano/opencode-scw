/**
 * server/engine.js 的类型声明（实现见 engine.js，纯 JS + JSDoc）。
 * Vercel 编译形态要求依赖为 .js 文件（.ts 扩展名会在运行时 MODULE_NOT_FOUND），
 * 类型由此文件补齐。
 */

/** bundle 导出的 app：Web 标准 fetch 签名（Request → Response）。 */
export type AppLike = { fetch: (request: Request) => Response | Promise<Response> }

/**
 * ensureEngine()：Promise 单例。首次调用动态 import bundle（effect runtime
 * 惰性构建发生在首次 app.fetch），后续调用直接命中已初始化实例。
 */
export function ensureEngine(): Promise<AppLike>

/** 内存快照（Node process.memoryUsage()：buffers ≈ arrayBuffers）。 */
export function memorySnapshot(): {
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  buffersMB: number
}

/** 实例启动时间（health 用于判断是否重启过）。 */
export function bootUptimeSec(): number

/** 进程内 fetch：path 形如 "/session" 或 "/session?x=1"。 */
export function engineFetch(pathWithQuery: string, init?: RequestInit): Promise<Response>

export function engineReady(): boolean