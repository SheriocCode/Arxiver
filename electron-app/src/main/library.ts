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
    tag_colors: parsed?.tag_colors && typeof parsed.tag_colors === "object" ? parsed.tag_colors : {}
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
  const collection = { id: crypto.randomBytes(4).toString("hex"), name: String(name || "新集合"), parent };
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
