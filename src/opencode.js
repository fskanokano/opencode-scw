// 调用"原汁原味"的 opencode。
//
// 每个请求我们 spawn 一次官方 opencode 可执行文件：
//   opencode run "<用户消息>" --model zen/<id> --format json [--session <id>]
//
// opencode 是可执行体本身，它负责加载 Zen 配置、调用 Zen 大模型、执行
// agent 工具循环。我们的适配层只做一件事：把 OpenAI /v1/chat/completions
// 里的用户提问原封不动地传给 opencode，再把 opencode 返回的助手文本原封
// 不动地翻译回 OpenAI 格式。绝不自己实现任何大模型调用。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const RUNTIME_DIR = path.join(os.tmpdir(), "opencode-scw-runtime");

function resolveBinary() {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(__dirname, "..", "bin", "opencode"),
    process.env.OPENCODE_ARCH
      ? path.join(__dirname, "..", "vendor", "opencode", process.env.OPENCODE_ARCH, "opencode")
      : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (_e) {
      /* keep looking */
    }
  }
  return null;
}

function writeAuth(zk) {
  // opencode 的凭据文件默认在 XDG_DATA_HOME/opencode/auth.json。
  // 我们把 XDG_DATA_HOME 指到可写的临时目录，并额外写入 zen 凭据，
  // 这样即使环境变量没被 opencode 自动读取，也能通过 auth.json 生效。
  const authFile = path.join(RUNTIME_DIR, "data", "opencode", "auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const auth = {};
  try {
    Object.assign(auth, JSON.parse(fs.readFileSync(authFile, "utf8")));
  } catch (_e) {
    /* new file */
  }
  if (zk) auth.zen = { type: "api", key: zk };
  fs.writeFileSync(authFile, JSON.stringify(auth, null, 2));
  return authFile;
}

let runtime = null;
let starting = null;

// 幂等地准备运行环境（可写临时目录 + auth.json + 二进制），返回共享状态。
module.exports.ensureRuntime = function ensureRuntime() {
  if (runtime) return Promise.resolve(runtime);
  if (starting) return starting;

  const zenKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY || "";

  starting = (async () => {
    const bin = resolveBinary();
    if (!bin) {
      throw new Error(
        "找不到 opencode 可执行文件。请先运行 `sh scripts/build.sh` 生成 function.zip，" +
          "或设置 OPENCODE_BIN 指向 opencode 可执行文件。"
      );
    }

    ["home", "data", "config", "cache", "project"].forEach((sub) =>
      fs.mkdirSync(path.join(RUNTIME_DIR, sub), { recursive: true })
    );
    writeAuth(zenKey);

    const env = {
      ...process.env,
      HOME: path.join(RUNTIME_DIR, "home"),
      XDG_DATA_HOME: path.join(RUNTIME_DIR, "data"),
      XDG_CONFIG_HOME: path.join(RUNTIME_DIR, "config"),
      XDG_CACHE_HOME: path.join(RUNTIME_DIR, "cache"),
      OPENCODE_API_KEY: zenKey,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      NO_COLOR: "1",
    };

    runtime = { bin, env, projectDir: path.join(RUNTIME_DIR, "project") };
    return runtime;
  })();

  starting.finally(() => {
    starting = null;
  });
  return starting;
};

// 从 opencode 的 JSON 事件行里抽取助手文本和 sessionID。
//
// `opencode run --format json` 每行输出一个事件对象，形如：
//   {"type":"text","timestamp":...,"sessionID":"...","part":{"type":"text","text":"...","time":{"end":...}}}
// 助手最终可见的答复在 type === "text" 的 part 里。sessionID 出现在任意一行中。
function parseOutput(stdout) {
  const lines = (stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let sessionID = null;
  const textParts = [];
  let fatalError = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue; // 非 JSON 行（日志等）直接跳过
    }
    if (!obj || typeof obj !== "object") continue;
    if (obj.sessionID && !sessionID) sessionID = obj.sessionID;
    if (obj.type === "text" && obj.part && obj.part.type === "text" && obj.part.text) {
      textParts.push(obj.part.text);
    }
    if (obj.type === "error" && obj.error) {
      fatalError =
        typeof obj.error === "string"
          ? obj.error
          : (obj.error && (obj.error.message || JSON.stringify(obj.error))) || "opencode 返回错误";
    }
  }

  return {
    sessionID,
    text: textParts.join("\n\n").trim(),
    fatalError,
    lines,
  };
}

function runProcess(bin, args, env, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_e) {
        /* ignore */
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 用真实 opencode 执行一次 assistant 回复。
 * @returns {{ ok: boolean, text: string, sessionID: string|null, code: number, stderr: string,
 *             statusMessage: string }}
 */
module.exports.runPrompt = async function runPrompt(runtime, opts) {
  const args = ["run", opts.prompt, "--model", opts.model, "--format", "json"];
  if (opts.sessionID) args.push("--session", opts.sessionID);
  const timeoutMs = Number(process.env.OPENCODE_RUN_TIMEOUT_MS || 180000);

  const { code, stdout, stderr } = await runProcess(
    runtime.bin,
    args,
    runtime.env,
    runtime.projectDir,
    timeoutMs
  );

  const parsed = parseOutput(stdout);

  // opencode 可能把找不到模型 / 鉴权失败等写成非零退出码，也可能在 json 事件里带 error
  const errEvent = parsed.fatalError;
  if (!parsed.text && errEvent) {
    return { ok: false, text: "", sessionID: parsed.sessionID, code, stderr: errEvent, statusMessage: errEvent };
  }
  if (!parsed.text && code !== 0) {
    const detail = (stderr || "").trim();
    return { ok: false, text: "", sessionID: parsed.sessionID, code, stderr: detail, statusMessage: detail || `opencode 退出码 ${code}` };
  }
  if (!parsed.text) {
    return { ok: false, text: "", sessionID: parsed.sessionID, code, stderr: "", statusMessage: "opencode 没有返回任何文本" };
  }

  return { ok: true, text: parsed.text, sessionID: parsed.sessionID, code, stderr, statusMessage: "ok" };
};