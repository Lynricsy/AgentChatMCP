# 🤖 MCP AgentChat

[![npm version](https://img.shields.io/npm/v/mcp-agentchat.svg)](https://www.npmjs.com/package/mcp-agentchat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**MCP AgentChat** - 一个 Model Context Protocol (MCP) 服务，让 AI Agent 通过 **Telegram** 与用户实时交互：发送消息、图片，等待用户回复。

## ✨ 特性

| 功能 | 描述 |
|------|------|
| 📝 **发送消息** | 支持 HTML/MarkdownV2/Markdown 格式 |
| 🖼️ **发送图片** | 支持发送本地图片文件 |
| ⌨️ **快捷回复按钮** | Inline Keyboard 候选回复 |
| 📸 **接收图片** | 用户回复的图片转 base64 返回 |
| 💓 **心跳机制** | 进度通知避免客户端超时 |
| ⏱️ **超时策略** | 区分紧急/非紧急请求 |

## 📦 安装

```bash
# 全局安装
npm install -g mcp-agentchat

# 或者本地安装
npm install mcp-agentchat
```

## 🔧 配置

### 必需环境变量

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（来自 [@BotFather](https://t.me/BotFather)） |
| `TELEGRAM_CHAT_ID` | 目标聊天 ID（**仅支持私聊**） |

### 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TELEGRAM_POLL_INTERVAL_MS` | `2000` | 轮询间隔（毫秒） |
| `TELEGRAM_GETUPDATES_TIMEOUT_SECONDS` | `25` | getUpdates 长轮询秒数 |
| `TELEGRAM_EMERGENCY_TIMEOUT_SECONDS` | `6048000` | 紧急请求超时（秒） |
| `TELEGRAM_NON_EMERGENCY_TIMEOUT_SECONDS` | `180` | 非紧急请求超时（秒） |
| `TELEGRAM_NON_EMERGENCY_TIMEOUT_TEXT` | `"用户暂时未回复..."` | 非紧急超时返回文本 |
| `TELEGRAM_HEARTBEAT_INTERVAL_MS` | `5000` | 心跳间隔（毫秒） |
| `TELEGRAM_PARSE_MODE` | `HTML` | 默认消息格式 |
| `TELEGRAM_FORCE_REPLY` | `true` | 启用强制回复 |
| `TELEGRAM_INCLUDE_IMAGES` | `true` | 接收图片转 base64 |
| `TELEGRAM_MAX_IMAGES` | `8` | 最多返回图片数 |
| `TELEGRAM_READ_RECEIPT_ENABLED` | `true` | 发送已读回执 |
| `TELEGRAM_READ_RECEIPT_TEXT` | `已收到` | 回执文本 |
| `TELEGRAM_READ_RECEIPT_SILENT` | `true` | 静默发送回执 |

## 🛠️ MCP 工具

### telegram_chat

通过 Telegram 向用户发送消息并等待回复。

#### 参数

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `summary` | string | 否 | 发送给用户的消息内容 |
| `images` | string[] | 否 | 要发送的图片绝对路径列表 |
| `quick_replies` | object[] | 否 | 候选回复按钮列表 |
| `emergency` | boolean | 否 | 是否紧急（影响超时策略） |
| `parse_mode` | string | 否 | 消息格式（HTML/MarkdownV2/Markdown） |
| `project_directory` | string | 否 | 项目目录（显示在消息前缀） |

#### 使用示例

**基础用法：**

```json
{
  "summary": "代码已修改完成，请检查并反馈。"
}
```

**发送图片：**

```json
{
  "summary": "这是生成的设计稿，请查看：",
  "images": [
    "/path/to/design.png",
    "/path/to/mockup.jpg"
  ]
}
```

**带快捷回复按钮：**

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

**完整示例：**

```json
{
  "summary": "我完成了页面设计，请查看截图并选择：",
  "images": ["/tmp/screenshot.png"],
  "quick_replies": [
    { "text": "👍 很好，继续" },
    { "text": "✏️ 需要修改" }
  ],
  "emergency": false,
  "parse_mode": "HTML"
}
```

### get_last_feedback_response

获取/等待最近一次提问的用户回复（用于处理外部超时中断）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `message_id` | number | 指定提问消息 ID（可选） |
| `emergency` | boolean | 是否紧急 |

## 📋 客户端配置示例

### Cursor / Claude Desktop

```json
{
  "mcpServers": {
    "agentchat": {
      "command": "npx",
      "args": ["mcp-agentchat"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "your-bot-token",
        "TELEGRAM_CHAT_ID": "your-chat-id"
      }
    }
  }
}
```

### 本地开发

```json
{
  "mcpServers": {
    "agentchat": {
      "command": "node",
      "args": ["/path/to/mcp-agentchat/build/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "your-bot-token",
        "TELEGRAM_CHAT_ID": "your-chat-id",
        "TELEGRAM_HEARTBEAT_INTERVAL_MS": "5000"
      }
    }
  }
}
```

## 📝 消息格式说明

本项目将 `summary` **原样发送**，AI 可自由使用 Telegram 支持的富文本格式。

### HTML（推荐）

```html
<b>粗体</b> <i>斜体</i> <code>代码</code>
<pre>代码块</pre>
<a href="https://example.com">链接</a>
```

需要转义：`&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;`

### MarkdownV2

```markdown
*粗体* _斜体_ `代码`
```

需要转义的字符：`_ * [ ] ( ) ~ \` > # + - = | { } . !`

## 💓 心跳机制

为避免 MCP 客户端（如 Cursor）在等待用户回复时超时，本项目会定期发送 **progress notification**：

- 默认每 5 秒发送一次
- 支持 `resetTimeoutOnProgress` 的客户端会重置超时计时器
- 可通过 `TELEGRAM_HEARTBEAT_INTERVAL_MS` 调整间隔

## ⚠️ 重要说明

1. **仅支持私聊**：启动时会校验 `chat.type === "private"`
2. **安全提示**：不要将 `TELEGRAM_BOT_TOKEN` 提交到代码仓库
3. **ForceReply**：默认启用，避免多 Agent 并发时消息混淆

## 🔄 GitHub Actions 自动发布

推送 `v*` 标签会自动触发 npm 发布：

```bash
git tag v0.3.0
git push origin v0.3.0
```

需要在 GitHub Secrets 中配置 `NPM_TOKEN`。

## 📄 License

MIT
