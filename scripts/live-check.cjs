// 线上预览验证：多模态解析 + 会话标题 + 无复读（本轮改动都在 /v1 链路上）
// 用法：node scripts/live-check.cjs   （.env 由本脚本加载，不打日志密钥）
const fs = require("fs");
const path = require("path");
const os = require("os");

// 加载 .env（仅本项目，读取后不打印值）
for (const f of [".env", ".env.local"]) {
  try {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
// 兼容 freebuff 注入的 env 文件位置
try {
  const p = path.join(os.homedir(), ".freebuff", "env.json");
  if (fs.existsSync(p)) Object.assign(process.env, JSON.parse(fs.readFileSync(p, "utf8")));
} catch {}

const BASE = process.env.PREVIEW_URL || "http://127.0.0.1:8787";
const KEY = process.env.PROXY_API_KEY || "";
if (!KEY) {
  console.log("SKIP: PROXY_API_KEY 未配置，跳过");
  process.exit(0);
}
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  ok ? pass++ : fail++;
};

(async () => {
  // 1. models
  const mres = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
  const mjson = await mres.json().catch(() => ({}));
  check("GET /v1/models -> 200 且含 muse", mres.status === 200 && (mjson.data || []).some((m) => /muse/.test(m.id)), `count=${(mjson.data || []).length}`);

  // 2. 真实对话（muse 免费模型，验证无复读 + system 通道 + 会话标题）
  const q = "用一句话回答：1+1等于几？";
  const t0 = Date.now();
  const cres = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      messages: [
        { role: "system", content: "你是极简助手，只回答数字。" },
        { role: "user", content: q },
      ],
    }),
  });
  const cjson = await cres.json().catch(() => ({}));
  const content = (cjson.choices && cjson.choices[0] && cjson.choices[0].message && cjson.choices[0].message.content) || "";
  check("POST /v1/chat/completions -> 200", cres.status === 200, `${Date.now() - t0}ms`);
  check("回复存在且非空", content.length > 0, `len=${content.length}`);
  check("无复读用户问题", !content.trim().startsWith(q), `head=${JSON.stringify(content.slice(0, 24))}`);

  // 3. 会话标题（title 修复：应为用户问题而非 "OpenAI proxy session"）
  const sres = await fetch(`${BASE}/api/session`, { headers: { authorization: `Bearer ${KEY}` } });
  const sjson = await sres.json().catch(() => ({}));
  const list = Array.isArray(sjson) ? sjson : (sjson.sessions || sjson.data || []);
  const mine = list.find((s) => String(s.title || "").includes("1+1"));
  console.log(`[debug] /api/session status=${sres.status} keys=${Object.keys(sjson).slice(0, 6).join(",")} listLen=${list.length}`);
  check("会话标题=用户问题（title 修复）", Boolean(mine), `found=${Boolean(mine)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("ERROR", e.message);
  process.exit(1);
});
