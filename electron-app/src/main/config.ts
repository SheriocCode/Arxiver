import fs from "node:fs";
import path from "node:path";
import { configPath } from "./paths";

export interface AppConfig {
  // 翻译引擎：local = 内置 llama.cpp + HY-MT 模型；remote = OpenAI 兼容 API
  translate_mode: "local" | "remote";
  service: string;
  translate_base_url: string;
  translate_api_key: string;
  translate_model: string;
  local_model: string;
  local_gpu_layers: number;
  local_extra_args: string;
  // AI 助手（会话）：始终走独立的接口，避免与翻译互抢额度
  chat_base_url: string;
  chat_api_key: string;
  chat_model: string;
  // 联网搜索（AI 助手，默认关闭）：可选服务商，两家 Key 各自保存，方便切换对比
  search_enabled: boolean;
  search_provider: "tavily" | "bocha";
  search_key_tavily: string;
  search_key_bocha: string;
  search_scope: "academic" | "web";
  source_lang: string;
  target_lang: string;
  output_variant: string;
  threads: number;
  use_babeldoc: boolean;
  skip_subset_fonts: boolean;
  extra_args: string;
  prompt: string;
  timeout: number;
}

const DEFAULT_CONFIG: AppConfig = {
  translate_mode: "local",
  service: "openai",
  translate_base_url: "https://api.deepseek.com",
  translate_api_key: "",
  translate_model: "deepseek-chat",
  local_model: "",
  local_gpu_layers: 99,
  local_extra_args: "",
  chat_base_url: "https://api.deepseek.com",
  chat_api_key: "",
  chat_model: "deepseek-chat",
  search_enabled: false,
  search_provider: "tavily",
  search_key_tavily: "",
  search_key_bocha: "",
  search_scope: "academic",
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

function load(): AppConfig {
  if (current) {
    return current;
  }
  current = { ...DEFAULT_CONFIG };
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
  return current;
}

function save(): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
  fs.renameSync(tmp, configPath());
}

export function get(): AppConfig {
  return { ...load() };
}

// 联网搜索当前服务商的 Key
export function searchKey(c: AppConfig = get()): string {
  return String((c.search_provider === "bocha" ? c.search_key_bocha : c.search_key_tavily) || "");
}

// 读正文（fetch_url）用的 Key：只有 Tavily 提供 extract 接口，所以固定用它的 Key（没有就本地抓）
export function extractKey(c: AppConfig = get()): string {
  return String(c.search_key_tavily || "");
}

export function searchProvider(c: AppConfig = get()): "tavily" | "bocha" {
  return c.search_provider === "bocha" ? "bocha" : "tavily";
}

export function update(patch: Partial<AppConfig>): AppConfig {
  const next = load();
  for (const key of WRITABLE) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      (next as unknown as Record<string, unknown>)[key] = (patch as unknown as Record<string, unknown>)[key];
    }
  }
  save();
  return get();
}
