#!/usr/bin/env bun
/**
 * vendor-opencode.mjs —— 把上游 opencode 源码构建成进程内可加载的 bundle。
 *
 * 用法（必须在项目根目录执行）：
 *   bun scripts/vendor-opencode.mjs            # 完整流水线
 *   SKIP_INSTALL=1 bun scripts/vendor-opencode.mjs   # 复用已有 src-upstream/node_modules
 *
 * 流水线（spec §3.1）：
 *   1. 下载上游 tarball（锁 OPENCODE_VERSION，SHA256 记录 MANIFEST，不匹配即失败）
 *   2. 解包到 vendor/src-upstream（临时工作区，不进仓库）
 *   3. bun install（workspaces）
 *   4. Bun.build（--conditions=node --target=node 等价配置）→ vendor/dist/opencode-server.mjs
 *      - 插件：jsonc-parser 重定向到 ESM 构建（bun 对其 UMD 工厂模式 factory(require,exports)
 *        会留下运行时相对 require —— bundle 加载即崩。ESM 构建是纯静态 import，可安全内联）
 *   5. 冒烟：node + deno 双运行时加载 bundle（scripts/vendor-smoke.mjs）
 *
 * 上游源文件逻辑改动为零；构建期修正只发生在插件层。
 */

import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const VENDOR = path.join(ROOT, "vendor")
const UPSTREAM = path.join(VENDOR, "src-upstream")
const DIST = path.join(VENDOR, "dist")
const CACHE = path.join(VENDOR, "cache")
const MANIFEST = path.join(VENDOR, "MANIFEST.json")

const OPENCODE_VERSION = process.env.OPENCODE_VERSION || "v1.18.25"
// 上游 release tag 不带 "v" 前缀；codeload tag 带。此处统一 codeload 形态。
const TAG = OPENCODE_VERSION.startsWith("v") ? OPENCODE_VERSION : `v${OPENCODE_VERSION}`
const TARBALL_URL = `https://github.com/anomalyco/opencode/archive/refs/tags/${TAG}.tar.gz`

// 已核实的 tarball SHA256（首次 vendor 时记录；不匹配即失败，防供应链漂移）
const KNOWN_SHA256 = {
  "v1.18.25": "44e9530d7be172005c7d60aef317440eecb85d557d94cce7fa35c5a7b9d9da0b",
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

async function stepDownload() {
  mkdirSync(CACHE, { recursive: true })
  const tarball = path.join(CACHE, `opencode-${TAG}.tar.gz`)
  if (!existsSync(tarball)) {
    console.log(`==> 下载 ${TARBALL_URL}`)
    const res = await fetch(TARBALL_URL)
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
  }
  const digest = sha256(tarball)
  const expected = KNOWN_SHA256[TAG]
  if (expected && digest !== expected) {
    throw new Error(`tarball SHA256 不匹配：期望 ${expected}，实际 ${digest}`)
  }
  console.log(`==> tarball SHA256 校验通过：${digest}`)
  return { tarball, digest }
}

async function stepExtract(tarball) {
  if (existsSync(path.join(UPSTREAM, "package.json")) && process.env.SKIP_EXTRACT) return
  rmSync(UPSTREAM, { recursive: true, force: true })
  mkdirSync(UPSTREAM, { recursive: true })
  await $`tar -xzf ${tarball} -C ${UPSTREAM} --strip-components=1`.quiet()
  console.log("==> 解包完成")
}

async function stepInstall() {
  if (existsSync(path.join(UPSTREAM, "node_modules", ".bin")) && process.env.SKIP_INSTALL) return
  console.log("==> bun install（上游 workspaces，临时目录）")
  await $`cd ${UPSTREAM} && bun install`.quiet()
}

/** 从 .bun store 定位 jsonc-parser 的 ESM 入口（重定向目标）。 */
function locateJsoncEsm() {
  const storeRoot = path.join(UPSTREAM, "node_modules", ".bun")
  const candidates = ["jsonc-parser@3.3.1", "jsonc-parser@2.3.1"]
  for (const c of candidates) {
    const esm = path.join(storeRoot, c, "node_modules", "jsonc-parser", "lib", "esm", "main.js")
    if (existsSync(esm)) return esm
  }
  throw new Error("未找到 jsonc-parser 的 ESM 构建（lib/esm/main.js）")
}

async function stepBuild() {
  const jsoncEsm = locateJsoncEsm()
  console.log(`==> Bun.build（conditions=node, target=node）→ ${DIST}`)
  mkdirSync(DIST, { recursive: true })
  rmSync(path.join(DIST, "opencode-server.mjs"), { force: true })
  // 清掉旧 wasm 资源，避免 outdir 残留改名后的孤儿
  for (const f of existsSync(DIST) ? await Array.fromAsync(new Bun.Glob("*.wasm").scan({ cwd: DIST })) : []) {
    rmSync(path.join(DIST, f), { force: true })
  }

  const result = await Bun.build({
    entrypoints: [path.join(VENDOR, "src", "entry.ts")],
    outdir: DIST,
    target: "node",
    conditions: ["node"],
    minify: true,
    naming: { entry: "[dir]/opencode-server.[ext]" },  // bun 产物名取 entry 基名，entry.ts → opencode-server.js；冒烟前改名 .mjs
    plugins: [
      {
        name: "jsonc-parser-esm-redirect",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: jsoncEsm }))
        },
      },
    ],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    throw new Error("Bun.build 失败")
  }
  for (const out of result.outputs) console.log(`    ${out.path.replace(ROOT + "/", "")} (${out.kind})`)
  // bun 产物名跟随 entry 基名（entry.ts → entry.js 或 opencode-server.js，随 naming 配置变化）
  // 统一改名为 opencode-server.mjs，供 Node/Deno 以 ESM 显式加载
  const candidates = [path.join(DIST, "entry.js"), path.join(DIST, "opencode-server.js")]
  const target = path.join(DIST, "opencode-server.mjs")
  const built = candidates.find((c) => existsSync(c))
  if (!built) throw new Error(`未找到构建产物（尝试 ${candidates.map((c) => path.basename(c)).join(" / ")}）`)
  rmSync(target, { force: true })
  await $`mv ${built} ${target}`
}

async function stepSmoke() {
  const bundle = path.join(DIST, "opencode-server.mjs")
  console.log("==> 冒烟：node 加载")
  await $`node ${path.join(ROOT, "scripts", "vendor-smoke.mjs")} ${bundle}`
  const denoBin = process.env.DENO_BIN || `${process.env.HOME}/.deno/bin/deno`
  if (existsSync(denoBin)) {
    console.log("==> 冒烟：deno 加载")
    await $`cd ${ROOT} && ${denoBin} run --allow-all ${path.join(ROOT, "scripts", "vendor-smoke.mjs")} ${bundle}`
  } else {
    console.log("==> 未找到 deno，跳过 deno 冒烟（spike 硬门③需要 deno）")
  }
}

async function main() {
  const { digest } = await stepDownload()
  await stepExtract(path.join(CACHE, `opencode-${TAG}.tar.gz`))
  await stepInstall()
  await stepBuild()
  await stepSmoke()

  const bundle = path.join(DIST, "opencode-server.mjs")
  const manifest = {
    version: TAG,
    tarball_url: TARBALL_URL,
    tarball_sha256: digest,
    bundle: "dist/opencode-server.mjs",
    bundle_sha256: sha256(bundle),
    build: {
      tool: `bun ${Bun.version}`,
      flags: "target=node, conditions=node, minify",
      plugins: ["jsonc-parser-esm-redirect（bun 不支持其 UMD 工厂模式，重定向到 lib/esm/main.js）"],
    },
    patches: [],
    dep_fixups: [
      "jsonc-parser: 构建期重定向到 ESM 构建（插件实现，零文件补丁）",
    ],
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`==> 完成。MANIFEST 已写入 ${path.relative(ROOT, MANIFEST)}`)
}

main().catch((e) => {
  console.error(`vendor 失败：${String((e && e.message) || e)}`)
  process.exit(1)
})
