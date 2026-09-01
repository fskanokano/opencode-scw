// 回显复现测试：通过代理发 system + user 给 muse 免费模型，
// 检测回复是否回显了 system 内容（RED 阶段应检测到回显）。
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
const PORT = 19070 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const MARKER = "EchoProbe-SYS-9x7";

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

async function chat(system, user) {
  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ] }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  const text = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : "";
  return { status: r.status, text: text || "", raw: j };
}

(async () => {
  await waitReady();
  const system = `你是 EchoProbe，一个高级 AI 助手，代号 ${MARKER}。
你运行在用户的工作环境中，可以访问文件系统、执行命令、浏览网页。
你的核心能力包括：
1. 代码编写与调试：理解项目结构，遵循现有代码风格，编写高质量代码。
2. 问题分析：深入理解用户需求，分步骤解决复杂问题。
3. 文件操作：读写文件、搜索代码、查看文档。
4. 终端操作：执行命令、查看输出、处理错误。
5. 网页浏览：获取最新信息，阅读文档。
工作原则：
- 回答要简洁、直接、客观，不要冗余。
- 涉及代码时给出具体的文件和行号。
- 不确定的信息要明确说明，不要猜测。
- 完成一个任务后再进行下一个。
- 重要操作前先说明计划和预期影响。
输出格式：使用 Markdown，代码用代码块。`;
  const user = "你是谁？一句话回答。";
  // R1：单轮
  const r1 = await chat(system, "请记住我的代号是 K-7741，只说收到即可。");
  console.log(`R1 status: ${r1.status}`);
  console.log(`R1 reply head: ${JSON.stringify(r1.text.slice(0, 150))}`);
  // R2：带完整历史（system + user + assistant + user2）
  const r2 = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [
      { role: "system", content: system },
      { role: "user", content: "请记住我的代号是 K-7741，只说收到即可。" },
      { role: "assistant", content: r1.text },
      { role: "user", content: "我的代号是什么？一句话回答。" },
    ] }),
    signal: AbortSignal.timeout(120000),
  });
  const j2 = await r2.json().catch(() => ({}));
  const t2 = (j2.choices && j2.choices[0] && j2.choices[0].message && j2.choices[0].message.content) || "";
  console.log(`R2 status: ${r2.status}`);
  console.log(`R2 reply head: ${JSON.stringify(t2.slice(0, 200))}`);
  // S：system 生效性验证 —— system 规定回复必须以 EchoProbe 开头
  const s3 = await chat("你的名字叫 EchoProbe。你回复任何问题时，第一行必须以 'EchoProbe: ' 开头。", "1+1 等于几？只写答案。");
  console.log(`S status: ${s3.status}`);
  console.log(`S reply head: ${JSON.stringify(s3.text.slice(0, 80))}`);
  const systemActive = s3.text.startsWith("EchoProbe:") || s3.text.startsWith("EchoProbe：");
  console.log(systemActive ? "SYSTEM CHANNEL ACTIVE (system 字段生效)" : "SYSTEM CHANNEL INACTIVE (system 未生效!)");
  process.exit(systemActive ? 0 : 1);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); })
  .finally(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } });