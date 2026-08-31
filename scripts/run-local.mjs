// 本地联调入口：先打包（下载真实 opencode 二进制），再以本地 HTTP 服务器方式运行。
// 用法：
//   OPENCODE_API_KEY=你的zenkey bash -lc 'PROXY_API_KEY=本地密钥 node scripts/run-local.mjs'
// 或（配合 .env 方式，见 README）：
//   node scripts/run-local.mjs

import { execSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 允许把两个密钥写进本地 .env（便于联调，不上传到函数本身）
if (existsSync(path.join(root, ".env"))) {
  const env = readFileSync(path.join(root, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.trim().match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith("#") || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim();
  }
}

console.log("==> 打包（下载真实 opencode + 组装 stage）");
execSync("sh scripts/build.sh", { cwd: root, stdio: "inherit" });

console.log("==> 启动本地代理");
const child = spawn(process.execPath, ["dist/handler.js"], {
  cwd: root,
  env: { ...process.env, PORT: process.env.PORT || "8787" },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  console.log(`本地代理退出 code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill("SIGINT"));