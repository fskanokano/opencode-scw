/**
 * 进程内 opencode 引擎适配器（spec §2）。
 *
 * 与 src/opencode.js 的角色对应关系：
 *   - ensureRuntime() → ensureEngine()：同为 Promise 单例，首次调用完成环境准备 + 引擎初始化
 *   - serverFetch(url) → engineFetch(path, init)：进程内 app.fetch 直调，零套接字、
 *     无端口、无 Basic 双门（spec §5 单门制：app.fetch 外部不可达，只有 PROXY_API_KEY 一道门）
 *   - getServerUrl() 不再需要：没有 server URL 可言
 *
 * import bundle 前设置 opencode 需要的环境变量（对齐 src/opencode.js ensureRuntime）。
 */

import os from "node:os"
import path from "node:path"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { pathToFileURL } from "node:url"

// bundle 导出的 app：Web 标准 fetch 签名（Request → Response）
type AppLike = { fetch: (request: Request) => Response | Promise<Response> }

const bundlePath = path.resolve(import.meta.dirname ?? ".", "..", "vendor", "dist", "opencode-server.mjs")

let app: AppLike | null = null
let ensuring: Promise<AppLike> | null = null

/** 环境前置（对齐 src/opencode.js ensureRuntime 的凭据/XDG 逻辑）。 */
function prepareEnv() {
  const dataHome =
    process.env.OPENCODE_DATA_HOME || path.join(os.tmpdir(), "opencode-deno-data")
  mkdirSync(path.join(dataHome, "opencode"), { recursive: true })

  const zenKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY || ""
  if (zenKey) {
    // provider id 是 "opencode"（opencode.ai Zen）；写入形状与 src/opencode.js 一致
    writeFileSync(
      path.join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ opencode: { type: "api", key: zenKey } }, null, 2),
    )
  }

  const env = {
    HOME: dataHome,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: process.env.OPENCODE_CONFIG_HOME || path.join(dataHome, "config"),
    XDG_CACHE_HOME: path.join(dataHome, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    NO_COLOR: "1",
    // ---- 内存压榨（Deno Deploy 免费档 768MiB）----
    // 关闭 server 代理模式用不到的可选子系统，实测本地 Deno 峰值 RSS 418→同水位
    // （bundle 14MB + effect runtime 本体之外，这些子系统各自吃几十到上百 MB）。
    // 每项都有 bundle 内对应读取点：
    //   EMBEDDED_WEB_UI  —— web 静态资源与 UI 服务（透传路径用不到）
    //   DEFAULT_PLUGINS  —— 内置插件加载
    //   EXTERNAL_SKILLS  —— 外部技能目录扫描
    //   CLAUDE_CODE      —— Claude Code 集成（prompt/skills 一并关）
    //   CHANNEL_DB       —— 渠道数据库
    //   FFF              —— 文件索引器（linux 默认启用，纯代理不需要）
    //   SHARE            —— 会话分享上传
    // 注意：不开 OPENCODE_DISABLE_MODELS_FETCH —— models.dev 元数据参与
    // provider/model 注册（聊天模型解析依赖它），且实测内存影响可忽略。
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CHANNEL_DB: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_DISABLE_SHARE: "1",
  }
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true })
}

/**
 * ensureEngine()：Promise 单例。首次调用动态 import bundle（effect runtime
 * 惰性构建发生在首次 app.fetch），后续调用直接命中已初始化实例。
 */
export function ensureEngine(): Promise<AppLike> {
  if (app) return Promise.resolve(app)
  if (ensuring) return ensuring

  const task = (async (): Promise<AppLike> => {
    prepareEnv()
    if (!existsSync(bundlePath)) {
      throw new Error(`opencode bundle 不存在：${bundlePath}（先跑 bun scripts/vendor-opencode.mjs）`)
    }
    // deno-lint-ignore no-explicit-any
    const mod = (await import(pathToFileURL(bundlePath).href)) as { app?: AppLike }
    if (!mod.app || typeof mod.app.fetch !== "function") {
      throw new Error("opencode bundle 导出异常：app.fetch 不可用")
    }
    app = mod.app
    // 预热：触发一次轻量请求，让 effect runtime 在冷启动路径完成构建
    try {
      await app.fetch(new Request("http://internal/doc"))
    } catch (e) {
      console.error("[engine] 预热失败（不影响后续请求）:", String((e instanceof Error ? e.message : e) || e))
    }
    console.log("[engine] opencode 进程内引擎就绪")
    startMemoryMonitor()
    return app
  })()

  ensuring = task
  task.finally(() => {
    if (ensuring === task) ensuring = null
  })
  return task
}

/**
 * 内存自监控（免费档 768MiB）：
 *  - >620MB 告警（留水位证据）
 *  - >720MB 主动 Deno.exit(0)：平台的 OOM 杀发生在请求中途（客户端 500 + trace），
 *    干净退出后平台重启 isolate（81MB 起步），把不可控死亡变成可控熔断。
 *    阈值可用 OPENCODE_MEM_EXIT_MB 覆盖；仅引擎就绪后启动，不会干扰冷启动。
 */
const BOOT_TS = Date.now()
export function memorySnapshot(): {
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  buffersMB: number
} {
  try {
    const m = Deno.memoryUsage()
    return {
      rssMB: m.rss / 1048576,
      heapUsedMB: m.heapUsed / 1048576,
      heapTotalMB: m.heapTotal / 1048576,
      externalMB: m.external / 1048576,
      // Deno.memoryUsage 无 buffers 字段（Node 才有），缺失时报 -1
      buffersMB: m.buffers != null ? m.buffers / 1048576 : -1,
    }
  } catch {
    return { rssMB: -1, heapUsedMB: -1, heapTotalMB: -1, externalMB: -1, buffersMB: -1 }
  }
}

let monitorStarted = false

/** isolate 启动时间（health 用于判断是否重启过）。 */
export function bootUptimeSec(): number {
  return Math.round((Date.now() - BOOT_TS) / 1000)
}

function startMemoryMonitor(): void {
  if (monitorStarted) return
  monitorStarted = true
  const exitMB = Number(process.env.OPENCODE_MEM_EXIT_MB || 720)
  let warned = false
  setInterval(() => {
    const m = memorySnapshot()
    if (m.rssMB < 0) return
    if (m.rssMB > exitMB) {
      console.error(
        `[engine] rss=${m.rssMB.toFixed(0)}MB 超过熔断阈值 ${exitMB}MB（768MiB 上限），主动退出让平台重启（干净自愈优于 OOM 暴杀）`,
      )
      Deno.exit(0)
    }
    if (m.rssMB > 620 && !warned) {
      warned = true
      console.warn(
        `[engine] 内存告警 rss=${m.rssMB.toFixed(0)}MB heap=${m.heapUsedMB.toFixed(0)}/${m.heapTotalMB.toFixed(0)}MB ext=${m.externalMB.toFixed(0)}MB buf=${m.buffersMB.toFixed(0)}MB（接近 768MiB 上限）`,
      )
    }
  }, 15_000)
}

/** 进程内 fetch：path 形如 "/session" 或 "/session?x=1"。 */
export async function engineFetch(pathWithQuery: string, init?: RequestInit): Promise<Response> {
  const a = await ensureEngine()
  return a.fetch(new Request(new URL(pathWithQuery, "http://internal"), init))
}

export function engineReady(): boolean {
  return Boolean(app)
}
