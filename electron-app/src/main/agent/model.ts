import { get as getConfig } from "../config";

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

export function modelConfigured(): boolean {
  const c = getConfig();
  return !!(c.chat_base_url && c.chat_api_key && c.chat_model);
}

function endpoint(): string {
  const base = String(getConfig().chat_base_url || "").replace(/\/+$/, "");
  return base + "/chat/completions";
}

export async function runChat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
}): Promise<StepResult> {
  const config = getConfig();
  if (!config.chat_base_url || !config.chat_api_key || !config.chat_model) {
    throw new Error("未配置对话模型：请在设置中填写 AI 助手的基础地址 / 密钥 / 模型");
  }
  const hasImages = opts.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
  // DeepSeek 的 deepseek-chat / reasoner 不支持图片：它们不会报错，而是当作没传（模型会说"没有图片"），
  // 所以这里直接拦下来，免得用户以为是自己截图的问题。
  if (hasImages) {
    let host = "";
    try { host = new URL(config.chat_base_url).hostname.toLowerCase(); } catch { /* 非标准地址就交给服务端判断 */ }
    if (/(^|\.)deepseek\.com$/.test(host) && /^deepseek-(chat|reasoner|coder)/.test(String(config.chat_model).toLowerCase())) {
      throw new Error(`当前对话模型 ${config.chat_model} 不支持图片输入：请在 设置 → AI 助手 → 模型 改为 deepseek-flash 后重试。`);
    }
  }
  const body: Record<string, unknown> = {
    model: config.chat_model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }

  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + String(config.chat_api_key) },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const hint = hasImages && res.status === 400
      ? "（图片输入可能不被当前对话模型支持：请确认模型具备视觉能力，例如 DeepSeek 的 deepseek-flash）"
      : "";
    throw new Error(`模型请求失败 HTTP ${res.status}: ${text.slice(0, 500)}${hint}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let finishReason = "";
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
      if (!data || data === "[DONE]") { continue; }
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
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

  return { content, toolCalls, finishReason, usage };
}
