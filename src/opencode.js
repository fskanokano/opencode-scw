// 调用"原汁原味"的 opencode —— 通过官方 @opencode-ai/sdk。
//
// 之前的方式：每个请求 spawn 一次 opencode 可执行文件（重、慢、内存开销大）。
// 现在的方式：把 opencode 当第三方库用 —— npm 安装 @opencode-ai/sdk，
// 用 createOpencode() 启动一个共享的 opencode server 并拿到类型安全
// client，之后所有请求复用同一个 server。opencode 仍然"原汁原味"：
// 大模型对话、agent 工具循环、模型路由全部由 opencode 完成，本项目
// 不实现任何大模型逻辑。
//
// SDK: https://opencode.ai/docs/sdk  (npm: @opencode-ai/sdk)

const DEFAULT_HOST = process.env.OPENCODE_SDK_HOST || "127.0.0.1";
// 0 = 由 SDK 自动选择空闲端口；也可通过 OPENCODE_SDK_PORT 固定。
const DEFAULT_PORT = Number(process.env.OPENCODE_SDK_PORT || 0) || 0;

let instance = null;
let starting = null;

async function createOpencode(options) {
  const { createOpencode } = await import("@opencode-ai/sdk");
  return createOpencode(options);
}

// 幂等地准备运行环境：写入 auth.json（Zen 凭据）并启动共享 opencode server。
module.exports.ensureRuntime = function ensureRuntime() {
  if (instance) return Promise.resolve(instance);
  if (starting) return starting;

  const zenKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY || "";

  starting = (async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    // opencode 从 XDG_DATA_HOME/opencode/auth.json 读取凭据。
    // 把 XDG_DATA_HOME 指到可写目录并写入 zen 凭据，双保险。
    const dataHome =
      process.env.OPENCODE_DATA_HOME || path.join(os.tmpdir(), "opencode-scw-data");
    fs.mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
    if (zenKey) {
      fs.writeFileSync(
        path.join(dataHome, "opencode", "auth.json"),
        JSON.stringify({ zen: { type: "api", key: zenKey } }, null, 2)
      );
    }

    const env = {
      HOME: dataHome,
      XDG_DATA_HOME: path.join(dataHome, "opencode"),
      XDG_CONFIG_HOME: process.env.OPENCODE_CONFIG_HOME || path.join(dataHome, "config"),
      XDG_CACHE_HOME: path.join(dataHome, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      NO_COLOR: "1",
    };
    // SDK 用当前 process.env spawn server，先同步合并我们的环境变量。
    Object.assign(process.env, env);

    // SDK 内部用 cross-spawn 直接执行 `opencode` 命令（走 PATH 查找）：
    // 部署包里二进制放在 <项目根>/bin/opencode，本地开发时 npm 会把
    // opencode-ai 的 bin 软链到 node_modules/.bin，两个目录都放进 PATH。
    const binDir = path.join(__dirname, "..", "bin");
    const npmBin = path.join(__dirname, "..", "node_modules", ".bin");
    process.env.PATH = [binDir, npmBin, process.env.PATH].filter(Boolean).join(path.delimiter);

    // createOpencode() 启动共享 server 并返回类型安全 client。
    // 整个函数进程复用这一个实例 —— 不再每个请求 spawn 一次。
    const oc = await createOpencode({
      hostname: process.env.OPENCODE_SDK_HOST || DEFAULT_HOST,
      port: DEFAULT_PORT,
      timeout: Number(process.env.OPENCODE_SDK_STARTUP_TIMEOUT_MS || 60000),
      config: {},
    });

    instance = oc;
    return oc;
  })();

  starting.finally(() => {
    starting = null;
  });
  return starting;
};

/**
 * 执行一次 assistant 回复（复用共享 opencode server）。
 * @param {object} oc createOpencode() 返回的实例
 * @param {{ prompt: string, model?: string, sessionID?: string|null }} opts
 *   opts.model 形如 "zen/gpt-5.6-luna"
 * @returns {{ ok: boolean, text: string, sessionID: string|null, code: number,
 *             stderr: string, statusMessage: string }}
 */
module.exports.runPrompt = async function runPrompt(oc, opts) {
  try {
    // 会话：复用调用方传入的 sessionID，否则新建。
    let sessionId = opts.sessionID || null;
    if (!sessionId) {
      const created = await oc.client.session.create({
        body: { title: "OpenAI proxy session" },
      });
      sessionId = (created.data && created.data.id) || created.id;
    }

    const result = await oc.client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(opts.model ? { model: parseModelId(opts.model) } : {}),
        parts: [{ type: "text", text: opts.prompt }],
      },
    });

    const parts = (result.data && result.data.parts) || result.parts || [];
    const text = extractTextParts(parts);
    if (!text) {
      return {
        ok: false, text: "", sessionID: sessionId, code: 0, stderr: "",
        statusMessage: "opencode 没有返回任何文本",
      };
    }
    return { ok: true, text, sessionID: sessionId, code: 0, stderr: "", statusMessage: "ok" };
  } catch (err) {
    return {
      ok: false,
      text: "",
      sessionID: opts.sessionID || null,
      code: 1,
      stderr: String((err && err.message) || err),
      statusMessage: String((err && err.message) || err),
    };
  }
};

/** 获取真实模型清单（opencode /config/providers），失败时返回 null 由调用方兜底。 */
module.exports.fetchProviders = async function fetchProviders(oc) {
  try {
    const res = await oc.client.config.providers();
    const data = res.data || res;
    if (data && Array.isArray(data.providers)) {
      const models = [];
      for (const p of data.providers) {
        for (const m of Object.values(p.models || {})) {
          if (m && typeof m === "object" && m.id) {
            models.push({ id: `${p.id}/${m.id}`, owned_by: p.id });
          }
        }
      }
      let defaultModel = null;
      if (data.default && typeof data.default === "object") {
        const k = Object.keys(data.default)[0];
        if (k && data.default[k]) defaultModel = `${k}/${data.default[k]}`;
      }
      return { models, defaultModel };
    }
    return null;
  } catch (_e) {
    return null;
  }
};

// "zen/gpt-5.6-luna" -> { providerID: "zen", modelID: "gpt-5.6-luna" }
function parseModelId(model) {
  const raw = String(model || "");
  const idx = raw.indexOf("/");
  if (idx > 0) {
    return { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) };
  }
  return { providerID: "zen", modelID: raw };
}

// 从 opencode message parts 里抽取助手文本（type === "text"）。
function extractTextParts(parts) {
  return (parts || [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}
