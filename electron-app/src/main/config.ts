import fs from "node:fs";
import path from "node:path";
import type { AiConnection, AppConfig } from "../shared/types";
import { searchConnection } from "../shared/ai";
import { configPath } from "./paths";

export type { AppConfig };

const DEFAULT_CONNECTION: AiConnection = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash"
};

const DEFAULT_CONFIG: AppConfig = {
  // 连接只配置一次，翻译 / 助手 / Overleaf / DeepSeek 搜索都引用它
  ai_connections: [DEFAULT_CONNECTION],
  translate_mode: "local",
  service: "openai",
  translate_connection: "deepseek",
  local_model: "",
  local_gpu_layers: 99,
  local_extra_args: "",
  chat_connection: "deepseek",
  overleaf_connection: "",
  search_enabled: false,
  search_provider: "tavily",
  search_key_tavily: "",
  search_key_bocha: "",
  source_lang: "en",
  target_lang: "zh-CN",
  output_variant: "dual",
  threads: 4,
  use_babeldoc: false,
  skip_subset_fonts: false,
  extra_args: "",
  prompt: "",
  timeout: 3600
};

const WRITABLE = Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[];

let current: AppConfig | null = null;

function normalize(config: AppConfig): void {
  const seen = new Set<string>();
  const list: AiConnection[] = [];
  for (const item of Array.isArray(config.ai_connections) ? config.ai_connections : []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    list.push({
      id,
      name: String(item?.name || id),
      baseUrl: String(item?.baseUrl || ""),
      apiKey: String(item?.apiKey || ""),
      model: String(item?.model || "") || (id === "deepseek" ? "deepseek-flash" : "")
    });
  }
  if (!list.length) { list.push({ ...DEFAULT_CONNECTION }); }
  config.ai_connections = list;

  const ids = new Set(list.map((item) => item.id));
  const fallback = list[0].id;
  const keep = (value: string): string => (value && ids.has(value) ? value : "");
  config.chat_connection = keep(config.chat_connection) || fallback;
  config.translate_connection = keep(config.translate_connection) || fallback;
  // 留空表示跟随文献助手
  config.overleaf_connection = keep(config.overleaf_connection);
}

function load(): AppConfig {
  if (current) {
    return current;
  }
  current = { ...DEFAULT_CONFIG, ai_connections: [{ ...DEFAULT_CONNECTION }] };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<AppConfig>;
    for (const key of WRITABLE) {
      if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
        (current as unknown as Record<string, unknown>)[key] = (raw as Record<string, unknown>)[key];
      }
    }
  } catch {
    // first run or unreadable file
  }
  normalize(current);
  return current;
}

function save(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
  fs.renameSync(tmp, configPath());
}

export function get(): AppConfig {
  const config = load();
  return { ...config, ai_connections: config.ai_connections.map((item) => ({ ...item })) };
}

// 联网搜索当前服务商的 Key（DeepSeek 复用连接里的 Key）
export function searchKey(c: AppConfig = get()): string {
  switch (searchProvider(c)) {
    case "bocha": return String(c.search_key_bocha || "");
    case "deepseek": return String(searchConnection(c)?.apiKey || "");
    default: return String(c.search_key_tavily || "");
  }
}

// 读正文用的 Key：Tavily extract 优先、DeepSeek Fetch 兜底，两家都配了就都带上，都没配就本机抓
export function readKeys(c: AppConfig = get()): { tavily: string; deepseek: string } {
  return {
    tavily: String(c.search_key_tavily || ""),
    deepseek: String(searchConnection(c)?.apiKey || "")
  };
}

export function searchProvider(c: AppConfig = get()): "tavily" | "bocha" | "deepseek" {
  if (c.search_provider === "bocha") { return "bocha"; }
  if (c.search_provider === "deepseek") { return "deepseek"; }
  return "tavily";
}

export function update(patch: Partial<AppConfig>): AppConfig {
  const next = load();
  for (const key of WRITABLE) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      (next as unknown as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  }
  normalize(next);
  save();
  return get();
}
