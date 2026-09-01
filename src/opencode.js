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

// ---- 内部凭据工具（共享 opencode server 设置密码后，所有内部调用需带 Basic） ----
// 密码：OPENCODE_SERVER_PASSWORD 优先，缺省回退 PROXY_API_KEY（"一把钥匙开两道门"）。
function serverPassword() {
  return process.env.OPENCODE_SERVER_PASSWORD || process.env.PROXY_API_KEY || "";
}
module.exports.serverPassword = serverPassword;

function basicAuthHeader() {
  const pw = serverPassword();
  if (!pw) return null;
  return "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
}
module.exports.basicAuthHeader = basicAuthHeader;

// 内部调用统一入口：给每次到 opencode server 的请求带上 Basic 凭据；
// 不覆盖调用方已显式设置的 authorization 头。
async function serverFetch(url, options) {
  const auth = basicAuthHeader();
  const headers = { ...((options && options.headers) || {}) };
  if (auth && !headers.authorization) headers.authorization = auth;
  return fetch(url, { ...(options || {}), headers });
}
module.exports.serverFetch = serverFetch;

// ---- 思考强度映射（opencode 原生 variant 机制） ----
// Minis 等 OpenAI 客户端通过 reasoning_effort 表达思考强度；opencode 的消息
// 协议用 variant 字段选择模型预置的推理变体（muse 有 minimal/low/medium/
// high/xhigh，每个变体带 reasoningEffort）。这里做双向兼容映射：支持
// reasoning_effort / reasoningEffort / 推理式 reasoning.effort；白名单以外
// 的值（含 none/空）不传 variant，走模型默认。
const VARIANT_WHITELIST = new Set(["minimal", "low", "medium", "high", "xhigh"]);
function mapVariant(body) {
  const b = body && typeof body === "object" ? body : {};
  const eff =
    b.reasoning_effort ??
    b.reasoningEffort ??
    (b.reasoning && b.reasoning.effort) ??
    null;
  const v = String(eff == null ? "" : eff).trim().toLowerCase();
  return VARIANT_WHITELIST.has(v) ? v : undefined;
}
module.exports.mapVariant = mapVariant;

async function createOpencode(options) {
  const { createOpencode } = await import("@opencode-ai/sdk");
  return createOpencode(options);
}

// 共享 opencode server 的 HTTP 地址（createOpencode 返回 server.url），
// 供流式通路直连 /event 事件总线与 HTTP API 使用。
// 用函数声明（有提升），bridgePrompt 等早于本行定义的函数也能调用。
function getServerUrl() {
  return (instance && instance.server && instance.server.url) || null;
}
module.exports.getServerUrl = getServerUrl;

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
      // provider id 是 "opencode"（opencode.ai Zen，见 https://opencode.ai/docs/zen：
      // 模型 id 形如 opencode/gpt-5.5）。旧代码用的 "zen" 键名已不被识别。
      fs.writeFileSync(
        path.join(dataHome, "opencode", "auth.json"),
        JSON.stringify({ opencode: { type: "api", key: zenKey } }, null, 2)
      );
    }

    const env = {
      HOME: dataHome,
      // opencode 读凭据的位置是 $XDG_DATA_HOME/opencode/auth.json，
      // 所以 XDG_DATA_HOME 必须指向数据根目录（auth.json 已写入 <root>/opencode/）。
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: process.env.OPENCODE_CONFIG_HOME || path.join(dataHome, "config"),
      XDG_CACHE_HOME: path.join(dataHome, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      NO_COLOR: "1",
    };
    // 开启 server 原生 Basic 鉴权：密码 = OPENCODE_SERVER_PASSWORD，缺省回退
    // PROXY_API_KEY（T2 已把所有内部调用换成 serverFetch，带同样的 Basic）。
    const pw = serverPassword();
    if (pw && !env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = pw;
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
      timeout: Number(process.env.OPENCODE_SDK_STARTUP_TIMEOUT_MS || 20000),
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
 * ============ 原生 opencode 桥接 ============
 * 对话完全走 opencode 的原生 HTTP API（与官方 SDK 等价、与 function/
 * handler.js 同一套协议）：
 *   POST /session                      创建会话
 *   GET  /event                        SSE 事件总线（增量 part + 权限请求）
 *   POST /session/:id/message          触发 agent 执行
 *   POST /session/:id/permissions/:id  自动放行工具权限（可关闭）
 * SDK 仅用于拉起共享 server，对话请求不经 SDK 中转，保证"原样"桥接。
 */

function autoApproveEnabled() {
  // 默认自动放行（调用方已通过 PROXY_API_KEY 鉴权，视为可信）；
  // 设 OPENCODE_AUTO_APPROVE=false 关闭。
  return process.env.OPENCODE_AUTO_APPROVE !== "false";
}

async function postJson(url, body) {
  const res = await serverFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 订阅 opencode 事件总线；handlers.onPart(part) / handlers.onPermission(id)
async function subscribeEvents(serverUrl, sessionID, handlers) {
  const ctrl = new AbortController();
  const loop = (async () => {
    try {
      const res = await serverFetch(`${serverUrl}/event`, { signal: ctrl.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = raw
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (!ev || typeof ev !== "object") continue;
          const props = ev.properties;
          if (!props || typeof props !== "object") continue;
          if (props.sessionID && sessionID && props.sessionID !== sessionID) continue;
          if (ev.type === "message.part.updated" && props.part && handlers.onPart) {
            handlers.onPart(props.part);
          } else if (ev.type === "permission.asked" && props.id && handlers.onPermission) {
            handlers.onPermission(props.id);
          }
        }
      }
    } catch (_e) {
      /* 事件流关闭/中断 */
    }
  })();
  return { ctrl, loop };
}

function extractTokens(info) {
  const t = (info && info.tokens) || {};
  return {
    prompt_tokens: t.input || 0,
    completion_tokens: (t.output || 0) + (t.reasoning || 0),
    total_tokens: t.total || 0,
  };
}

/**
 * 桥接一次 assistant 回复（复用共享 opencode server 的原生 HTTP API）。
 * @param {{ prompt: string, model?: string, sessionID?: string|null,
 *           onPart?: (part: object) => void }} opts
 * @returns {{ ok: boolean, text: string, reasoning: string, sessionID: string|null,
 *            code: number, statusMessage: string, tokens: object|null,
 *            info: object|null, parts: array }}
 */
async function bridgePrompt(opts) {
  const serverUrl = getServerUrl();
  if (!serverUrl) throw new Error("opencode server 未就绪");

  let sessionId = opts.sessionID || null;
  if (!sessionId) {
    const { status, json } = await postJson(`${serverUrl}/session`, {
      title: (opts.prompt || "OpenAI proxy session").slice(0, 60),
    });
    if (status !== 200 || !json.id) throw new Error("opencode 会话创建失败");
    sessionId = json.id;
  }

  const { ctrl, loop } = await subscribeEvents(serverUrl, sessionId, {
    onPart: (part) => {
      if (opts.onPart) opts.onPart(part);
    },
    onPermission: (id) => {
      if (!autoApproveEnabled()) return;
      postJson(`${serverUrl}/session/${encodeURIComponent(sessionId)}/permissions/${id}`, {
        response: "allow",
        remember: true,
      }).catch(() => {});
    },
  });

  try {
    const body = {
      parts: [{ type: "text", text: opts.prompt }, ...(opts.fileParts || [])],
      ...(opts.model ? { model: parseModelId(opts.model) } : {}),
      // opencode 原生 system 通道：system 作为独立 system 消息注入，
      // 不复刻代理的 "[系统指令]..." 明文包装（弱模型会复读 user 文本里的长指令块）
      ...(opts.system ? { system: opts.system } : {}),
      // 思考强度：opencode 原生 variant 机制（muse 等模型的 reasoningEffort 变体）
      ...(opts.variant ? { variant: opts.variant } : {}),
    };
    const res = await serverFetch(`${serverUrl}/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (json && (json.message || (json.error && json.error.message))) || `HTTP ${res.status}`;
      return {
        ok: false, text: "", reasoning: "", sessionID: sessionId, code: res.status,
        statusMessage: msg, tokens: null, info: null, parts: [],
      };
    }
    // 事件流是长连接，不等待（权限响应已在事件回调里发出，agent 会继续完成回合）
    const info = json.info || null;
    const parts = json.parts || [];
    const text = extractTextParts(parts);
    const reasoning = extractReasoningParts(parts);
    return {
      ok: Boolean(text),
      sessionID: sessionId,
      statusMessage: text ? "ok" : "opencode 没有返回任何文本",
      code: 0,
      text,
      reasoning,
      tokens: extractTokens(info),
      info,
      parts,
    };
  } finally {
    ctrl.abort();
  }
}

/**
 * 执行一次 assistant 回复（复用共享 opencode server）。
 * @param {object} _oc 兼容旧签名（不再使用，SDK client 仅用于启动/查询）
 * @param {{ prompt: string, model?: string, sessionID?: string|null, system?: string, fileParts?: Array<object>, variant?: string }} opts
 *   opts.model 形如 "opencode/gpt-5.6-luna"; opts.system 走 opencode 原生 system 通道;
 *   opts.variant 为思考强度变体（minimal/low/medium/high/xhigh，来自 OpenAI reasoning_effort）;
 *   opts.fileParts 为多模态 file part（{type:"file",mime,url}）
 * @returns {{ ok: boolean, text: string, reasoning: string, sessionID: string|null,
 *             code: number, stderr: string, statusMessage: string, tokens: object|null }}
 */
module.exports.runPrompt = async function runPrompt(_oc, opts) {
  try {
    const r = await bridgePrompt({
      ...opts,
      ...(opts && opts.system ? { system: opts.system } : {}),
    });
    return {
      ok: r.ok,
      text: r.text,
      reasoning: r.reasoning || "",
      sessionID: r.sessionID,
      code: r.code || 0,
      stderr: r.ok ? "" : r.statusMessage,
      statusMessage: r.statusMessage,
      tokens: r.tokens,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      reasoning: "",
      sessionID: opts.sessionID || null,
      code: 1,
      stderr: String((err && err.message) || err),
      statusMessage: String((err && err.message) || err),
      tokens: null,
    };
  }
};

module.exports.bridgePrompt = bridgePrompt;
module.exports.extractTokens = extractTokens;

/** 获取真实模型清单（opencode /config/providers），失败时返回 null 由调用方兜底。
 * 签名保留 oc 参数（调用处 handleModels 兼容），内部不再走 SDK client，
 * 直接原生 HTTP + Basic 凭据。 */
module.exports.fetchProviders = async function fetchProviders(oc) {
  try {
    const serverUrl = getServerUrl();
    if (!serverUrl) return null;
    const res = await serverFetch(`${serverUrl}/config/providers`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
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

// "opencode/gpt-5.6-luna" -> { providerID: "opencode", modelID: "gpt-5.6-luna" }
function parseModelId(model) {
  const raw = String(model || "");
  const idx = raw.indexOf("/");
  if (idx > 0) {
    return { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) };
  }
  return { providerID: "opencode", modelID: raw };
}

// 从 opencode message parts 里抽取助手文本（type === "text"）。
function extractTextParts(parts) {
  return (parts || [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// 从 opencode message parts 里抽取思考内容（type === "reasoning"）。
function extractReasoningParts(parts) {
  return (parts || [])
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}
