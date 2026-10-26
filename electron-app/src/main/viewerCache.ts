import fs from "node:fs";
import path from "node:path";
import * as storage from "./storage";
import type { OutlineItem } from "../shared/types";

// 阅读器里解析好的目录（带页内 anchor）和缩略图都放在文档目录里：
// 第一次打开时生成，之后直接读缓存，不再重新解析 PDF。
export interface ViewerOutline {
  items: OutlineItem[];
  generated: boolean;
}

const outlineMemory = new Map<string, ViewerOutline>();
const THUMB_MAX_BYTES = 4 * 1024 * 1024;

function outlineFile(id: string): string {
  return path.join(storage.docDir(id), "viewer-outline.json");
}

function thumbDir(id: string): string {
  return path.join(storage.docDir(id), "thumbs");
}

function thumbFile(id: string, page: number): string {
  return path.join(thumbDir(id), `${page}.jpg`);
}

function safePage(page: number): number {
  return Math.max(1, Math.floor(Number(page) || 1));
}

export function readViewerOutline(id: string): ViewerOutline | null {
  const cached = outlineMemory.get(id);
  if (cached) { return cached; }
  const file = outlineFile(id);
  if (!fs.existsSync(file)) { return null; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ViewerOutline;
    if (!Array.isArray(parsed.items)) { return null; }
    const value: ViewerOutline = {
      items: parsed.items
        .filter((it) => it && typeof it.title === "string" && typeof it.page === "number")
        .map((it) => ({
          title: it.title,
          page: Math.max(0, Math.floor(it.page)),
          level: Math.max(0, Math.floor(Number(it.level) || 0)),
          anchor: typeof it.anchor === "number" && isFinite(it.anchor) ? it.anchor : 0
        })),
      generated: !!parsed.generated
    };
    outlineMemory.set(id, value);
    return value;
  } catch {
    return null;
  }
}

export function saveViewerOutline(id: string, data: ViewerOutline): boolean {
  if (!id || !data || !Array.isArray(data.items)) { return false; }
  const value: ViewerOutline = {
    items: data.items
      .filter((it) => it && typeof it.title === "string" && typeof it.page === "number")
      .map((it) => ({
        title: it.title,
        page: Math.max(0, Math.floor(it.page)),
        level: Math.max(0, Math.floor(Number(it.level) || 0)),
        anchor: typeof it.anchor === "number" && isFinite(it.anchor) ? it.anchor : 0
      })),
    generated: !!data.generated
  };
  try {
    storage.ensureDocDir(id);
    fs.writeFileSync(outlineFile(id), JSON.stringify(value), "utf8");
    outlineMemory.set(id, value);
    return true;
  } catch {
    return false;
  }
}

// 返回 data URL，渲染端可以直接塞进 Image 再画到 canvas
export function readThumb(id: string, page: number): string | null {
  try {
    const file = thumbFile(id, safePage(page));
    if (!fs.existsSync(file)) { return null; }
    const buf = fs.readFileSync(file);
    if (!buf.length) { return null; }
    return "data:image/jpeg;base64," + buf.toString("base64");
  } catch {
    return null;
  }
}

export function saveThumb(id: string, page: number, dataUrl: string): boolean {
  try {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) { return false; }
    const buf = Buffer.from(m[1], "base64");
    if (!buf.length || buf.length > THUMB_MAX_BYTES) { return false; }
    fs.mkdirSync(thumbDir(id), { recursive: true });
    fs.writeFileSync(thumbFile(id, safePage(page)), buf);
    return true;
  } catch {
    return false;
  }
}
