import type { AiConnection, AppConfig } from "./types";

type ConfigLike = Partial<AppConfig> | null | undefined;

export interface AiTarget {
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function connections(config: ConfigLike): AiConnection[] {
  return Array.isArray(config?.ai_connections) ? config!.ai_connections : [];
}

/** 按 ID 找连接；找不到就回退到第一个连接，避免设置里删掉连接后界面空白。 */
export function connectionById(config: ConfigLike, id?: string): AiConnection | undefined {
  const list = connections(config);
  if (id) {
    const found = list.find((item) => item.id === id);
    if (found) { return found; }
  }
  return list[0];
}

function targetOf(connection: AiConnection | undefined, fallback?: AiTarget): AiTarget {
  return {
    connectionId: connection?.id || fallback?.connectionId || "",
    connectionName: connection?.name || fallback?.connectionName || "未配置连接",
    baseUrl: String(connection?.baseUrl || fallback?.baseUrl || ""),
    apiKey: String(connection?.apiKey || fallback?.apiKey || ""),
    model: String(connection?.model || fallback?.model || "")
  };
}

export function chatTarget(config: ConfigLike): AiTarget {
  return targetOf(connectionById(config, config?.chat_connection));
}

/** Overleaf 默认跟随文献助手，也可以单独指定连接。 */
export function overleafTarget(config: ConfigLike): AiTarget {
  if (!config?.overleaf_connection) { return chatTarget(config); }
  return targetOf(connectionById(config, config.overleaf_connection), chatTarget(config));
}

export function translationConnection(config: ConfigLike): AiConnection | undefined {
  return connectionById(config, config?.translate_connection);
}

function isDeepSeek(connection: AiConnection | undefined): boolean {
  if (!connection) { return false; }
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(connection.baseUrl).hostname);
  } catch {
    return /deepseek/i.test(connection.baseUrl);
  }
}

/** DeepSeek 搜索复用连接里的 Key：优先助手连接，其次是其他已配置 Key 的 DeepSeek 连接。 */
export function searchConnection(config: ConfigLike): AiConnection | undefined {
  const chat = connectionById(config, config?.chat_connection);
  if (isDeepSeek(chat) && chat?.apiKey) { return chat; }
  return connections(config).find((item) => isDeepSeek(item) && !!item.apiKey)
    || (isDeepSeek(chat) ? chat : connections(config).find(isDeepSeek))
    || chat;
}
