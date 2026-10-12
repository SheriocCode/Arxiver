import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./paths";
import type { LogLevel, SystemLogEntry } from "../shared/types";

// 系统运行日志：内存环形缓冲（供界面显示）+ 追加写入 userData/logs/app.log（便于排查）。
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

export const info = (scope: string, message: string): void => log("info", scope, message);
export const warn = (scope: string, message: string): void => log("warn", scope, message);
export const error = (scope: string, message: string): void => log("error", scope, message);

/** Error/任意值 → 单行短文本（写日志用） */
export function errText(e: unknown, max = 400): string {
  const s = e instanceof Error ? e.stack || e.message : String(e);
  return s.replace(/\s+/g, " ").slice(0, max);
}
