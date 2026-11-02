import { get as getConfig } from "../config";
import * as logger from "../logger";
import { chatTarget, type AiTarget } from "../../shared/ai";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  // 纯文本用 string；带图片时是 OpenAI 兼容的内容块数组（图片只能出现在 user 消息里）
  content: string | null | ChatContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StepResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// 半个 UTF-16 代理对：字符串被按长度截断（工具输出、PDF 文本、搜索片段）时可能把一个
// emoji / 生僻字切成两半。JSON.stringify 会把它写成 \ud83d 这类孤立转义，OpenAI 兼容
// 服务端解析请求体时直接 400（lone leading surrogate），表现为「模型请求失败」。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE.source, "g");

export function stripLoneSurrogates(text: string): string {
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATE_ALL, "") : text;
}

// 按字符数截断，但不切开代理对（剩下的半个由 stripLoneSurrogates 兜底）
export function clipText(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) { return s; }
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) { end -= 1; }
  return s.slice(0, end);
}

// 发请求前清洗整条消息：内容（文本块）、工具调用参数都可能带上孤立代理项
function sanitizeMessage(m: ChatMessage): ChatMessage {
  let next = m;
  if (typeof m.content === "string") {
    const content = stripLoneSurrogates(m.content);
    if (content !== m.content) { next = { ...next, content }; }
  } else if (Array.isArray(m.content)) {
    let changed = false;
    const parts = m.content.map((p) => {
      if (p.type !== "text") { return p; }
      const text = stripLoneSurrogates(p.text);
      if (text === p.text) { return p; }
      changed = true;
      return { ...p, text };
    });
    if (changed) { next = { ...next, content: parts }; }
  }
  if (m.tool_calls) {
    let changed = false;
    const calls = m.tool_calls.map((c) => {
      const args = stripLoneSurrogates(c.function.arguments);
      if (args === c.function.arguments) { return c; }
      changed = true;
      return { ...c, function: { ...c.function, arguments: args } };
    });
    if (changed) { next = { ...next, tool_calls: calls }; }
  }
  return next;
}

export function modelConfigured(): boolean {
  const target = chatTarget(getConfig());
  return !!(target.baseUrl && target.apiKey && target.model);
}

function endpoint(target: AiTarget): string {
  return String(target.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
}

export async function runChat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal: AbortSignal;
  target?: AiTarget;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
}): Promise<StepResult> {
  const target = opts.target || chatTarget(getConfig());
  if (!target.baseUrl || !target.apiKey || !target.model) {
    throw new Error("未配置模型：请在「设置 → AI 服务」里填写连接地址、API Key 和模型");
  }
  const hasImages = opts.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
  // DeepSeek 的 deepseek-chat / reasoner 不支持图片：它们不会报错，而是当作没传（模型会说"没有图片"），
  // 所以这里直接拦下来，免得用户以为是自己截图的问题。
  if (hasImages) {
    let host = "";
    try { host = new URL(target.baseUrl).hostname.toLowerCase(); } catch { /* 非标准地址就交给服务端判断 */ }
    if (/(^|\.)deepseek\.com$/.test(host) && /^deepseek-(chat|reasoner|coder)/.test(String(target.model).toLowerCase())) {
      throw new Error(`当前对话模型 ${target.model} 不支持图片输入：请在「设置 → AI 服务」把模型改为 deepseek-flash 后重试。`);
    }
  }
  const body: Record<string, unknown> = {
    model: target.model,
    messages: opts.messages.map(sanitizeMessage),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }

  const res = await fetch(endpoint(target), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + String(target.apiKey) },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    // 请求体被服务端判成非法 JSON：多半是文本里的孤立代理项，跟模型是否支持图片无关
    const brokenJson = /lone (?:leading|trailing) surrogate|failed to parse the request body|invalid unicode/i.test(text);
    const hint = brokenJson
      ? "（请求体里有非法 Unicode 字符，通常是截断文本时切开了 emoji / 生僻字）"
      : hasImages && res.status === 400
        ? "（图片输入可能不被当前对话模型支持：请确认模型具备视觉能力，例如 DeepSeek 的 deepseek-flash）"
        : "";
    throw new Error(`模型请求失败 HTTP ${res.status}: ${text.slice(0, 500)}${hint}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let finishReason = "";
  let sawDone = false;
  let sawData = false;
  let usage: StepResult["usage"];
  const calls: Record<number, { id: string; name: string; arguments: string }> = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) { break; }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) { continue; }
      const data = line.slice(5).trim();
      if (!data) { continue; }
      // 流正常收尾的标志：有的服务商只发 [DONE]，有的只发 finish_reason
      if (data === "[DONE]") { sawDone = true; continue; }
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      sawData = true;
      if (json.usage) { usage = json.usage; }
      const choice = json.choices && json.choices[0];
      if (!choice) { continue; }
      if (choice.finish_reason) { finishReason = choice.finish_reason; }
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
      const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking;
      if (typeof reasoning === "string" && reasoning) { opts.onReasoning?.(reasoning); }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] || { id: "", name: "", arguments: "" };
          if (tc.id) { calls[i].id = tc.id; }
          if (tc.function?.name) { calls[i].name = tc.function.name; }
          if (tc.function?.arguments) { calls[i].arguments += tc.function.arguments; }
        }
      }
    }
  }

  const toolCalls: ToolCall[] = Object.keys(calls)
    .sort((a, b) => Number(a) - Number(b))
    .map((k, i) => { const c = calls[Number(k)]; return { id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || "{}" }; })
    .filter((c) => c.name);

  logger.info("ai", `chat 流结束：finish=${finishReason || "-"} done=${sawDone} chars=${content.length} tools=${toolCalls.length}`);
  // 连接建立后什么都没收到：不是"空回答"，基本就是请求被中断/被网关吞了
  if (!sawData) {
    throw new Error("模型没有返回任何内容（连接建立后立即断开）：请检查网络或稍后重试。");
  }
  // 既没有 [DONE] 也没有 finish_reason 就结束了：流被中途掐断，界面上会表现为"答到一半就没了"
  if (!sawDone && !finishReason && !toolCalls.length) {
    throw new Error("回答中断：连接在生成过程中断开（已保留生成到一半的内容）。重试或回复「继续」即可接着写。");
  }

  return { content, toolCalls, finishReason, usage };
}
