import { useCallback, useEffect, useState } from "react";

export type Accent = "green" | "blue" | "orange";

export interface AppSettings {
  defaultTab: "info" | "notes" | "tags" | "ai";
  showCounts: boolean;
  showUnread: boolean;
  fetchMeta: boolean;
  autoSave: boolean;
  accent: Accent;
  reduceMotion: boolean;
  pdfZoom: "fit" | "1" | "1.25";
  citeFormat: "apa" | "gb" | "mla";
  citeDoi: boolean;
  exportFormat: "bibtex" | "ris" | "csv";
  aiEnabled: boolean;
  aiModel: string;
  aiSources: boolean;
  autoSummary: boolean;
  autoSync: boolean;
  showBlocksTranslating: boolean;
  showBlocksTranslation: boolean;
}

const DEFAULTS: AppSettings = {
  defaultTab: "info",
  showCounts: true,
  showUnread: true,
  fetchMeta: true,
  autoSave: true,
  accent: "green",
  reduceMotion: false,
  pdfZoom: "fit",
  citeFormat: "apa",
  citeDoi: true,
  exportFormat: "bibtex",
  aiEnabled: true,
  aiModel: "文献助手",
  aiSources: true,
  autoSummary: false,
  autoSync: true,
  showBlocksTranslating: true,
  showBlocksTranslation: true
};

export const ACCENTS: Record<Accent, { a: string; strong: string; strongHover: string; soft: string; soft2: string }> = {
  green: { a: "#10a37f", strong: "#0b7a5d", strongHover: "#096349", soft: "rgba(16,163,127,.15)", soft2: "rgba(16,163,127,.26)" },
  blue: { a: "#3771c8", strong: "#2a5aa0", strongHover: "#234c86", soft: "rgba(55,113,200,.16)", soft2: "rgba(55,113,200,.30)" },
  orange: { a: "#c8713a", strong: "#a85a28", strongHover: "#8f4c20", soft: "rgba(200,113,58,.16)", soft2: "rgba(200,113,58,.30)" }
};

const KEY = "at.settings";

function load(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function apply(s: AppSettings): void {
  const ac = ACCENTS[s.accent] || ACCENTS.green;
  const root = document.documentElement;
  root.style.setProperty("--accent", ac.a);
  root.style.setProperty("--accent-strong", ac.strong);
  root.style.setProperty("--accent-strong-hover", ac.strongHover);
  root.style.setProperty("--accent-soft", ac.soft);
  root.style.setProperty("--accent-soft-2", ac.soft2);
  root.classList.toggle("reduce-motion", !!s.reduceMotion);
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => load());

  useEffect(() => { apply(settings); }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { settings, update };
}
