#!/usr/bin/env node

/**
 * Telegram Feedback MCP（无 WebUI）
 *
 * 对外提供一个 MCP 工具：telegram_chat
 * - AI 发送问题到 Telegram
 * - 阻塞等待用户在同一聊天中的回复（仅文字/图片）
 * - 将用户回复作为 MCP content 返回（text + image）
 * - 支持候选回复按钮（Inline Keyboard），用户可一键快捷回复
 *
 * 设计原则：
 * - 仅依赖环境变量配置，不引入 Web UI
 * - 在同一进程内维护 lastUpdateId，避免重复消费 Telegram updates
 * - 优先匹配"发送问题后"的下一条用户消息，尽量降低误匹配
 * - 仅支持私聊：启动时校验 chat.type === "private"
 * - 支持进度心跳：定期向 MCP 客户端发送进度通知，避免超时
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import path from "node:path";

type McpTextContent = { type: "text"; text: string };
type McpImageContent = { type: "image"; data: string; mimeType: string };

/**
 * 候选回复项定义
 */
type QuickReply = {
  /** 按钮显示文本 */
  text: string;
  /** 按钮回调数据（可选，默认使用 text） */
  callback_data?: string;
};

type InteractiveFeedbackArgs = {
  project_directory?: string;
  summary?: string;
  /**
   * 是否紧急。
   *
   * 使用规范（写给 AI 的约束）：
   * - 只有"紧急且必须立刻拿到用户回复才能继续"的问题才设置为 true
   * - 一般的进度汇报/非阻塞问题/可异步等待的问题，请设置为 false
   *
   * 行为：
   * - true：使用长超时（默认 6048000 秒）
   * - false：使用短超时（默认 180 秒），超时后返回默认文本（来自环境变量）
   */
  emergency?: boolean;
  /**
   * Telegram sendMessage 的 parse_mode，可选：
   * - "HTML"
   * - "MarkdownV2"
   * - "Markdown"
   * - "none"/"off"/"false"（禁用富文本）
   *
   * 若不传，使用环境变量 TELEGRAM_PARSE_MODE；若也未设置，则默认 HTML。
   */
  parse_mode?: string;
  /**
   * 候选回复按钮列表（可选）。
   * 用户可以点击按钮快捷回复，也可以正常输入文字/图片回复。
   * 每个按钮包含 text（显示文本）和可选的 callback_data（回调数据）。
   * 如果不提供 callback_data，则使用 text 作为回调数据。
   */
  quick_replies?: QuickReply[];
};

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`缺少必需环境变量：${name}`);
  }
  return v;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TELEGRAM_BOT_TOKEN = mustGetEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = mustGetEnv("TELEGRAM_CHAT_ID");
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const POLL_INTERVAL_MS = getEnvNumber("TELEGRAM_POLL_INTERVAL_MS", 2000);
const GETUPDATES_TIMEOUT_SECONDS = getEnvNumber("TELEGRAM_GETUPDATES_TIMEOUT_SECONDS", 25);
const GETUPDATES_ALLOWED_UPDATES = ["message", "callback_query"];
const DEFAULT_TIMEOUT_SECONDS = getEnvNumber("TELEGRAM_DEFAULT_TIMEOUT_SECONDS", 6048000);
const EMERGENCY_TIMEOUT_SECONDS = getEnvNumber("TELEGRAM_EMERGENCY_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS);
const NON_EMERGENCY_TIMEOUT_SECONDS = getEnvNumber("TELEGRAM_NON_EMERGENCY_TIMEOUT_SECONDS", 180);
const NON_EMERGENCY_TIMEOUT_TEXT =
  process.env.TELEGRAM_NON_EMERGENCY_TIMEOUT_TEXT ||
  "用户暂时未回复（非紧急请求已超时）。你可以继续处理其他任务；如需继续等待，请稍后调用 get_last_feedback_response 或再次发起紧急请求。";
const MAX_IMAGES = getEnvNumber("TELEGRAM_MAX_IMAGES", 8);
const INCLUDE_IMAGES = String(process.env.TELEGRAM_INCLUDE_IMAGES ?? "true").toLowerCase() !== "false";
// 默认启用 ForceReply（强烈建议：解决多 agent 并发时"串回复"的歧义）
const FORCE_REPLY = String(process.env.TELEGRAM_FORCE_REPLY ?? "true").toLowerCase() !== "false";
const CLOCK_SKEW_SECONDS = getEnvNumber("TELEGRAM_CLOCK_SKEW_SECONDS", 120);
const READ_RECEIPT_ENABLED = getEnvBoolean("TELEGRAM_READ_RECEIPT_ENABLED", true);
const READ_RECEIPT_TEXT = String(process.env.TELEGRAM_READ_RECEIPT_TEXT ?? "已收到").trim();
const READ_RECEIPT_SILENT = getEnvBoolean("TELEGRAM_READ_RECEIPT_SILENT", true);
// 心跳间隔（毫秒），用于向 MCP 客户端发送进度通知避免超时
const HEARTBEAT_INTERVAL_MS = getEnvNumber("TELEGRAM_HEARTBEAT_INTERVAL_MS", 5000);
// 默认启用 HTML；如需关闭可设置 TELEGRAM_PARSE_MODE=none/false/off
const rawParseMode = String(process.env.TELEGRAM_PARSE_MODE ?? "").trim();
const PARSE_MODE = (() => {
  if (!rawParseMode) return "HTML";
  const lower = rawParseMode.toLowerCase();
  if (["0", "false", "off", "none", "disable", "disabled"].includes(lower)) return undefined;
  return rawParseMode;
})();

function escapeHtml(text: string): string {
  // Telegram HTML parse_mode 需要转义：&, <, >
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMarkdownV2(text: string): string {
  // Telegram MarkdownV2 需要转义的字符（官方规则）
  // _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_\*\[\]\(\)~`>#+\-=|{}\.!])/g, "\\$1");
}

function normalizeParseMode(raw: string | undefined): string | undefined {
  const v = String(raw ?? "").trim();
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (["0", "false", "off", "none", "disable", "disabled"].includes(lower)) return undefined;
  return v;
}

// 进程内 update 游标，避免重复消费更新
let lastUpdateId: number | undefined;

// 记录最近一次"提问消息"，用于外部强制超时后再次等待/获取回复
let lastPromptContext:
  | { promptMessageId: number; sentAtUnixSeconds: number; parseMode?: string; emergency: boolean }
  | undefined;

// 记录最近一次"回复内容缓存"，避免已消费 updates 后无法再次获取
let lastResponseCache:
  | { promptMessageId: number; responseMessageId: number; content: Array<McpTextContent | McpImageContent> }
  | undefined;

async function ensurePrivateChatOnly(): Promise<void> {
  const res = await axios.get(`${TELEGRAM_API_URL}/getChat`, {
    params: { chat_id: TELEGRAM_CHAT_ID }
  });
  if (!res.data?.ok) {
    const desc = res.data?.description ?? "未知错误";
    throw new Error(`Telegram getChat 失败：${desc}`);
  }

  const chatType = res.data.result?.type as string | undefined;
  if (chatType !== "private") {
    throw new Error(
      `当前仅支持私聊（chat.type="private"）。检测到 chat.type="${chatType ?? "unknown"}"。请将 TELEGRAM_CHAT_ID 指向 Bot 与用户的私聊。`
    );
  }
}

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramMessage = {
  message_id: number;
  date: number; // unix seconds
  chat: { id: number | string; type: string };
  from?: { id: number | string; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  // 当用户"回复"某条消息时，Telegram 会带上 reply_to_message（含被回复消息的 message_id）
  reply_to_message?: { message_id: number };
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
};

/**
 * Telegram Callback Query（用户点击 Inline Keyboard 按钮时触发）
 */
type TelegramCallbackQuery = {
  id: string;
  from: { id: number | string; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  message?: TelegramMessage;
  chat_instance: string;
  data?: string;
};

type TelegramSendMessageOptions = {
  parseMode?: string;
  forceReply?: boolean;
  replyToMessageId?: number;
  allowSendingWithoutReply?: boolean;
  disableNotification?: boolean;
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
};

function extractTelegramErrorDescription(error: unknown): string | undefined {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { description?: string } | undefined;
    return data?.description;
  }
  if (error instanceof Error) return error.message;
  return undefined;
}

function isParseModeError(error: unknown): boolean {
  const desc = extractTelegramErrorDescription(error);
  if (!desc) return false;
  const lower = desc.toLowerCase();
  return lower.includes("parse") && lower.includes("entity");
}

async function telegramSendMessageOnce(text: string, options?: TelegramSendMessageOptions): Promise<number> {
  const payload: Record<string, unknown> = {
    chat_id: TELEGRAM_CHAT_ID,
    text
  };
  if (options?.parseMode) payload.parse_mode = options.parseMode;

  // 构建 reply_markup
  const replyMarkup: Record<string, unknown> = {};
  let hasReplyMarkup = false;

  if (options?.forceReply) {
    replyMarkup.force_reply = true;
    hasReplyMarkup = true;
  }

  if (options?.inlineKeyboard && options.inlineKeyboard.length > 0) {
    replyMarkup.inline_keyboard = options.inlineKeyboard;
    hasReplyMarkup = true;
  }

  if (hasReplyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  if (typeof options?.replyToMessageId === "number") {
    payload.reply_to_message_id = options.replyToMessageId;
  }
  if (typeof options?.allowSendingWithoutReply === "boolean") {
    payload.allow_sending_without_reply = options.allowSendingWithoutReply;
  }
  if (typeof options?.disableNotification === "boolean") {
    payload.disable_notification = options.disableNotification;
  }

  const res = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, payload);
  if (!res.data?.ok) {
    const desc = res.data?.description ?? "未知错误";
    throw new Error(`Telegram sendMessage 失败：${desc}`);
  }
  return res.data.result.message_id as number;
}

async function telegramSendMessage(text: string, options?: TelegramSendMessageOptions): Promise<number> {
  const parseMode = options?.parseMode;
  try {
    return await telegramSendMessageOnce(text, options);
  } catch (err) {
    // parse_mode 可能因 Markdown/HTML 解析失败导致发送失败，这里自动降级为纯文本重试一次
    if (parseMode && isParseModeError(err)) {
      const msg = extractTelegramErrorDescription(err) ?? String(err);
      console.error(`sendMessage 使用 parse_mode="${parseMode}" 失败，自动降级为纯文本重试：${msg}`);
      const retryOptions: TelegramSendMessageOptions = { ...(options ?? {}), parseMode: undefined };
      return await telegramSendMessageOnce(text, retryOptions);
    }
    throw err;
  }
}

/**
 * 响应 Telegram Callback Query（用户点击按钮后必须调用）
 */
async function telegramAnswerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  };
  if (text) {
    payload.text = text;
  }
  try {
    await axios.post(`${TELEGRAM_API_URL}/answerCallbackQuery`, payload);
  } catch (error) {
    const desc = extractTelegramErrorDescription(error) ?? String(error);
    console.error(`answerCallbackQuery 失败：${desc}`);
  }
}

async function telegramGetUpdates(): Promise<TelegramUpdate[]> {
  const params: Record<string, unknown> = {
    limit: 50
  };
  if (typeof lastUpdateId === "number") {
    params.offset = lastUpdateId + 1;
  }
  if (GETUPDATES_TIMEOUT_SECONDS > 0) {
    params.timeout = GETUPDATES_TIMEOUT_SECONDS;
  }
  params.allowed_updates = GETUPDATES_ALLOWED_UPDATES;

  const httpTimeoutMs = Math.max(GETUPDATES_TIMEOUT_SECONDS, 0) * 1000 + 5000;
  const res = await axios.get(`${TELEGRAM_API_URL}/getUpdates`, { params, timeout: httpTimeoutMs });
  if (!res.data?.ok) {
    const desc = res.data?.description ?? "未知错误";
    throw new Error(`Telegram getUpdates 失败：${desc}`);
  }
  const updates = (res.data.result ?? []) as TelegramUpdate[];
  for (const u of updates) {
    if (typeof u.update_id === "number") {
      lastUpdateId = typeof lastUpdateId === "number" ? Math.max(lastUpdateId, u.update_id) : u.update_id;
    }
  }
  return updates;
}

async function telegramGetFilePath(fileId: string): Promise<string> {
  const res = await axios.get(`${TELEGRAM_API_URL}/getFile`, {
    params: { file_id: fileId }
  });
  if (!res.data?.ok) {
    const desc = res.data?.description ?? "未知错误";
    throw new Error(`Telegram getFile 失败：${desc}`);
  }
  const filePath = res.data.result?.file_path as string | undefined;
  if (!filePath) {
    throw new Error("Telegram getFile 未返回 file_path");
  }
  return filePath;
}

async function telegramDownloadAsBase64(filePath: string): Promise<Buffer> {
  const url = `${TELEGRAM_FILE_URL}/${filePath}`;
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

function normalizeChatId(chatId: number | string): string {
  return String(chatId);
}

function isSameChat(msg: TelegramMessage): boolean {
  return normalizeChatId(msg.chat.id) === normalizeChatId(TELEGRAM_CHAT_ID);
}

function isLikelyUserReply(params: {
  msg: TelegramMessage;
  promptMessageId: number;
  sentAtUnixSeconds: number;
  requireReplyToPrompt: boolean;
}): boolean {
  const { msg, promptMessageId, sentAtUnixSeconds, requireReplyToPrompt } = params;
  // 仅接受同一 chat 的消息
  if (!isSameChat(msg)) return false;

  // 仅支持私聊
  if (msg.chat.type !== "private") return false;

  // 过滤机器人消息（尽量避免把自己发的消息当成回复）
  if (msg.from?.is_bot) return false;

  // 关键修复：优先要求"回复到我们的提问消息"，避免多 agent 并发时互相误收
  // - 若消息携带 reply_to_message，则必须精确匹配 promptMessageId
  // - 若启用了 requireReplyToPrompt（默认），则不接受"非回复"的裸消息
  const replyToId = msg.reply_to_message?.message_id;
  if (typeof replyToId === "number") {
    return replyToId === promptMessageId;
  }
  if (requireReplyToPrompt) return false;

  // 低成本的相关性判断：必须发生在我们发送问题之后（允许一定的时钟偏差）
  if (typeof msg.date === "number" && msg.date + CLOCK_SKEW_SECONDS < sentAtUnixSeconds) return false;

  // message_id 在同一 chat 内单调递增（一般成立），用它进一步过滤
  if (typeof msg.message_id === "number" && msg.message_id <= promptMessageId) return false;

  // 至少要有文字或图片或文件
  const hasText = typeof msg.text === "string" && msg.text.trim().length > 0;
  const hasCaption = typeof msg.caption === "string" && msg.caption.trim().length > 0;
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const hasDoc = !!msg.document?.file_id;
  return hasText || hasCaption || hasPhoto || hasDoc;
}

/**
 * 检查 callback_query 是否是对我们提问消息的回复
 */
function isCallbackQueryForPrompt(params: {
  callbackQuery: TelegramCallbackQuery;
  promptMessageId: number;
}): boolean {
  const { callbackQuery, promptMessageId } = params;
  // callback_query.message 是触发按钮的那条消息
  const msg = callbackQuery.message;
  if (!msg) return false;
  return msg.message_id === promptMessageId;
}

async function messageToMcpContent(msg: TelegramMessage): Promise<Array<McpTextContent | McpImageContent>> {
  const contents: Array<McpTextContent | McpImageContent> = [];

  const textParts: string[] = [];
  if (msg.text) textParts.push(msg.text);
  if (msg.caption) textParts.push(msg.caption);

  const text = textParts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  if (text) {
    contents.push({ type: "text", text });
  }

  if (!INCLUDE_IMAGES) {
    return contents.length > 0 ? contents : [{ type: "text", text: "用户回复为空。" }];
  }

  let imagesAdded = 0;

  // 1) photo：选最大尺寸
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const sorted = [...msg.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0));
    const largest = sorted[sorted.length - 1];
    if (largest?.file_id) {
      const filePath = await telegramGetFilePath(largest.file_id);
      const buf = await telegramDownloadAsBase64(filePath);
      contents.push({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });
      imagesAdded += 1;
    }
  }

  // 2) document：若是图片 mime_type，则作为图片返回
  if (msg.document?.file_id && imagesAdded < MAX_IMAGES) {
    const mime = msg.document.mime_type || "application/octet-stream";
    if (mime.startsWith("image/")) {
      const filePath = await telegramGetFilePath(msg.document.file_id);
      const buf = await telegramDownloadAsBase64(filePath);
      contents.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
      imagesAdded += 1;
    } else {
      // 非图片文件：明确提示不支持（避免一直等待到超时）
      const name = msg.document.file_name || "附件";
      contents.push({
        type: "text",
        text: `${contents.length > 0 ? "\n\n" : ""}[收到文件但当前不支持处理] ${name}（${mime}）。请改为发送文字或图片。`
      });
    }
  }

  return contents.length > 0 ? contents : [{ type: "text", text: "用户回复为空。" }];
}

/**
 * 将 callback_query 的 data 转换为 MCP content
 */
function callbackQueryToMcpContent(data: string): Array<McpTextContent | McpImageContent> {
  return [{ type: "text", text: data }];
}

async function maybeSendReadReceipt(msg: TelegramMessage): Promise<void> {
  if (!READ_RECEIPT_ENABLED) return;
  const text = READ_RECEIPT_TEXT.trim();
  if (!text) return;
  try {
    await telegramSendMessage(text, {
      replyToMessageId: msg.message_id,
      allowSendingWithoutReply: true,
      disableNotification: READ_RECEIPT_SILENT
    });
  } catch (error) {
    const desc = extractTelegramErrorDescription(error) ?? String(error);
    console.error(`发送已读回执失败：${desc}`);
  }
}

function getTimeoutSeconds(emergency: boolean): number {
  return emergency ? EMERGENCY_TIMEOUT_SECONDS : NON_EMERGENCY_TIMEOUT_SECONDS;
}

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("等待用户回复超时");
}

/**
 * 回复结果：可能是文字消息或 callback_query
 */
type ReplyResult = {
  type: "message";
  message: TelegramMessage;
} | {
  type: "callback_query";
  callbackQuery: TelegramCallbackQuery;
  data: string;
};

/**
 * 等待用户回复（支持文字消息和按钮点击）
 */
async function waitForReplyAfter(params: {
  afterMessageId: number;
  afterUnixSeconds: number;
  timeoutSeconds: number;
  requireReplyToPrompt: boolean;
  onHeartbeat?: () => void;
}): Promise<ReplyResult> {
  const { afterMessageId, afterUnixSeconds, timeoutSeconds, requireReplyToPrompt, onHeartbeat } = params;

  const start = Date.now();
  const deadlineMs = start + Math.max(1, timeoutSeconds) * 1000;

  // 简单的退避重试：参考 fix-MCP-Feedback-Enhanced 的"断网重连/指数退避+抖动"思想
  let consecutiveErrors = 0;
  let lastHeartbeatTime = Date.now();

  while (Date.now() < deadlineMs) {
    // 发送心跳
    if (onHeartbeat && Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
      onHeartbeat();
      lastHeartbeatTime = Date.now();
    }

    try {
      const updates = await telegramGetUpdates();
      consecutiveErrors = 0;

      // 从新到旧找，优先最新回复
      for (let i = updates.length - 1; i >= 0; i -= 1) {
        const update = updates[i];

        // 检查 callback_query（按钮点击）
        if (update?.callback_query) {
          const cq = update.callback_query;
          if (isCallbackQueryForPrompt({ callbackQuery: cq, promptMessageId: afterMessageId })) {
            // 响应 callback_query（Telegram 要求必须调用）
            await telegramAnswerCallbackQuery(cq.id, "已收到");
            return {
              type: "callback_query",
              callbackQuery: cq,
              data: cq.data ?? ""
            };
          }
        }

        // 检查普通消息
        const msg = update?.message;
        if (!msg) continue;
        if (
          isLikelyUserReply({
            msg,
            promptMessageId: afterMessageId,
            sentAtUnixSeconds: afterUnixSeconds,
            requireReplyToPrompt
          })
        ) {
          return { type: "message", message: msg };
        }
      }
    } catch (e) {
      consecutiveErrors += 1;
      const baseDelay = POLL_INTERVAL_MS;
      const expDelay = baseDelay * Math.pow(2, Math.min(consecutiveErrors, 4)); // 上限 16x
      const jitter = Math.random() * 500; // 0-0.5s
      const delayMs = Math.min(expDelay + jitter, 30000);
      console.error(`getUpdates 失败，${Math.round(delayMs)}ms 后重试（第 ${consecutiveErrors} 次）：`, e);
      await sleep(delayMs);
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`等待用户回复超时（${timeoutSeconds} 秒）`);
}

function resolveProjectDirectory(input?: string): string {
  const raw = String(input ?? ".").trim();
  if (!raw) return path.resolve(".");
  // 统一输出为绝对路径，避免出现 "." 影响可读性
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
}

function buildPrompt(params: {
  projectDirectory: string;
  summary: string;
  timeoutSeconds: number;
  parseMode?: string;
}): string {
  const { projectDirectory, summary, timeoutSeconds, parseMode } = params;

  // 关键目标：让 AI 能"自己写各种 Telegram 格式"
  // - summary 默认原样发送（不做自动转义、不包模板），由 AI 自己决定用 HTML/MarkdownV2/Markdown 的语法
  // - 可选的上下文前缀只负责展示目录/超时，并按 parse_mode 做必要转义，避免破坏 summary 的格式
  // 按用户要求：默认 include_context=true，且不暴露给 AI 配置
  const includeContext = true;
  if (!includeContext) return summary;

  const prefixLines: string[] = [];

  if (parseMode === "HTML") {
    prefixLines.push(`<b>项目目录：</b> <code>${escapeHtml(projectDirectory)}</code>`);
    prefixLines.push(`<b>超时（秒）：</b> <code>${escapeHtml(String(timeoutSeconds))}</code>`);
    prefixLines.push(""); // 空行分隔
    return `${prefixLines.join("\n")}\n${summary}`;
  }

  if (parseMode === "MarkdownV2") {
    // 只对"上下文值"做 MarkdownV2 转义，避免目录中的特殊字符破坏格式
    prefixLines.push(`*项目目录：* ${escapeMarkdownV2(projectDirectory)}`);
    prefixLines.push(`*超时（秒）：* ${escapeMarkdownV2(String(timeoutSeconds))}`);
    prefixLines.push(""); // 空行分隔
    return `${prefixLines.join("\n")}\n${summary}`;
  }

  if (parseMode === "Markdown") {
    // Markdown 语法较宽松，这里保守不做花哨格式，避免误伤 summary
    prefixLines.push(`项目目录：${projectDirectory}`);
    prefixLines.push(`超时（秒）：${timeoutSeconds}`);
    prefixLines.push("");
    return `${prefixLines.join("\n")}\n${summary}`;
  }

  // 纯文本
  prefixLines.push(`项目目录：${projectDirectory}`);
  prefixLines.push(`超时（秒）：${timeoutSeconds}`);
  prefixLines.push("");
  return `${prefixLines.join("\n")}\n${summary}`;
}

/**
 * 将 quick_replies 转换为 Telegram Inline Keyboard 格式
 * 每行最多 3 个按钮，超过则自动换行
 */
function buildInlineKeyboard(quickReplies: QuickReply[]): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  let currentRow: Array<{ text: string; callback_data: string }> = [];

  for (const reply of quickReplies) {
    const button = {
      text: reply.text,
      // callback_data 最大 64 字节，这里做截断保护
      callback_data: (reply.callback_data ?? reply.text).slice(0, 64)
    };
    currentRow.push(button);

    // 每行最多 3 个按钮
    if (currentRow.length >= 3) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  }

  // 处理剩余按钮
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }

  return keyboard;
}

const server = new Server(
  { name: "telegram-feedback-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "telegram_chat",
        description:
          "通过 Telegram 向用户发起交互式提问并等待回复（仅私聊；支持图片）。\n\n用法约束：只有「紧急且必须拿到用户回复才能继续」的问题才把 emergency=true；一般进度汇报/非阻塞问题请 emergency=false（将使用短超时，超时后返回默认文本）。\n\nsummary 会按 Telegram 的 parse_mode 原样发送，让 AI 可自由使用 HTML/MarkdownV2/Markdown 格式。\n\n支持 quick_replies 参数提供候选回复按钮，用户可点击快捷回复。",
        inputSchema: {
          type: "object",
          properties: {
            project_directory: {
              type: "string",
              description: "专案目录路径（可用于可选上下文前缀展示）",
              default: "."
            },
            summary: {
              type: "string",
              description:
                "AI 工作摘要/问题描述（将发送到 Telegram）。默认原样发送：如果 parse_mode=HTML，需要你自己正确书写/转义 HTML；如果 parse_mode=MarkdownV2，需要按 MarkdownV2 规则转义特殊字符。",
              default: "请检查我刚刚完成的改动，并回复你的意见/下一步指令。"
            },
            emergency: {
              type: "boolean",
              description:
                "是否紧急。true=长超时（默认 6048000 秒），false=短超时（默认 600 秒）且超时后返回默认文本。只有紧急且必须回复，没有回复就不能进行下一步的问题才设为 true。",
              default: false
            },
            parse_mode: {
              type: "string",
              description:
                "Telegram sendMessage 的 parse_mode：HTML / MarkdownV2 / Markdown。传 none/off/false 可禁用富文本。未传则使用环境变量 TELEGRAM_PARSE_MODE（默认 HTML）。"
            },
            quick_replies: {
              type: "array",
              description:
                "候选回复按钮列表（可选）。用户可点击按钮快捷回复，也可正常输入文字/图片。每个按钮包含 text（显示文本）和可选的 callback_data（回调数据，默认使用 text）。",
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "按钮显示文本"
                  },
                  callback_data: {
                    type: "string",
                    description: "按钮回调数据（可选，默认使用 text）"
                  }
                },
                required: ["text"]
              }
            }
          }
        }
      },
      {
        name: "get_last_feedback_response",
        description:
          "获取/等待最近一次 telegram_chat 的用户回复（仅私聊；支持图片）。主要用于处理外部强制超时：如果上次等待被中断，可以调用此工具继续等待或直接取回已收到的回复。",
        inputSchema: {
          type: "object",
          properties: {
            message_id: {
              type: "number",
              description:
                "可选：指定要等待的「提问消息 ID」。不传则默认使用最近一次 telegram_chat 发送的提问消息。"
            },
            emergency: {
              type: "boolean",
              description:
                "是否紧急。true=长超时（默认 6048000 秒），false=短超时（默认 180 秒）且超时后返回默认文本。",
              default: false
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;

  // 创建心跳发送函数
  let heartbeatProgress = 0;
  const sendHeartbeat = () => {
    heartbeatProgress += 1;
    // 通过 extra.sendNotification 发送进度通知
    // 这会让支持 resetTimeoutOnProgress 的客户端重置超时计时器
    if (extra?.sendNotification) {
      extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: extra.requestId,
          progress: heartbeatProgress,
          message: "等待用户回复中..."
        }
      }).catch(() => {
        // 忽略发送失败（客户端可能不支持）
      });
    }
  };

  if (toolName === "telegram_chat") {
    const args = (request.params.arguments ?? {}) as InteractiveFeedbackArgs;
    const projectDirectory = resolveProjectDirectory(args.project_directory);
    const summary = String(args.summary ?? "请检查我刚刚完成的改动，并回复你的意见/下一步指令。");
    const emergency = Boolean(args.emergency ?? false);
    const quickReplies = Array.isArray(args.quick_replies) ? args.quick_replies : [];

    const timeoutSeconds = getTimeoutSeconds(emergency);
    const effectiveParseMode = normalizeParseMode(args.parse_mode) ?? PARSE_MODE;

    const prompt = buildPrompt({
      projectDirectory,
      summary,
      timeoutSeconds,
      parseMode: effectiveParseMode
    });

    const sentAtUnixSeconds = Math.floor(Date.now() / 1000);

    try {
      // 构建 inline keyboard（如果有 quick_replies）
      const inlineKeyboard = quickReplies.length > 0 ? buildInlineKeyboard(quickReplies) : undefined;

      const sentMessageId = await telegramSendMessage(prompt, {
        parseMode: effectiveParseMode,
        forceReply: FORCE_REPLY && !inlineKeyboard, // 如果有按钮则不需要 force_reply
        inlineKeyboard
      });

      // 记录"最近一次提问"，用于外部强制超时后恢复
      lastPromptContext = {
        promptMessageId: sentMessageId,
        sentAtUnixSeconds,
        parseMode: effectiveParseMode,
        emergency
      };

      const replyResult = await waitForReplyAfter({
        afterMessageId: sentMessageId,
        afterUnixSeconds: sentAtUnixSeconds,
        timeoutSeconds,
        requireReplyToPrompt: FORCE_REPLY && !inlineKeyboard,
        onHeartbeat: sendHeartbeat
      });

      let content: Array<McpTextContent | McpImageContent>;

      if (replyResult.type === "callback_query") {
        // 用户点击了按钮
        content = callbackQueryToMcpContent(replyResult.data);
        // 按钮点击不需要发送已读回执（已经在 answerCallbackQuery 中确认了）
      } else {
        // 用户发送了消息
        await maybeSendReadReceipt(replyResult.message);
        content = await messageToMcpContent(replyResult.message);
      }

      lastResponseCache = {
        promptMessageId: sentMessageId,
        responseMessageId: replyResult.type === "message" ? replyResult.message.message_id : 0,
        content
      };

      return { content };
    } catch (error) {
      if (!emergency && isTimeoutError(error)) {
        return { content: [{ type: "text", text: NON_EMERGENCY_TIMEOUT_TEXT }] };
      }

      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Telegram 交互失败：${msg}` }],
        isError: true
      };
    }
  }

  if (toolName === "get_last_feedback_response") {
    const rawArgs = (request.params.arguments ?? {}) as { message_id?: number; emergency?: boolean };
    const emergency = Boolean(rawArgs.emergency ?? false);
    const timeoutSeconds = getTimeoutSeconds(emergency);

    const targetPromptId =
      (Number.isFinite(rawArgs.message_id) ? Number(rawArgs.message_id) : undefined) ??
      lastPromptContext?.promptMessageId;

    if (!targetPromptId) {
      return {
        content: [{ type: "text", text: "没有可用的历史提问消息。请先调用 telegram_chat 发送提问。" }],
        isError: true
      };
    }

    // 若缓存命中，直接返回
    if (lastResponseCache && lastResponseCache.promptMessageId === targetPromptId) {
      return { content: lastResponseCache.content };
    }

    const afterUnixSeconds =
      lastPromptContext && lastPromptContext.promptMessageId === targetPromptId
        ? lastPromptContext.sentAtUnixSeconds
        : 0;

    try {
      const replyResult = await waitForReplyAfter({
        afterMessageId: targetPromptId,
        afterUnixSeconds,
        timeoutSeconds,
        requireReplyToPrompt: FORCE_REPLY,
        onHeartbeat: sendHeartbeat
      });

      let content: Array<McpTextContent | McpImageContent>;

      if (replyResult.type === "callback_query") {
        content = callbackQueryToMcpContent(replyResult.data);
      } else {
        await maybeSendReadReceipt(replyResult.message);
        content = await messageToMcpContent(replyResult.message);
      }

      lastResponseCache = {
        promptMessageId: targetPromptId,
        responseMessageId: replyResult.type === "message" ? replyResult.message.message_id : 0,
        content
      };
      return { content };
    } catch (error) {
      if (!emergency && isTimeoutError(error)) {
        return { content: [{ type: "text", text: NON_EMERGENCY_TIMEOUT_TEXT }] };
      }
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `获取历史回复失败：${msg}` }],
        isError: true
      };
    }
  }

  throw new Error("未知工具");
});

async function main(): Promise<void> {
  // 启动时强制校验：仅支持私聊
  await ensurePrivateChatOnly();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("telegram-feedback-mcp 已通过 stdio 启动");
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
