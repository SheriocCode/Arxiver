import fs from "node:fs";
import crypto from "node:crypto";
import type { StorageEntry } from "../shared/types";
import * as storage from "./storage";

export interface ItemNote {
  id: string;
  text: string;
  date: string;
}

export interface TranslationRef {
  cacheKey: string;
  target_lang: string;
  service: string;
  model: string;
  output_variant: string;
  pages: string;
  created_at: number;
  name: string;
}

export interface LibraryDoc {
  id: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi: string;
  type: string;
  abstract: string;
  summary: string;
  tags: string[];
  collections: string[];
  starred: boolean;
  read: boolean;
  notes: ItemNote[];
  sourceUrl: string;
  sourceName: string;
  files: { source: string | null };
  translations: TranslationRef[];
  added_at: number;
  modified_at: number;
  trash: boolean;
  trashedAt: number | null;
}

export interface LibraryCollection {
  id: string;
  name: string;
  parent: string | null;
}

export interface ReadingRecord {
  itemId: string;
  at: number;
}

interface LibraryState {
  documents: LibraryDoc[];
  collections: LibraryCollection[];
  history: ReadingRecord[];
  tag_colors: Record<string, string>;
  /** 用户显式新建的标签（可能暂时没有文献，只为配色/搜索用） */
  tag_names: string[];
}

function indexPath(): string {
  return storage.indexPath();
}

let state: LibraryState | null = null;

function load(): LibraryState {
  if (state) {
    return state;
  }
  let parsed: Partial<LibraryState> | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
  } catch {
    parsed = null;
  }
  state = {
    documents: Array.isArray(parsed?.documents) ? (parsed!.documents as LibraryDoc[]) : [],
    collections: Array.isArray(parsed?.collections) ? (parsed!.collections as LibraryCollection[]) : [],
    history: Array.isArray(parsed?.history) ? (parsed!.history as ReadingRecord[]) : [],
    tag_colors: parsed?.tag_colors && typeof parsed.tag_colors === "object" ? parsed.tag_colors : {},
    tag_names: Array.isArray(parsed?.tag_names) ? (parsed!.tag_names as string[]) : []
  };
  // normalize older records
  for (const doc of state.documents) {
    if (!Array.isArray(doc.collections)) {
      doc.collections = (doc as { collection?: string }).collection ? [(doc as { collection?: string }).collection as string] : [];
    }
    if (typeof doc.trash !== "boolean") { doc.trash = false; }
    if (!doc.type) { doc.type = /arxiv/i.test(doc.sourceUrl || "") ? "预印本" : "文档"; }
    if (typeof doc.modified_at !== "number") { doc.modified_at = doc.added_at || 0; }
    if (typeof doc.starred !== "boolean") { doc.starred = false; }
    if (typeof doc.summary !== "string") { doc.summary = ""; }
    if (!Array.isArray(doc.translations)) { doc.translations = []; }
    const notesAny = doc.notes as unknown;
    if (typeof notesAny === "string") {
      doc.notes = notesAny.trim() ? [{ id: "n" + Date.now(), text: notesAny, date: new Date().toISOString().slice(0, 10) }] : [];
    } else if (!Array.isArray(doc.notes)) {
      doc.notes = [];
    }
  }
  for (const col of state.collections) {
    if (col.parent === undefined) { col.parent = null; }
  }
  return state;
}

function save(): void {
  const file = indexPath();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function getDocument(id: string): LibraryDoc | null {
  return load().documents.find((doc) => doc.id === id) || null;
}

export function addDocument(input: {
  bytes?: Buffer;
  name?: string;
  sourceUrl?: string;
  title?: string;
  type?: string;
  collections?: string[];
  authors?: string;
  year?: string;
  venue?: string;
  doi?: string;
  tags?: string[];
  summary?: string;
  abstract?: string;
}): LibraryDoc {
  const store = load();
  const id = crypto.randomBytes(8).toString("hex");
  const sourceFile = storage.sourceFile(id);
  if (input.bytes) {
    storage.ensureDocDir(id);
    fs.writeFileSync(sourceFile, input.bytes);
  }
  const stem = String(input.name || "paper.pdf").replace(/\.pdf$/i, "");
  const now = Date.now() / 1000;
  const doc: LibraryDoc = {
    id,
    title: String(input.title || stem || "未命名").trim(),
    authors: input.authors || "",
    year: input.year || "",
    venue: input.venue || "",
    doi: input.doi || "",
    type: input.type || (/arxiv/i.test(input.sourceUrl || "") ? "预印本" : "文档"),
    abstract: input.abstract || "",
    summary: input.summary || "",
    tags: input.tags || [],
    collections: input.collections || [],
    starred: false,
    read: false,
    notes: [],
    sourceUrl: input.sourceUrl || "",
    sourceName: input.name || "paper.pdf",
    files: { source: input.bytes ? "paper.pdf" : null },
    translations: [],
    added_at: now,
    modified_at: now,
    trash: false,
    trashedAt: null
  };
  store.documents.unshift(doc);
  save();
  return doc;
}

const ALLOWED: (keyof LibraryDoc)[] = [
  "title", "authors", "year", "venue", "doi", "type", "abstract", "summary",
  "tags", "collections", "starred", "read", "notes"
];

export function updateDocument(id: string, patch: Partial<LibraryDoc>): LibraryDoc | null {
  const doc = getDocument(id);
  if (!doc) {
    return null;
  }
  for (const key of ALLOWED) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      (doc as unknown as Record<string, unknown>)[key] = (patch as unknown as Record<string, unknown>)[key];
    }
  }
  doc.modified_at = Date.now() / 1000;
  save();
  return doc;
}

function deleteFile(doc: LibraryDoc): void {
  storage.removeDocDir(doc.id);
}

export function setTrash(id: string, trashed: boolean): LibraryDoc | null {
  const doc = getDocument(id);
  if (!doc) {
    return null;
  }
  doc.trash = trashed;
  doc.trashedAt = trashed ? Date.now() / 1000 : null;
  doc.modified_at = Date.now() / 1000;
  save();
  return doc;
}

export function purge(id: string): boolean {
  const store = load();
  const doc = getDocument(id);
  if (doc) {
    deleteFile(doc);
  }
  store.documents = store.documents.filter((item) => item.id !== id);
  store.history = store.history.filter((item) => item.itemId !== id);
  save();
  return true;
}

export function emptyTrash(): number {
  const store = load();
  const trashed = store.documents.filter((item) => item.trash);
  for (const doc of trashed) {
    deleteFile(doc);
  }
  store.documents = store.documents.filter((item) => !item.trash);
  const alive = new Set(store.documents.map((d) => d.id));
  store.history = store.history.filter((item) => alive.has(item.itemId));
  save();
  return trashed.length;
}

export function addCollection(name: string, parent: string | null = null): LibraryCollection {
  const store = load();
  const clean = String(name || "新集合").trim() || "新集合";
  // 同一层级下重名不重复创建，直接返回已有的
  const dup = store.collections.find((c) => (c.parent || null) === (parent || null) && c.name.toLowerCase() === clean.toLowerCase());
  if (dup) { return dup; }
  const collection = { id: crypto.randomBytes(4).toString("hex"), name: clean, parent };
  store.collections.push(collection);
  save();
  return collection;
}

export function removeCollection(id: string): boolean {
  const store = load();
  const removed = new Set<string>([id]);
  // also remove descendants
  let changed = true;
  while (changed) {
    changed = false;
    for (const col of store.collections) {
      if (col.parent && removed.has(col.parent) && !removed.has(col.id)) {
        removed.add(col.id);
        changed = true;
      }
    }
  }
  store.collections = store.collections.filter((item) => !removed.has(item.id));
  for (const doc of store.documents) {
    doc.collections = doc.collections.filter((c) => !removed.has(c));
  }
  save();
  return true;
}

export function setTagColor(tag: string, color: string): void {
  const store = load();
  const name = String(tag || "").trim();
  if (!name) { return; }
  if (color) { store.tag_colors[name] = color; }
  else { delete store.tag_colors[name]; }
  save();
}

/** 新建标签（只为让它出现在侧栏；实际归属仍由文献决定） */
export function addTag(name: string): boolean {
  const store = load();
  const t = String(name || "").trim();
  if (!t) { return false; }
  // 重复检测：已登记、或已被某篇文献使用，都不再重复登记
  if (store.tag_names.includes(t)) { return false; }
  if (store.documents.some((d) => d.tags && d.tags.includes(t))) { return false; }
  store.tag_names.push(t);
  save();
  return true;
}

/** 重命名标签：改所有文档上的标签名，并迁移颜色 */
export function renameTag(from: string, to: string): boolean {
  const store = load();
  const a = String(from || "").trim();
  const b = String(to || "").trim();
  if (!a || !b || a === b) { return false; }
  for (const doc of store.documents) {
    if (doc.tags && doc.tags.includes(a)) {
      doc.tags = Array.from(new Set(doc.tags.map((t) => (t === a ? b : t))));
      doc.modified_at = Date.now() / 1000;
    }
  }
  if (store.tag_colors[a]) {
    store.tag_colors[b] = store.tag_colors[a];
    delete store.tag_colors[a];
  }
  store.tag_names = Array.from(new Set(store.tag_names.map((t) => (t === a ? b : t))));
  save();
  return true;
}

/** 删除标签：从所有文档上移除，并清掉颜色与登记 */
export function deleteTag(name: string): boolean {
  const store = load();
  const t = String(name || "").trim();
  if (!t) { return false; }
  for (const doc of store.documents) {
    if (doc.tags && doc.tags.includes(t)) {
      doc.tags = doc.tags.filter((x) => x !== t);
      doc.modified_at = Date.now() / 1000;
    }
  }
  delete store.tag_colors[t];
  store.tag_names = store.tag_names.filter((x) => x !== t);
  save();
  return true;
}

/** 把若干文献加入某个分类（collectionId 为 null 表示从所有分类移出 → 未分类） */
export function setDocsCollection(ids: string[], collectionId: string | null): number {
  const store = load();
  const wanted = new Set(ids || []);
  let changed = 0;
  for (const doc of store.documents) {
    if (!wanted.has(doc.id)) { continue; }
    if (collectionId === null) {
      if (doc.collections.length === 0) { continue; }
      doc.collections = [];
    } else {
      if (doc.collections.includes(collectionId)) { continue; }
      doc.collections = [...doc.collections, collectionId];
    }
    doc.modified_at = Date.now() / 1000;
    changed++;
  }
  if (changed) { save(); }
  return changed;
}

/** 重命名分类（分类只是虚拟归类，不会移动任何文件）；同层级重名会被拒绝 */
export function renameCollection(id: string, name: string): boolean {
  const store = load();
  const col = store.collections.find((c) => c.id === id);
  const n = String(name || "").trim();
  if (!col || !n) { return false; }
  const dup = store.collections.some((c) => c.id !== id && (c.parent || null) === (col.parent || null) && c.name.toLowerCase() === n.toLowerCase());
  if (dup) { return false; }
  col.name = n;
  save();
  return true;
}

/** 移动分类：target 为 null 表示移到「我的文库」根下末尾；
 *  position = before/after 表示插到某个分类的前/后（同级排序），inside 表示成为其子分类。 */
export function moveCollection(id: string, target: string | null, position: "before" | "after" | "inside"): boolean {
  const store = load();
  const col = store.collections.find((c) => c.id === id);
  if (!col) { return false; }

  if (target === null) {
    col.parent = null;
    store.collections = [...store.collections.filter((c) => c.id !== id), col];
    save();
    return true;
  }

  const tgt = store.collections.find((c) => c.id === target);
  if (!tgt || tgt.id === id) { return false; }
  // 不允许挂到自己的子孙下面
  let walk: string | null = tgt.id;
  while (walk) {
    if (walk === id) { return false; }
    walk = store.collections.find((c) => c.id === walk)?.parent || null;
  }

  if (position === "inside") {
    col.parent = tgt.id;
    save();
    return true;
  }

  col.parent = tgt.parent;
  const rest = store.collections.filter((c) => c.id !== id);
  const idx = rest.findIndex((c) => c.id === tgt.id);
  rest.splice(position === "before" ? idx : idx + 1, 0, col);
  store.collections = rest;
  save();
  return true;
}

export function recordOpen(id: string): void {
  const store = load();
  const now = Date.now() / 1000;
  store.history = store.history.filter((item) => item.itemId !== id);
  store.history.unshift({ itemId: id, at: now });
  if (store.history.length > 500) {
    store.history.length = 500;
  }
  save();
}

export function addTranslation(id: string, ref: TranslationRef): LibraryDoc | null {
  const doc = getDocument(id);
  if (!doc) { return null; }
  doc.translations = (doc.translations || []).filter((t) => t.cacheKey !== ref.cacheKey);
  doc.translations.unshift(ref);
  doc.modified_at = Date.now() / 1000;
  save();
  return doc;
}

export function removeTranslation(id: string, cacheKey: string): LibraryDoc | null {
  const doc = getDocument(id);
  if (!doc) { return null; }
  doc.translations = (doc.translations || []).filter((t) => t.cacheKey !== cacheKey);
  storage.removeTranslation(id, cacheKey);
  doc.modified_at = Date.now() / 1000;
  save();
  return doc;
}

export function sourcePath(id: string): string | null {
  const file = storage.sourceFile(id);
  return fs.existsSync(file) ? file : null;
}

export function readSource(id: string): Buffer | null {
  const file = storage.sourceFile(id);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function list(): LibraryState {
  return load();
}

export function listTranslations(): { entries: StorageEntry[]; total: number } {
  const entries: StorageEntry[] = [];
  let total = 0;
  for (const doc of load().documents) {
    for (const ref of doc.translations || []) {
      let size = 0;
      for (const variant of ["dual", "mono"] as const) {
        const file = storage.variantFile(doc.id, ref.cacheKey, variant);
        if (fs.existsSync(file)) { size += fs.statSync(file).size; }
      }
      entries.push({
        id: ref.cacheKey,
        name: ref.name,
        source_name: doc.sourceName,
        source_url: doc.sourceUrl,
        service: ref.service,
        source_lang: "",
        target_lang: ref.target_lang,
        output_variant: ref.output_variant,
        pages: ref.pages,
        size,
        created_at: ref.created_at
      });
      total += size;
    }
  }
  entries.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return { entries, total };
}
