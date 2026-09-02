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
    return app
  })()

  ensuring = task
  task.finally(() => {
    if (ensuring === task) ensuring = null
  })
  return task
}

/** 进程内 fetch：path 形如 "/session" 或 "/session?x=1"。 */
export async function engineFetch(pathWithQuery: string, init?: RequestInit): Promise<Response> {
  const a = await ensureEngine()
  return a.fetch(new Request(new URL(pathWithQuery, "http://internal"), init))
}

export function engineReady(): boolean {
  return Boolean(app)
}
