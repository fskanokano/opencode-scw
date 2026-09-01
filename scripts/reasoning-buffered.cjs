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
(async () => {
  const res = await fetch("http://127.0.0.1:8787/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      stream: false,
      // argv[2]=问题 argv[3]=reasoning_effort（缺省 high）
      ...(process.argv[3] !== "none" ? { reasoning_effort: process.argv[3] || "high" } : {}),
      messages: [{ role: "user", content: process.argv[2] || "请用1句话回答：9.9和9.11哪个大？并说明为什么容易答错。" }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  console.log("status:", res.status);
  console.log("message keys:", msg ? Object.keys(msg).join(",") : "none");
  console.log("reasoning_content:", JSON.stringify((msg && msg.reasoning_content || "").slice(0, 60)));
  console.log("content:", JSON.stringify((msg && msg.content || "").slice(0, 40)));
})().catch((e) => console.log("ERR", e.message));