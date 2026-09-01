// 流式粒度探针：stream=true 发长任务，记录每个 delta 的到达时刻/大小/内容片段，
// 判断 muse 回复是逐段增量还是整块突现。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

for (const f of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const API_KEY = process.env.PROXY_API_KEY || "";
const MODEL = "muse-spark-1.2-contributor-free";
const PORT = 19470 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["handler.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
child.stderr.on("data", (d) => process.stderr.write(`[handler] ${d}`));

async function waitReady(t = 30000) {
  const s = Date.now();
  while (Date.now() - s < t) {
    try { const r = await fetch(BASE + "/x", { signal: AbortSignal.timeout(2000) }); if (r.status) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("server not ready");
}

(async () => {
  await waitReady();
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "帮我调研一下目前市场上性价比最高的coding plan套餐" }] }),
    signal: AbortSignal.timeout(150000),
  });
  console.log("status:", res.status, res.headers.get("content-type"));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
  let count = 0;
  let totalChars = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) continue;
      const text = delta.content || delta.reasoning_content || "";
      const role = delta.reasoning_content !== undefined ? "reasoning" : "text";
      if (!text) continue;
      count++;
      totalChars += text.length;
      console.log(`[+${Date.now() - t0}ms] ${role} +${text.length}ch: ${JSON.stringify(text.slice(0, 60))}`);
    }
  }
  console.log(`done: ${count} deltas, ${totalChars} chars total`);
  process.exit(0);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); })
  .finally(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } });