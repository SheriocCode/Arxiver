// 运行状态的后台采样器（模块级单例）：
// 面板卸载后继续采样（只是把间隔放慢），所以来回切换不会丢掉历史曲线；
// 窗口隐藏/暂停时不采样，避免白占 CPU。
import { useEffect, useState } from "react";
import type { AppMetrics } from "../../../shared/types";

export type RuntimeMetric = "work" | "commit";
export type RuntimeGroup = "all" | "window" | "gpu" | "service";
export type RuntimeSort = "kind" | "pid" | "rss" | "cpu";

export interface RuntimeCounters {
  total: number[];
  cpu: number[];
  per: Record<number, number[]>;
}

const SAMPLE_MAX = 90; // 近 3 分钟（2 秒一次）
const WATCH_MS = 2000; // 面板打开时
const IDLE_MS = 8000; // 面板关闭时仍保持连续（稀疏）
const empty = (): RuntimeCounters => ({ total: [], cpu: [], per: {} });

const hist: Record<RuntimeMetric, RuntimeCounters> = { work: empty(), commit: empty() };
const ui = { metric: "work" as RuntimeMetric, group: "all" as RuntimeGroup, sort: "rss" as RuntimeSort, paused: false };

let metrics: AppMetrics | null = null;
let watchers = 0;
let timer = 0;
let inflight = false;
let started = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) { fn(); }
}

function sample(): void {
  if (ui.paused || inflight) { return; }
  if (document.visibilityState === "hidden") { return; }
  inflight = true;
  void window.api.appMetrics({ os: watchers > 0 }).then((d) => {
    metrics = d;
    for (const key of ["work", "commit"] as RuntimeMetric[]) {
      const cur = hist[key];
      const per: Record<number, number[]> = {};
      for (const p of d.procs) {
        per[p.pid] = [...(cur.per[p.pid] || []), key === "commit" ? p.commitMB : p.rssMB].slice(-SAMPLE_MAX);
      }
      hist[key] = {
        total: [...cur.total, key === "commit" ? d.totalCommitMB : d.totalRssMB].slice(-SAMPLE_MAX),
        cpu: [...cur.cpu, d.procs.reduce((n, p) => n + p.cpuPercent, 0)].slice(-SAMPLE_MAX),
        per
      };
    }
    notify();
  }).catch(() => { /* 忽略 */ }).finally(() => { inflight = false; });
}

function schedule(): void {
  window.clearInterval(timer);
  timer = window.setInterval(sample, watchers > 0 ? WATCH_MS : IDLE_MS);
}

// 应用启动时调一次：这样"运行状态"一打开就有历史，而不是从 0 开始
export function startRuntimeMonitor(): void {
  if (started) { return; }
  started = true;
  schedule();
  sample();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { sample(); } });
}

export interface RuntimeStore {
  metrics: AppMetrics | null;
  hist: Record<RuntimeMetric, RuntimeCounters>;
  metric: RuntimeMetric;
  group: RuntimeGroup;
  sort: RuntimeSort;
  paused: boolean;
  setMetric: (v: RuntimeMetric) => void;
  setGroup: (v: RuntimeGroup) => void;
  setSort: (v: RuntimeSort) => void;
  setPaused: (v: boolean) => void;
}

export function useRuntimeMonitor(): RuntimeStore {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = (): void => force((v) => v + 1);
    listeners.add(fn);
    watchers += 1;
    schedule();
    sample();
    return () => { listeners.delete(fn); watchers -= 1; schedule(); };
  }, []);
  const apply = (patch: Partial<typeof ui>): void => {
    Object.assign(ui, patch);
    if (patch.paused === false) { sample(); }
    notify();
  };
  return {
    metrics,
    hist,
    metric: ui.metric,
    group: ui.group,
    sort: ui.sort,
    paused: ui.paused,
    setMetric: (v) => apply({ metric: v }),
    setGroup: (v) => apply({ group: v }),
    setSort: (v) => apply({ sort: v }),
    setPaused: (v) => apply({ paused: v })
  };
}
