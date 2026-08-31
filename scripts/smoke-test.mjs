// Full local smoke test for the SDK-based OpenAI-compatible proxy.
// Starts handler.js (PORT env -> standalone HTTP server), then exercises:
//   GET  /v1/health
//   GET  /v1/models      (auth -> 200, no auth -> 401)
//   POST /v1/chat/completions (auth -> 200 or well-formed 502; no auth -> 401)
//
// Usage: node scripts/smoke-test.mjs
// Requires: `opencode` on PATH (npm i -g opencode-ai) — the SDK spawns it
// as the shared server subprocess. A valid OPENCODE_API_KEY makes the chat
// call return 200; without it the chat check accepts a well-formed 502.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load .env if present (OPENCODE_API_KEY / PROXY_API_KEY for local testing)
if (existsSync(path.join(root, ".env"))) {
  const env = readFileSync(path.join(root, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.trim().match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith("#") || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim();
  }
}

const PORT = process.env.SMOKE_PORT || "8788";
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.PROXY_API_KEY || "smoke-test-key";

// Clean, isolated data home so the smoke test never touches real user data.
const dataHome = process.env.SMOKE_DATA_HOME || mkdtempSync(`${tmpdir()}/oc-scw-smoke-`);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function api(method, path, { auth = true, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${KEY}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

console.log("==> starting SDK-based proxy (root handler.js)");
const child = spawn(process.execPath, ["handler.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT,
    PROXY_API_KEY: KEY,
    OPENCODE_DATA_HOME: dataHome,
    OPENCODE_SDK_PORT: process.env.OPENCODE_SDK_PORT || "4097",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`[handler] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[handler:err] ${d}`));

try {
  // wait for the HTTP server to accept connections
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await fetch(BASE + "/v1/health");
      up = r.ok;
    } catch { await sleep(500); }
  }
  if (!up) throw new Error("handler.js never came up on port " + PORT);

  // 1. health
  const health = await api("GET", "/v1/health");
  check("GET /v1/health -> 200", health.status === 200, JSON.stringify(health.json));

  // 2. models with auth (SDK providers, fallback to static ZEN_MODELS)
  const models = await api("GET", "/v1/models");
  const modelList = models.json?.data;
  check(
    "GET /v1/models (auth) -> 200 with list",
    models.status === 200 && Array.isArray(modelList) && modelList.length > 0,
    `${modelList?.length ?? 0} models; first: ${modelList?.[0]?.id ?? "n/a"}`
  );

  // 3. models without auth -> 401
  const modelsNoAuth = await api("GET", "/v1/models", { auth: false });
  check("GET /v1/models (no auth) -> 401", modelsNoAuth.status === 401, `status ${modelsNoAuth.status}`);

  // 4. chat without auth -> 401
  const chatNoAuth = await api("POST", "/v1/chat/completions", {
    auth: false,
    body: { model: "gpt-5.6-luna", messages: [{ role: "user", content: "ping" }] },
  });
  check("POST /v1/chat/completions (no auth) -> 401", chatNoAuth.status === 401, `status ${chatNoAuth.status}`);

  // 5. chat with auth — 200 with real Zen key; well-formed 502 without
  console.log("--> calling /v1/chat/completions (this runs a real opencode prompt; may take a while)...");
  const chat = await api("POST", "/v1/chat/completions", {
    body: {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "Antworte mit einem einzigen Wort: Hallo" }],
    },
  });
  if (chat.status === 200) {
    const content = chat.json?.choices?.[0]?.message?.content;
    check(
      "POST /v1/chat/completions (auth) -> 200 with assistant content",
      typeof content === "string" && content.length > 0,
      `content: ${String(content).slice(0, 80)}`
    );
  } else if (chat.status === 502) {
    check(
      "POST /v1/chat/completions -> well-formed 502 (no valid Zen key)",
      typeof chat.json?.error?.message === "string",
      chat.json?.error?.message?.slice(0, 80)
    );
  } else {
    check("POST /v1/chat/completions (auth)", false, `unexpected status ${chat.status}`);
  }
} catch (err) {
  check("smoke test execution", false, String(err?.stack || err));
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
