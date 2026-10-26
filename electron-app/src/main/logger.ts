import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./paths";
import type { LogLevel, SystemLogEntry } from "../shared/types";

// 系统运行日志：内存环形缓冲（供界面显示）+ 追加写入 data/logs/app.log（便于排查）。
const MAX_ENTRIES = 800;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const buffer: SystemLogEntry[] = [];

export function logFile(): string {
  return path.join(userDataDir(), "logs", "app.log");
}

function trimFile(file: string): void {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-Math.floor(MAX_FILE_BYTES / 2)), "utf8");
    }
  } catch {
    /* ignore */
  }
}

export function log(level: LogLevel, scope: string, message: string): void {
  const entry: SystemLogEntry = { at: Date.now(), level, scope, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) { buffer.splice(0, buffer.length - MAX_ENTRIES); }
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    trimFile(file);
    fs.appendFileSync(file, `${new Date(entry.at).toISOString()} [${level}] ${scope}: ${message}\n`, "utf8");
  } catch {
    /* 写日志失败不影响业务 */
  }
}

/** 新的在前 */
export function list(): SystemLogEntry[] {
  return buffer.slice().reverse();
}

// 读历史：解析 data/logs/app.log（跨启动保留）。写日志是同步追加的，
// 所以文件里已经包含当前会话，内存缓冲只作为读取失败时的兜底。
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[(info|warn|error)\] ([^:]+): (.*)$/;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 500;

// 文件没变就不重复解析：翻页 / 切级别只切数组
let cache: { stamp: string; entries: SystemLogEntry[] } | null = null;

function readAll(): SystemLogEntry[] {
  let stamp = "";
  try {
    const st = fs.statSync(logFile());
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return list();
  }
  if (cache && cache.stamp === stamp) { return cache.entries; }
  let text = "";
  try {
    text = fs.readFileSync(logFile(), "utf8");
  } catch {
    return list();
  }
  const parsed: SystemLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) { continue; }
    const m = LINE.exec(line);
    if (!m) {
      // 续行（消息里带换行）或轮转截断的半行：接在上一条后面
      if (parsed.length) { parsed[parsed.length - 1].message += "\n" + line; }
      continue;
    }
    const at = Date.parse(m[1]);
    if (Number.isNaN(at)) { continue; }
    parsed.push({ at, level: m[2] as LogLevel, scope: m[3], message: m[4] });
  }
  if (!parsed.length) { return list(); }
  const entries = parsed.reverse(); // 新的在前
  cache = { stamp, entries };
  return entries;
}

/** 近 7 天每天条数，老的在前（索引 6 = 今天） */
function dayCounts(entries: SystemLogEntry[]): number[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = new Array(7).fill(0) as number[];
  for (const e of entries) {
    const d = new Date(e.at);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
    if (diff >= 0 && diff < 7) { days[6 - diff] += 1; }
  }
  return days;
}

export interface SystemLogPage {
  entries: SystemLogEntry[];
  total: number;
  stats: { total: number; error: number; warn: number; scopes: number; days: number[] };
}

/** 分页读日志：按级别过滤后再分页，避免把整份文件塞给界面 */
export function page(query: { level?: string; offset?: number; limit?: number } = {}): SystemLogPage {
  const all = readAll();
  const level = query.level === "info" || query.level === "warn" || query.level === "error" ? query.level : null;
  const matched = level ? all.filter((e) => e.level === level) : all;
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE)));
  return {
    entries: matched.slice(offset, offset + limit),
    total: matched.length,
    stats: {
      total: all.length,
      error: all.filter((e) => e.level === "error").length,
      warn: all.filter((e) => e.level === "warn").length,
      scopes: new Set(all.map((e) => e.scope)).size,
      days: dayCounts(all)
    }
  };
}

export const info = (scope: string, message: string): void => log("info", scope, message);
export const warn = (scope: string, message: string): void => log("warn", scope, message);
export const error = (scope: string, message: string): void => log("error", scope, message);

/** Error/任意值 → 单行短文本（写日志用） */
export function errText(e: unknown, max = 400): string {
  const s = e instanceof Error ? e.stack || e.message : String(e);
  return s.replace(/\s+/g, " ").slice(0, max);
}
