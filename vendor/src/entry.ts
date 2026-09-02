/**
 * Vendor 入口：把上游 opencode server 的进程内 app 出口 re-export 成稳定 API。
 *
 * 上游出口形态（vendor/src-upstream/packages/opencode/src/server/server.ts，v1.18.25）：
 *   export const Default = lazy(() => ({ app }))
 *   - Default() → { app }，app.fetch(request: Request): Response | Promise<Response>
 *   - lazy() 是 @/util/lazy 的缓存 getter（首次调用初始化，之后返回缓存值）
 *   - Server.listen() 只是 app.fetch 的 node:http 套壳，进程内接入不需要它
 *
 * 本文件是新增文件（不是对上游的改动），其余代码只 import entry，不 import 上游。
 */

// 惰性初始化上游 server 模块（import 时刻不触发 effect runtime 构建，
// 首次 app.fetch 才构建——见上游 HttpApiApp.webHandler 的 lazy 设计）。
import { Default } from "../src-upstream/packages/opencode/src/server/server.ts"

// lazy 包装的访问器签名以当日源码为准；v1.18.25 是无参调用返回 { app }。
const server = Default()

export const app = server.app

export type AppLike = {
  fetch(request: Request): Response | Promise<Response>
}

export function assertAppReady(): void {
  if (!app || typeof app.fetch !== "function") {
    throw new Error("vendor entry: opencode app 未就绪（app.fetch 不可用）")
  }
}

/**
 * init：进程内启动前置（凭据/XDG 目录准备，对齐 src/opencode.js ensureRuntime 语义）。
 * 必须在首次 app.fetch 之前调用；只做环境准备，不持有任何状态。
 */
export async function init(opts?: { dataHome?: string }): Promise<void> {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")

  const dataHome = opts?.dataHome || process.env.OPENCODE_DATA_HOME || path.join(os.tmpdir(), "opencode-scw-data")

  // opencode 读凭据的位置是 $XDG_DATA_HOME/opencode/auth.json
  fs.mkdirSync(path.join(dataHome, "opencode"), { recursive: true })

  const zenKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY || ""
  if (zenKey) {
    // provider id 是 "opencode"（opencode.ai Zen）；与 src/opencode.js 写入形状一致
    fs.writeFileSync(
      path.join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ opencode: { type: "api", key: zenKey } }, null, 2),
    )
  }

  const env: Record<string, string> = {
    HOME: dataHome,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: process.env.OPENCODE_CONFIG_HOME || path.join(dataHome, "config"),
    XDG_CACHE_HOME: path.join(dataHome, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    NO_COLOR: "1",
  }
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }

  fs.mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true })
  fs.mkdirSync(env.XDG_CACHE_HOME!, { recursive: true })
}
