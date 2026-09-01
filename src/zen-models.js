// OpenCode Zen 模型清单（来自 https://opencode.ai/docs/zen/）
// 我们只暴露 Zen 模型，因为整个代理是"原汁原味 opencode + Zen"
// 的部署方式。要覆盖更多模型，往这个数组里加 id 即可。
module.exports.ZEN_MODELS = [
  // GPT 系
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  // Anthropic / Claude 系
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  // Google / Gemini 系
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-3-flash",
  // xAI / Grok 系
  "grok-4.6",
  "grok-4.5",
  "grok-build-0.1",
  // 国产 / 开源系
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
];

module.exports.DEFAULT_MODEL = "gpt-5.6-luna";

// opencode 内部用 provider/id（例如 opencode/gpt-5.6-luna）来选模型；
// 见 https://opencode.ai/docs/zen —— provider id 是 opencode，旧版代号 zen 已弃用。
// OpenAI 客户端发过来的是裸 id（例如 gpt-5.6-luna），这里做规范化。
module.exports.normalizeModel = function normalizeModel(requested) {
  let raw = (requested && String(requested).trim()) || module.exports.DEFAULT_MODEL;
  if (raw.includes("/")) {
    // 兼容用户直接写 zen/xxx（旧命名）或 opencode/xxx / opencode-go/xxx（保留原样）
    if (raw.startsWith("zen/")) raw = "opencode/" + raw.slice("zen/".length);
    return raw;
  }
  return "opencode/" + raw;
};

// 返回 OpenAI /v1/models 风格的数据
module.exports.modelsPayload = function modelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: module.exports.ZEN_MODELS.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "opencode",
    })),
  };
};