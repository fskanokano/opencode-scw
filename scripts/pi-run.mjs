// 真实客户端验证：用官方 pi CLI（earendil-works/pi）连我们的代理。
// 只从 .env 读取 PROXY_API_KEY 注入 pi 子进程，不打印任何密钥。
// 用法:
//   node scripts/pi-run.mjs r1            # 第一轮（真实任务 + 植入代号）→ 预览
//   node scripts/pi-run.mjs r2            # 第二轮（记忆检验）→ 预览
//   node scripts/pi-run.mjs r1 local      # 同上但打本地起的实例(127.0.0.1:8799)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_PORT = 8799;

if (existsSync(path.join(root, ".env"))) {
  const env = readFileSync(path.join(root, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.trim().match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith("#") || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim();
  }
}
if (!process.env.PROXY_API_KEY) {
  console.error("PROXY_API_KEY 未配置");
  process.exit(1);
}

const mode = process.argv[2] || "r1";
const target = process.argv[3] === "local" ? "local" : "preview";
const model = process.argv[4] || "muse-spark-1.2-contributor-free";

const prompts = {
  r1: "你好！请阅读本项目的 README.md，然后用中文回答：这个项目是做什么的、部署形态是什么？回答控制在 120 字以内。另外请你记住：我的测试代号是 PITEST-9。",
  r2: "我的测试代号是什么？只回答代号本身。",
};

async function waitReady(url, key, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${url}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      if (res.status !== 401 && res.status !== 502) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

let localServer = null;
let provider = "opencode-proxy";
let apiBase = "https://8787-f4bcd016-8be7-4eed-857b-f77d2c9bc5eb.daytonaproxy01.net/v1";

if (target === "local") {
  provider = "opencode-proxy-local";
  apiBase = `http://127.0.0.1:${LOCAL_PORT}/v1`;
  localServer = spawn("node", ["handler.js"], {
    env: { ...process.env, PORT: String(LOCAL_PORT) },
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 独立进程组：清理时连 opencode server 一起杀
  });
  localServer.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
  localServer.stderr.on("data", (d) => process.stderr.write(`[app!] ${d}`));
  if (!(await waitReady(apiBase, process.env.PROXY_API_KEY, 45000))) {
    console.error("本地应用未就绪");
    localServer.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`[runner] 本地应用就绪 (${apiBase})`);
}

if (mode === "list") {
  const p = spawn("pi", ["--list-models", "muse", "--provider", provider], {
    stdio: "inherit",
    env: process.env,
    cwd: root,
  });
  p.on("exit", (c) => {
    cleanup(c);
  });
} else {
  const args = [
    "-p",
    "--provider", provider,
    "--model", model,
    "--no-tools",
    "--system-prompt", "You are a helpful assistant in a test harness.",
    ...(mode === "r2" ? ["--continue"] : []),
    prompts[mode] || prompts.r1,
  ];
  const t0 = Date.now();
  console.log(`\n=== pi ${mode} start (target=${target}, model=${model}) ===`);
  const p = spawn("pi", args, { stdio: "inherit", env: process.env, cwd: root });
  p.on("exit", (code) => {
    console.log(`=== pi ${mode} exit code=${code} in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
    cleanup(code);
  });
}

function cleanup(code) {
  if (localServer) {
    // 杀整个进程组（handler + 其拉起的 opencode server），防孤儿吃内存
    try { process.kill(-localServer.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-localServer.pid, "SIGKILL"); } catch {}
    }, 1500);
  }
  process.exit(code ?? 1);
}