import fs from "node:fs";
import path from "node:path";
import { docDir } from "./storage";
import type { PdfAnnotation, PdfAnnotKind, PdfAnnotRect } from "../shared/types";

const KINDS: PdfAnnotKind[] = ["highlight", "underline", "strike", "note"];

function file(id: string): string {
  return path.join(docDir(id), "annotations.json");
}

function isRect(v: unknown): v is PdfAnnotRect {
  if (!v || typeof v !== "object") { return false; }
  const r = v as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && isFinite(r[k] as number));
}

function isAnnotation(v: unknown, docId: string): v is PdfAnnotation {
  if (!v || typeof v !== "object") { return false; }
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) { return false; }
  if (a.docId !== docId) { return false; }
  if (typeof a.page !== "number" || a.page < 1) { return false; }
  if (!KINDS.includes(a.kind as PdfAnnotKind)) { return false; }
  if (!Array.isArray(a.rects) || !a.rects.every(isRect)) { return false; }
  if (a.images !== undefined && (!Array.isArray(a.images) || !a.images.every((s) => typeof s === "string"))) { return false; }
  if (a.links !== undefined && (!Array.isArray(a.links) || !a.links.every((s) => typeof s === "string"))) { return false; }
  return true;
}

// 旧版本的独立"链接"标注已经并入笔记：读盘时顺手迁移成带 links 的笔记
function migrate(v: unknown): unknown {
  if (!v || typeof v !== "object") { return v; }
  const a = v as Record<string, unknown>;
  if (a.kind !== "link" || typeof a.url !== "string") { return v; }
  const links = Array.isArray(a.links) ? a.links.filter((x): x is string => typeof x === "string") : [];
  const rest = { ...a };
  delete rest.url;
  return { ...rest, kind: "note", note: typeof a.note === "string" ? a.note : "", links: a.url ? [...links, a.url] : links };
}

function read(id: string): PdfAnnotation[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file(id), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) { return []; }
  return parsed.map(migrate).filter((v): v is PdfAnnotation => isAnnotation(v, id));
}

function write(id: string, items: PdfAnnotation[]): void {
  fs.mkdirSync(docDir(id), { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(items), "utf8");
}

export function list(id: string): PdfAnnotation[] {
  return read(id).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

/** 新增 / 更新一条标注（按 id 覆盖），返回落盘后的记录 */
export function save(id: string, annot: PdfAnnotation): PdfAnnotation | null {
  if (!isAnnotation(annot, id)) { return null; }
  const items = read(id);
  const next: PdfAnnotation = {
    ...annot,
    id: annot.id,
    docId: id,
    rects: annot.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    images: Array.isArray(annot.images) ? [...annot.images] : undefined,
    links: Array.isArray(annot.links) ? [...annot.links] : undefined,
    updatedAt: Date.now()
  };
  const i = items.findIndex((a) => a.id === next.id);
  if (i >= 0) { items[i] = next; } else { items.push(next); }
  write(id, items);
  return next;
}

export function remove(id: string, annotId: string): boolean {
  const items = read(id);
  const next = items.filter((a) => a.id !== annotId);
  if (next.length === items.length) { return false; }
  write(id, next);
  return true;
}
