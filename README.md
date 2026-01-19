# Telegram Feedback MCP（无 WebUI）

这是一个 **Model Context Protocol (MCP)** 服务：让 AI 通过 **Telegram** 随时向用户发问交流，并 **阻塞等待用户回复**（支持发送图片）。

## 功能

- 提问：将 `summary` 发送到 Telegram（可带项目目录上下文）
- **发送图片**：支持 `images` 参数，AI 可以发送本地图片给用户
- 等回复：轮询 `getUpdates`，匹配"发送问题后"的用户消息
- **候选回复按钮**：支持 `quick_replies` 参数，用户可一键快捷回复
- 返结果：返回 MCP `content`（文字 + 图片 base64）
- 回执：收到用户回复后发送可配置回执（可静默/可关闭）
- **心跳机制**：定期发送进度通知，避免 MCP 客户端超时

## 环境变量（全部配置都走环境变量）

- **必需**
  - `TELEGRAM_BOT_TOKEN`：Bot Token（来自 `@BotFather`）
  - `TELEGRAM_CHAT_ID`：目标聊天 ID（**仅支持私聊**）

- **可选**
  - `TELEGRAM_POLL_INTERVAL_MS`：轮询间隔毫秒（默认 `2000`）
  - `TELEGRAM_GETUPDATES_TIMEOUT_SECONDS`：getUpdates 长轮询秒数（默认 `25`）
  - `TELEGRAM_DEFAULT_TIMEOUT_SECONDS`：历史兼容的长超时秒数（默认 `6048000`，约 70 天）
  - `TELEGRAM_EMERGENCY_TIMEOUT_SECONDS`：紧急等待超时秒数（默认取 `TELEGRAM_DEFAULT_TIMEOUT_SECONDS`）
  - `TELEGRAM_NON_EMERGENCY_TIMEOUT_SECONDS`：非紧急等待超时秒数（默认 `180`）
  - `TELEGRAM_NON_EMERGENCY_TIMEOUT_TEXT`：非紧急超时后返回的默认文本（建议配置为你的团队默认提示语）
  - `TELEGRAM_INCLUDE_IMAGES`：是否把图片作为 MCP image 返回（默认 `true`）
  - `TELEGRAM_MAX_IMAGES`：最多返回的图片数（默认 `8`）
  - `TELEGRAM_FORCE_REPLY`：是否在提问消息上启用 ForceReply（默认 `true`，强烈建议开启：可避免多 agent 并发时"串回复"的歧义）
  - `TELEGRAM_CLOCK_SKEW_SECONDS`：允许的时钟偏差秒数（默认 `120`，用于容错消息时间戳判断）
  - `TELEGRAM_READ_RECEIPT_ENABLED`：是否发送回执消息（默认 `true`）
  - `TELEGRAM_READ_RECEIPT_TEXT`：回执消息文本（默认 `已收到`）
  - `TELEGRAM_READ_RECEIPT_SILENT`：回执是否静默发送（默认 `true`）
  - `TELEGRAM_PARSE_MODE`：发送消息的 parse_mode（默认 **`HTML`**；可设为 `none/false/off` 关闭；也可设置为 `MarkdownV2` / `Markdown`）
  - `TELEGRAM_HEARTBEAT_INTERVAL_MS`：心跳间隔毫秒（默认 `5000`），用于向 MCP 客户端发送进度通知避免超时

> 提示：Telegram 客户端的"系统已读状态"无法由 Bot 直接控制，本项目通过回执消息显式确认"已收到"。

## AI 想写"各种 Telegram 格式"？（重要）

本项目会将 `telegram_chat.summary` **按 Telegram 的 parse_mode 原样发送**，因此 AI 可以自由使用 Telegram 支持的富文本格式（HTML / MarkdownV2 / Markdown）。

同时也意味着：**你需要自己遵守对应语法的转义规则**，否则 Telegram 可能会报错（本项目仅在 parse_mode 解析失败时降级为纯文本重试一次，但会丢失格式）。

### HTML（parse_mode=HTML）

Telegram 会按 HTML 解析：

- **需要转义的字符**：`&`、`<`、`>`
- **转义写法**：`&amp;`、`&lt;`、`&gt;`

本项目仅对"可选上下文前缀"的目录/超时字段做转义；`summary` 默认不自动转义（让 AI 自由写格式）。

### MarkdownV2（parse_mode=MarkdownV2）

MarkdownV2 对特殊字符要求更严格，常见需要转义的字符包括：

`_ * [ ] ( ) ~ \` > # + - = | { } . !`

建议：如果 AI 要大量输出命令、日志、JSON，优先使用 HTML 的 `<pre><code>...</code></pre>`，并对内容做 `& < >` 转义。

## 仅支持私聊（重要）

本项目 **仅支持私聊**。服务启动时会调用 Telegram `getChat` 校验 `chat.type === "private"`：

- 如果你配置了群聊/频道的 `TELEGRAM_CHAT_ID`，服务会直接启动失败
- 请确保 `TELEGRAM_CHAT_ID` 指向 Bot 与用户的一对一私聊

## MCP 工具

### telegram_chat

参数（与很多 "feedback" MCP 的常见形状对齐）：

- `project_directory`：项目目录（默认 `"."`）
- `summary`：AI 的问题/摘要（默认 `"请检查我刚刚完成的改动，并回复你的意见/下一步指令。"`）
- `emergency`：是否紧急（默认 `false`）
  - `true`：仅用于"紧急且必须拿到用户回复才能继续"的问题（使用长超时）
  - `false`：用于一般进度汇报/非阻塞问题（使用短超时；超时后返回 `TELEGRAM_NON_EMERGENCY_TIMEOUT_TEXT`）
- `parse_mode`：可选覆盖发送格式（`HTML` / `MarkdownV2` / `Markdown` / `none`）
- `quick_replies`：候选回复按钮列表（可选）
  - 每个按钮包含 `text`（显示文本）和可选的 `callback_data`（回调数据，默认使用 text）
  - 用户可以点击按钮快捷回复，也可以正常输入文字/图片回复
- `images`：要发送的图片列表（可选）
  - 每个元素是图片的绝对路径
  - 图片会在发送文字消息后依次发送

说明：
- `include_context` **固定为 true**（不对 AI 暴露配置）：服务端会在 `summary` 前附加"项目目录/超时"的前缀，且按 parse_mode 对前缀字段做必要转义，避免破坏 summary 的格式。
- 为了避免多 agent 并发时"同一条用户回复被多个 agent 同时消费"，服务端默认启用 **ForceReply**，并在接收端优先匹配 `reply_to_message_id`（用户需要"回复"到对应提问消息，Telegram 客户端通常会自动处理）。

#### 候选回复按钮示例

```json
{
  "summary": "请选择下一步操作：",
  "quick_replies": [
    { "text": "✅ 继续" },
    { "text": "❌ 取消" },
    { "text": "🔄 重试", "callback_data": "retry" }
  ]
}
```

用户在 Telegram 中会看到带有三个按钮的消息，点击任意按钮即可快速回复。

#### 发送图片示例

```json
{
  "summary": "这是我生成的设计稿，请查看：",
  "images": [
    "/path/to/design1.png",
    "/path/to/design2.jpg"
  ]
}
```

AI 可以指定本地图片的绝对路径，图片会在文字消息后发送给用户。

### get_last_feedback_response

获取/等待最近一次 `telegram_chat` 的用户回复（用于处理外部强制超时：上次等待被中断时可再次等待）。

- `message_id`（可选）：指定"提问消息 ID"；不传则默认取最近一次提问
- `emergency`（可选，默认 false）：同 `telegram_chat.emergency` 的超时策略

返回：

- `content`: `[{type:"text", text:"..."}, {type:"image", data:"<base64>", mimeType:"image/jpeg"} ...]`

## 心跳机制（避免客户端超时）

MCP 客户端（如 Cursor、OpenCode 等）通常有请求超时限制。本项目通过定期发送 **progress notification** 来告知客户端服务仍在运行：

- 默认每 5 秒发送一次心跳（可通过 `TELEGRAM_HEARTBEAT_INTERVAL_MS` 配置）
- 支持 `resetTimeoutOnProgress` 的客户端会在收到进度通知后重置超时计时器
- 不支持的客户端会忽略这些通知（不影响正常功能）

## 安装与运行（开发态）

```bash
cd telegram-feedback-mcp
npm install
npm run build

export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
node build/index.js
```

## 通过 npm 安装

```bash
npm install -g telegram-feedback-mcp
```

## Cursor / Cline 配置示例

```json
{
  "mcpServers": {
    "telegram-feedback-mcp": {
      "command": "node",
      "args": ["<你的路径>/TelegramFeedbackMCP/telegram-feedback-mcp/build/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "xxxx",
        "TELEGRAM_CHAT_ID": "xxxx",
        "TELEGRAM_POLL_INTERVAL_MS": "2000",
        "TELEGRAM_DEFAULT_TIMEOUT_SECONDS": "6048000",
        "TELEGRAM_INCLUDE_IMAGES": "true",
        "TELEGRAM_MAX_IMAGES": "8"
      },
      "disabled": false,
      "autoApprove": ["telegram_chat"]
    }
  }
}
```

> 安全提示：请不要把 `TELEGRAM_BOT_TOKEN` 直接写进文档/仓库文件。建议放在 MCP 启动器的私密配置或环境变量里。

## GitHub Actions 自动发布

本项目配置了 GitHub Actions 工作流，当推送 `v*` 标签时会自动构建并发布到 npm。

### 配置步骤

1. 在 [npm](https://www.npmjs.com/) 生成 Access Token（选择 Automation 类型）
2. 在 GitHub 仓库 Settings > Secrets and variables > Actions 中添加 `NPM_TOKEN`
3. 创建版本标签并推送：

```bash
git tag v0.2.0
git push origin v0.2.0
```

## License

MIT
