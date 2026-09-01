// GREEN 验证：reasoning_effort → opencode variant 透传后，思考内容应回到
// reasoning_content（流式 delta + 非流式 message 字段）。
// 自包含：加载 .env → spawn 真实 handler（随机端口）→ 双路径断言 → 清理。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// ---- 加载环境（.env / .env.local / ~/.freebuff/env.json）----
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
const PORT = 18100 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const Q = "请用1句话回答：9.9和9.11哪个大？并说明为什么容易答错。";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/v1/health`, {
        headers: { authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(1500),
      });
      if (r.status === 200) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function streamingProbe(effort) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: "user", content: Q }],
    }),
  });
  if (!res.ok || !res.body) return { status: res.status, reasoning: 0, content: 0, head: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", reasoning = 0, content = 0, head = "";
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
        try {
          const ev = JSON.parse(data);
          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
          if (!delta) continue;
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoning += delta.reasoning_content.length;
            if (!head) head = delta.reasoning_content.slice(0, 60);
          }
          if (typeof delta.content === "string" && delta.content) content += delta.content.length;
        } catch {}
      }
    }
  }
  return { status: res.status, reasoning, content, head };
}

async function bufferedProbe(effort) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      stream: false,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: "user", content: Q }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return {
    status: res.status,
    reasoning: (msg && msg.reasoning_content) || "",
    content: (msg && msg.content) || "",
  };
}

(async () => {
  const child = spawn(process.execPath, ["handler.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 独立进程组，退出时 kill(-pid) 连 opencode server 一起清
  });
  let bootLog = "";
  child.stdout.on("data", (d) => { bootLog += d; });
  child.stderr.on("data", (d) => { bootLog += d; });

  try {
    if (!(await waitReady())) throw new Error("handler 未就绪\n" + bootLog.slice(0, 2000));
    console.log("handler ready on", BASE);

    // 1) 流式 + high
    const s1 = await streamingProbe("high");
    console.log(`[stream]  effort=high    status=${s1.status} reasoning_chars=${s1.reasoning} content_chars=${s1.content}`);
    if (s1.reasoning > 0) console.log("         head:", JSON.stringify(s1.head));

    // 2) 非流式 + high
    const b1 = await bufferedProbe("high");
    console.log(`[buffer]  effort=high    status=${b1.status} reasoning_chars=${b1.reasoning.length}`);
    if (b1.reasoning) console.log("         head:", JSON.stringify(b1.reasoning.slice(0, 60)));

    // 3) 对照：不传 effort（不应报错）
    const s2 = await streamingProbe("");
    console.log(`[stream]  effort=none    status=${s2.status} reasoning_chars=${s2.reasoning} content_chars=${s2.content}`);
    const b2 = await bufferedProbe("");
    console.log(`[buffer]  effort=none    status=${b2.status} content_chars=${b2.content.length}`);

    const pass = s1.status === 200 && b1.status === 200 && s2.status === 200 && b2.status === 200;
    console.log(pass ? "RESULT: PASS (all 200)" : "RESULT: FAIL");
    if (!pass) console.log(bootLog.slice(-2000));
    process.exitCode = pass ? 0 : 1;
  } catch (e) {
    console.log("RESULT: FAIL", e.message);
    process.exitCode = 1;
  } finally {
    child.kill("SIGKILL");
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    setTimeout(() => process.exit(), 500);
  }
})();