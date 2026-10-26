import { useCallback, useEffect, useState } from "react";

export type Accent = "green" | "blue" | "orange";
export type PageTheme = "original" | "green" | "beige" | "dark";

// PDF 页面背景是全局设置：所有打开的文档共用同一个配色
export const PAGE_THEMES: [PageTheme, string, string][] = [
  ["original", "原始", "#ffffff"],
  ["green", "护眼", "#cce8cf"],
  ["beige", "米黄", "#f3ead3"],
  ["dark", "暗色", "#1a1a1a"]
];

export interface AppSettings {
  defaultTab: "info" | "notes" | "tags" | "ai";
  showCounts: boolean;
  showUnread: boolean;
  fetchMeta: boolean;
  accent: Accent;
  reduceMotion: boolean;
  citeDoi: boolean;
  aiEnabled: boolean;
  showBlocksTranslating: boolean;
  showBlocksTranslation: boolean;
  splashEnabled: boolean;
  backgroundEnabled: boolean;
  backgroundFile: string;
  backgroundOpacity: number;
  pageTheme: PageTheme;
  /** 详情面板宽度（拖拽侧边栏左缘调整） */
  detailWidth: number;
  /** 每个模型选中的下载源 URL（持久化在 data/ui-settings.json） */
  modelSources: Record<string, string>;
}

const DEFAULTS: AppSettings = {
  defaultTab: "info",
  showCounts: true,
  showUnread: true,
  fetchMeta: true,
  accent: "green",
  reduceMotion: false,
  citeDoi: true,
  aiEnabled: true,
  showBlocksTranslating: true,
  showBlocksTranslation: false,
  splashEnabled: true,
  backgroundEnabled: false,
  backgroundFile: "",
  backgroundOpacity: 0.9,
  pageTheme: "original",
  detailWidth: 372,
  modelSources: {}
};

export const ACCENTS: Record<Accent, { a: string; strong: string; strongHover: string; soft: string; soft2: string }> = {
  green: { a: "#10a37f", strong: "#0b7a5d", strongHover: "#096349", soft: "rgba(16,163,127,.15)", soft2: "rgba(16,163,127,.26)" },
  blue: { a: "#3771c8", strong: "#2a5aa0", strongHover: "#234c86", soft: "rgba(55,113,200,.16)", soft2: "rgba(55,113,200,.30)" },
  orange: { a: "#c8713a", strong: "#a85a28", strongHover: "#8f4c20", soft: "rgba(200,113,58,.16)", soft2: "rgba(200,113,58,.30)" }
};

// 设置存在主进程（data/ui-settings.json）而不是 localStorage：
// localStorage 按渲染端 origin 隔离（dev 端口一变就"丢设置"），且是异步落盘（强杀会丢）。
function load(): AppSettings {
  let settings: AppSettings;
  try {
    const raw = window.api.uiSettingsGetSync() as Partial<AppSettings> | null;
    settings = { ...DEFAULTS, ...(raw || {}) };
  } catch {
    settings = { ...DEFAULTS };
  }
  // 旧版本把模型下载源存在渲染端 localStorage；搬到 ui-settings（data 目录）。
  try {
    const legacy = JSON.parse(localStorage.getItem("arxiver.modelSources") || "null") as Record<string, string> | null;
    if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
      if (!Object.keys(settings.modelSources || {}).length) { settings = { ...settings, modelSources: legacy }; }
      localStorage.removeItem("arxiver.modelSources");
    }
  } catch {
    /* ignore */
  }
  return settings;
}

function apply(s: AppSettings): void {
  const ac = ACCENTS[s.accent] || ACCENTS.green;
  const root = document.documentElement;
  root.style.setProperty("--accent", ac.a);
  root.style.setProperty("--accent-strong", ac.strong);
  root.style.setProperty("--accent-strong-hover", ac.strongHover);
  root.style.setProperty("--accent-soft", ac.soft);
  root.style.setProperty("--accent-soft-2", ac.soft2);
  root.style.setProperty("--bg-opacity", String(s.backgroundOpacity));
  root.classList.toggle("reduce-motion", !!s.reduceMotion);
  // 启用自选背景时，让界面面板半透明，露出后面的图片/视频
  root.classList.toggle("has-bg", !!(s.backgroundEnabled && s.backgroundFile));
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => load());

  useEffect(() => { apply(settings); }, [settings]);
  useEffect(() => { void window.api.uiSettingsSet(settings); }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  return { settings, update };
}
