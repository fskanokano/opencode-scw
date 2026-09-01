const fs = require("fs");
const os = require("os");
const path = require("path");
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
const effort = process.argv[2] || "high";
(async () => {
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:8787/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      stream: true,
      reasoning_effort: effort,
      messages: [
        { role: "user", content: "请用1句话回答：9.9和9.11哪个大？并说明为什么容易答错。" },
      ],
    }),
  });
  console.log("status:", res.status, "content-type:", res.headers.get("content-type"));
  if (!res.ok || !res.body) return console.log("FAILED", await res.text().catch(() => ""));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", reasoningChars = 0, contentChars = 0, parts = 0;
  let reasoningHead = "";
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
            reasoningChars += delta.reasoning_content.length;
            if (!reasoningHead) reasoningHead = delta.reasoning_content.slice(0, 50);
            parts++;
          }
          if (typeof delta.content === "string" && delta.content) contentChars += delta.content.length;
        } catch {}
      }
    }
  }
  console.log(`elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s reasoning_deltas=${parts} reasoning_chars=${reasoningChars} content_chars=${contentChars}`);
  if (reasoningHead) console.log("reasoning head:", JSON.stringify(reasoningHead));
  console.log(reasoningChars > 0 ? "RESULT: HAS reasoning" : "RESULT: NO reasoning");
})().catch((e) => console.log("ERR", e.message));