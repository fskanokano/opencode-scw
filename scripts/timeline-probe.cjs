// 代理层时间线验证：同用户问题 + xhigh，走 /v1 流式（新增量路径）。
// 输出：reasoning 总量/首帧时间、content 首帧时间、帧间隔分布（判断是否\n// 仍\"停顿后整块腹泻\"）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

for (const f of [".env", ".env.local"]) {
  try {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
try {
  const p = path.join(os.homedir(), ".freebuff", "env.json");
  if (fs.existsSync(p)) Object.assign(process.env, JSON.parse(fs.readFileSync(p, "utf8")));
} catch {}

const KEY = process.env.PROXY_API_KEY || "";
const LIVE = process.env.LIVE_URL; // 非空：直接打线上实例（不 spawn）
const PORT = 18100 + Math.floor(Math.random() * 200);
const BASE = process.env.LIVE_URL || `http://127.0.0.1:${PORT}`;
const Q = process.env.QUESTION || "帮我调研一下目前市场上性价比最高的coding plan套餐";
const EFFORT = process.env.EFFORT || "xhigh"; // reasoning_effort 值或空串(不传)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let child = null;
  let boot = "";
  if (!LIVE) {
    child = spawn(process.execPath, ["handler.js"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 独立进程组，退出时 kill(-pid) 连 opencode server 一起清
    });
    child.stdout.on("data", (d) => { boot += d; });
    child.stderr.on("data", (d) => { boot += d; });
  }
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/v1/health`, {
          headers: { authorization: `Bearer ${KEY}` },
          signal: AbortSignal.timeout(1500),
        });
        up = r.status === 200;
      } catch {}
      if (!up) await sleep(1000);
    }
    if (!up) throw new Error("not ready\n" + boot.slice(0, 1500));

    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.2-contributor-free",
        stream: true,
        ...(EFFORT ? { reasoning_effort: EFFORT } : {}),
        messages: [{ role: "user", content: Q }],
      }),
    });
    console.log("status:", res.status);
    if (!res.ok || !res.body) { console.log("BODY:", await res.text().catch(() => "")); return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let reasoningChars = 0, contentChars = 0;
    let firstReasoningAt = null, firstContentAt = null, lastEventAt = null;
    const gaps = []; // content 帧间隔（ms）
    const reasonSamples = [];
    let doneReasoning = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
          if (!delta) continue;
          const now = Date.now() - t0;
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            if (firstReasoningAt === null) firstReasoningAt = now;
            if (reasonSamples.length < 3) reasonSamples.push(delta.reasoning_content);
          }
          if (typeof delta.content === "string" && delta.content) {
            if (firstContentAt === null) firstContentAt = now;
            else if (lastEventAt !== null) gaps.push(now - lastEventAt);
            lastEventAt = now;
            contentChars += delta.content.length;
          }
        }
      }
    }
    const total = Date.now() - t0;
    const avgGap = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(0) : "-";
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    console.log(`total=${(total / 1000).toFixed(1)}s`);
    console.log(`reasoning: +${firstReasoningAt === null ? "-" : (firstReasoningAt / 1000).toFixed(1)}s 首帧, ${reasoningChars} chars`);
    console.log(`content:   +${firstContentAt === null ? "-" : (firstContentAt / 1000).toFixed(1)}s 首帧, ${contentChars} chars, ${gaps.length} 帧, avgGap=${avgGap}ms maxGap=${maxGap}ms`);
    if (reasonSamples.length) console.log("reasoning 样例:", JSON.stringify(reasonSamples[0].slice(0, 50)));
    const spread = firstContentAt !== null ? (lastEventAt - firstContentAt) : 0;
    console.log(spread > 2000 ? "RESULT: PASS (content 增量铺开 over " + (spread / 1000).toFixed(1) + "s)" : "RESULT: FAIL? content 集中到达 spread=" + spread + "ms");
    process.exitCode = 0;
  } catch (e) {
    console.log("RESULT: FAIL", e.message);
    process.exitCode = 1;
  } finally {
    // 必须杀整个进程组（handler + 其拉起的 opencode server），否则每轮泄漏 ~500MB
    if (child) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }
    setTimeout(() => process.exit(), 300);
  }
})();