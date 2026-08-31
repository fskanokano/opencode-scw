#!/usr/bin/env node
/**
 * Local development server for the opencode proxy.
 *
 *   node scripts/dev.mjs            # http://127.0.0.1:8787
 *   PORT=9000 node scripts/dev.mjs
 *
 * Automatically downloads the opencode binary for your platform on first run
 * (the downloaded binary is NOT suitable for the Scaleway zip — the GitHub
 * Actions workflow / scripts/build-function.sh always use linux-x64).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "function", "opencode");

if (!existsSync(bin)) {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = os === "darwin" && process.arch === "arm64" ? "arm64" : process.arch === "arm64" ? "arm64" : "x64";
  const target = `${os}-${arch}`;
  console.log(`[dev] downloading opencode for ${target} ...`);
  execSync(`OPENCODE_TARGET=${target} NO_ZIP=1 bash scripts/fetch-opencode.sh`, {
    cwd: root,
    stdio: "inherit",
  });
}

process.env.PORT = process.env.PORT || "8787";
console.log(`[dev] opencode proxy on http://127.0.0.1:${process.env.PORT}  (GET /v1/models, POST /v1/chat/completions)`);
await import(path.join(root, "function", "handler.js"));
