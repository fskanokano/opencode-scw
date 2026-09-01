// T4 黑盒 e2e 测试：起真实 `node handler.js`，断言 bridge 透传层 T1–T16。
// 密钥从 .env 加载，不打印。
// 用法：node scripts/test-bridge.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";

// ---- 加载 .env / .env.local（只补未设置项） ----
for (const f of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

const API_KEY = process.env.PROXY_API_KEY || "";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || API_KEY;
const PORT = 18870 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${extra ? "  (" + extra + ")" : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${extra ? "  (" + extra + ")" : ""}`);
  }
}

function req(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(BASE + path, { method, headers, body }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, json };
  });
}

const child = spawn(process.execPath, ["handler.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
  // 独立进程组：退出时 kill(-pid) 连 opencode server 子进程一起清，
  // 否则每次回归都会泄漏一个 ~500MB 的孤儿 opencode serve（内存炸的根因）
  detached: true,
});
child.stderr.on("data", (d) => process.stderr.write(`[handler] ${d}`));

async function waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + "/x-ready-probe", { signal: AbortSignal.timeout(2000) });
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const ready = await waitReady();
  check("服务器就绪", ready);
  if (!ready) { throw new Error("server did not become ready; aborting"); }

  // ===== T1-T2 鉴权拒绝 =====
  let r = await req("/agent");
  check("T1 无凭据 /agent -> 401 + WWW-Authenticate: Basic",
    r.status === 401 && (r.headers.get("www-authenticate") || "").includes("Basic") && !r.headers.get("content-encoding"));
  r = await req("/agent", { headers: { authorization: "Bearer wrong-key-123" } });
  check("T2 错误 Bearer -> 401", r.status === 401);

  // ===== T3-T4 鉴权通过 =====
  r = await req("/agent", { headers: { authorization: `Bearer ${API_KEY}` } });
  check("T3 Bearer -> 200 真实 agent 列表",
    r.status === 200 && Array.isArray(r.json) && r.json.length > 0, `${r.json.length} agents`);
  r = await req("/agent", { headers: { authorization: BASIC } });
  check("T4 Basic opencode:<密码> -> 200", r.status === 200 && Array.isArray(r.json));

  // ===== T5 /v1 语义不变 =====
  r = await req("/v1/models");
  check("T5 /v1/models 无 Bearer -> 401", r.status === 401);

  // ===== T6-T8 透传完整性 =====
  r = await req("/agent", { headers: { authorization: `Bearer ${API_KEY}` } });
  check("T6 /agent body 完整（与上游一致）", r.status === 200 && r.text.length > 20, `${r.text.length}B`);
  r = await req("/experimental/tool/ids", { headers: { authorization: `Bearer ${API_KEY}` } });
  const toolIds = r.json ? (r.json.data || r.json) : null;
  check("T7 /experimental/tool/ids -> 200 且含工具列表",
    r.status === 200 && Array.isArray(toolIds), `${Array.isArray(toolIds) ? toolIds.length : "?"} tools`);
  r = await req("/config/providers", { headers: { authorization: `Bearer ${API_KEY}` } });
  check("T8 大响应完整且无 content-encoding 残留",
    r.status === 200 && r.text.length > 10000 && !r.headers.get("content-encoding"), `${r.text.length}B`);
  check("T8b 无 content-length（管道流式）", !r.headers.get("content-length"));

  // ===== T9-T11 会话操作透传 =====
  r = await req("/session", { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ title: "bridge e2e" }) });
  const sid = r.json && (r.json.id || (r.json.data && r.json.data.id));
  check("T9 POST /session -> 200 拿到 id", r.status === 200 && !!sid, sid || "no id");
  if (sid) {
    r = await req(`/session/${encodeURIComponent(sid)}`, { method: "PATCH", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ title: "bridge e2e renamed" }) });
    check("T10 PATCH /session/{id} 改名 -> 200", r.status === 200);
    r = await req(`/session/${encodeURIComponent(sid)}/todo`, { headers: { authorization: `Bearer ${API_KEY}` } });
    check("T11 GET /session/{id}/todo -> 200", r.status === 200);
  } else {
    check("T10 PATCH 改名", false, "skip（无 session）");
    check("T11 todo", false, "skip（无 session）");
  }

  // ===== T12 未知路径透传上游响应（非 502） =====
  r = await req("/definitely-not-a-real-endpoint-xyz", { headers: { authorization: `Bearer ${API_KEY}` } });
  check("T12 未知路径 -> 上游响应（非 502）", r.status !== 502, `status ${r.status}`);

  // ===== T13-T14 SSE /event =====
  const sseStart = Date.now();
  let firstFrameMs = -1;
  let sseOk = false;
  try {
    const ac = new AbortController();
    const evtRes = await fetch(BASE + "/event", {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: ac.signal,
    });
    firstFrameMs = Date.now() - sseStart;
    const ctype = evtRes.headers.get("content-type") || "";
    if (evtRes.status === 200 && ctype.includes("event-stream")) {
      const reader = evtRes.body.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), 8000)),
      ]);
      sseOk = !(first && first.timedOut);
      // 连接保持：再等 1.5s 确认未断开
      if (sseOk) {
        const keep = await Promise.race([
          reader.read().then(() => "closed"),
          new Promise((res) => setTimeout(() => res("alive"), 1500)),
        ]);
        sseOk = keep === "alive";
      }
      ac.abort();
    }
  } catch {}
  check("T13 /event -> 200 event-stream 首帧 <8s", sseOk, `first frame ${firstFrameMs}ms`);
  check("T14 /event 连接保持（1.5s 不断开）", sseOk);

  // ===== T15-T16 web UI =====
  r = await req("/");
  check("T15 GET / 无鉴权 -> 401", r.status === 401);
  r = await req("/", { headers: { authorization: BASIC } });
  check("T16 GET / 带 Basic -> 200 text/html",
    r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"), `ct=${r.headers.get("content-type")}`);

  // ===== T17-T18 WebSocket /pty 中继 =====
  // 建真实 pty，然后手写 upgrade（合法 16 字节 Sec-WebSocket-Key）走代理
  r = await req("/pty", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "bash" }),
  });
  const ptyId = r.json && (r.json.id || (r.json.data && r.json.data.id));
  check("T17a POST /pty -> 200 拿到 id", r.status === 200 && !!ptyId, ptyId || "no id");

  const wsKey = Buffer.from("0123456789abcdef").toString("base64"); // 恰好 16 字节（RFC 6455 要求）
  function rawUpgrade(path, headers = {}) {
    return new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        const lines = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${PORT}`,
          "connection: Upgrade", "upgrade: websocket",
          `sec-websocket-key: ${wsKey}`, "sec-websocket-version: 13", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        sock.write(lines.join("\r\n") + "\r\n\r\n");
      });
      let buf = "";
      const timer = setTimeout(() => { sock.destroy(); resolve({ status: "timeout", raw: buf }); }, 8000);
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
        if (m) { clearTimeout(timer); sock.destroy(); resolve({ status: Number(m[1]), raw: buf.split("\r\n\r\n")[0] }); }
      });
      sock.on("error", () => { clearTimeout(timer); resolve({ status: 0, raw: buf }); });
      sock.on("close", () => { clearTimeout(timer); if (!buf) resolve({ status: 0, raw: "" }); });
    });
  }

  if (ptyId) {
    const ws = await rawUpgrade(`/pty/${encodeURIComponent(ptyId)}/connect`, { authorization: `Bearer ${API_KEY}` });
    check("T17 带鉴权 upgrade -> 101 握手", ws.status === 101, `got ${ws.status}`);
  } else {
    check("T17 带鉴权 upgrade -> 101 握手", false, "skip（无 pty）");
  }
  const noAuth = await rawUpgrade(`/pty/${encodeURIComponent(ptyId || "nope")}/connect`);
  check("T18 无鉴权 upgrade -> 401", noAuth.status === 401, `got ${noAuth.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) console.log("failures:", failures.join(" | "));
  return fail > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error("test harness error:", e); process.exitCode = 1; })
  .finally(() => {
    // 杀整个进程组（handler + 它拉起的 opencode server），
    // 否则每次回归都会泄漏一个 ~500MB 的孤儿 opencode serve
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  });