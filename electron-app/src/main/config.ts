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
