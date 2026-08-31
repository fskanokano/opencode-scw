# opencode-scw —— 在 Scaleway Serverless Function 里跑"原汁原味"的 opencode

把一个真实的 [OpenCode](https://github.com/anomalyco/opencode) 放进 Scaleway
Serverless Function，外面套一个 OpenAI 兼容接口。你把任意 OpenAI 客户端的
`baseURL` 指到函数的地址，就能当一个"原生 OpenAI 服务"来用——底下跑的都是
真正的 opencode，而不是我们重写的大模型代理。

## 核心思路（重要）

你要求的并不是"用 opencode 命名、我们自己调大模型"，而是一个**网关**：

- 我们的代码**只做转发**：把 `/v1/chat/completions` 里的用户提问原样交给真正的
  opencode 去执行；
- **真正的大模型对话、agent 工具调用全部由 opencode 自己完成**（它加载 Zen
  配置、调 Zen 大模型、跑 agent 循环）；
- 我们再把 opencode 的回复原样翻译回 OpenAI 返回格式。

具体实现是每次请求 `spawn` 一次官方 `opencode run "提问" --model zen/xxx --format json`
子进程。这就是官方 CLI，和你在终端里用的 opencode 完全同一个可执行文件、同一套
模型路由。我们只是在它外面加了 OpenAI 接口的壳和鉴权。

```
你的 OpenAI 客户端
   │  POST /v1/chat/completions   (Bearer PROXY_API_KEY)
   ▼
┌─ Scaleway Serverless Function ───────────────┐
│  适配层（handler/proxy，内嵌在函数里）          │
│     │ spawn                                  │
│     ▼                                        │
│  真实 opencode 可执行文件（opencode run）      │
│     │ 读 OPENCODE_API_KEY  →  Zen 调用大模型   │
│     ▼                                        │
│  opencode 的回复 → 翻译回 OpenAI 格式          │
└───────────────────────────────────────────────┘
```

## 环境变量（只有两个必填）

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_API_KEY` | **opencode Zen 的 API Key**。去 [opencode.ai](https://opencode.ai) 登录创建 Zen 后复制。opencode 原生认这个变量名；适配层也会把它写进 opencode 的 `auth.json`，双保险。 |
| `PROXY_API_KEY` | **你代理函数自己的访问密钥**，任意调用方都必须带 `Authorization: Bearer <PROXY_API_KEY>`。 |

可选变量见 `env.example`（默认模型、opencode 版本、架构、单次执行超时等）。

## 项目结构

```
handler.js              # Scaleway 入口（导出 handle）；node dist/handler.js 也能本地跑
src/opencode.js         # 负责 spawn 真实 opencode、准备可写临时目录和 auth.json
src/proxy.js            # OpenAI 兼容适配层：/v1/models、/v1/chat/completions
src/zen-models.js       # Zen 模型清单 + 模型名规范化（模型 ID 兼容）
scripts/build.sh        # 一键打包 dist/function.zip
scripts/run-local.mjs   # 本地联调启动器（会先打包）
.github/workflows/build-function.yml  # GitHub Actions 一键打包
env.example             # 环境变量模板
```

## 本地联调

```bash
# 1. 建一份本地 .env（或者直接在命令行设两个环境变量）
cp env.example .env
#    编辑 .env，填好 OPENCODE_API_KEY、PROXY_API_KEY

# 2. 启动（会先下载真实 opencode 二进制并打一次包）
node scripts/run-local.mjs
#    默认监听 http://127.0.0.1:8787/v1
```

在另一个终端试试：

```bash
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"

curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"用一句话打招呼"}]}'
```

## 一键打包 function.zip

**本地打包：**

```bash
sh scripts/build.sh
# 产物：dist/function.zip（包含真实 opencode 二进制 + 代理代码，约 58MB）
```

脚本默认从 `anomalyco/opencode` 的最新 Release 下载官方 Linux 二进制（`x64` 或
`arm64`，按本机 CPU 自动判断），所以部署的确实是 opencode 本体。想锁定版本用
`OPENCODE_VERSION=v1.18.25`，老 CPU 用 baseline 或 musl 版可用 `OPENCODE_BIN_URL` 覆盖。

**GitHub Actions 一键打包：**

1. 把你这个仓库推到 GitHub；
2. 打开仓库 `Actions` → `Build function.zip` → `Run workflow`；
3. 跑完在 build 的 `Artifacts` 里下载 `function.zip`。

## 部署到 Scaleway

1. 打开 [console.scaleway.com](https://console.scaleway.com) → Serverless → Functions → Create；
2. Runtime 选 **Node（≥18）**；
3. 上传 `function.zip`；
4. **入口点**填：入口文件 `handler`，导出函数 `handle`（包里的 `package.json` 已指向它们）；
5. **环境变量**填上面两个：`OPENCODE_API_KEY`、`PROXY_API_KEY`；
6. **超时建议拉高**：opencode 是 agent，可能要跑较久。默认 10s 太短，建议设成
   `60s ~ 300s`；内存建议 ≥512MB；
7. 部署完成后，在函数详情里打开 HTTP Trigger 拿到 `*.functions.fnc.fr-par.scw.cloud` 地址。

> 注意：Serverless 有冷启动。第一次请求 opencode 要下载模型列表/初始化，会比后续慢几秒，
> 属正常现象。调料到 Serverless 容器最热后基本是即时响应。

## 怎么无缝使用（把它当原生 OpenAI）

拿到你的函数 HTTPS 地址后，在任意 OpenAI 兼容客户端里设置：

```
base_url      = https://<你的函数>.functions.fnc.<区域>.scw.cloud/v1
api_key       = <你的 PROXY_API_KEY>
model         = 从你的函数 GET /v1/models 返回的任意一个 id（如 gpt-5.6-luna）
```

示例（Python openai 官方库）：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://xxx.functions.fnc.fr-par.scw.cloud/v1",
    api_key="<PROXY_API_KEY>",
)

r = client.chat.completions.create(
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "用一句话介绍 Serverless"}],
)
print(r.choices[0].message.content)
```

也支持 `stream=True`（返回标准 SSE）。想保持同一段 agent 对话，客户端每次把完整
消息历史发过来即可；适配层会按历史自动区分"续聊"和"新对话"。

## 常见问题

- **返回 401**：`Authorization` 里的 Bearer 跟 `PROXY_API_KEY` 不一致，或没配置该变量。
- **返回 502 / "opencode 处理失败"**：opencode 自己报错了。最常见是
  `OPENCODE_API_KEY` 填错或没填。查看函数日志里的 `[opencode] ...` 输出。
- **冷启动慢 / 首包请求超时**：把函数超时拉高（建议 60s+）。
- **模型列表想换**：改 `src/zen-models.js` 里的 `ZEN_MODELS` 再重新打包。

## 说明

这个项目只提供一个 OpenAI 接口的壳和打包部署流程，**不包含、也不需要**任何你自己的
LLM 实现——大模型能力全部来自你提供的 `OPENCODE_API_KEY`（Zen）。