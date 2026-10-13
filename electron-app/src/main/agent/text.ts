import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pythonExe, engineDir } from "../paths";
import * as storage from "../storage";

const execFileAsync = promisify(execFile);

export interface PageText { page: number; text: string }
export interface Chunk { docId: string; page: number; index: number; text: string }

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

const pageCache = new Map<string, PageText[]>();
const chunkCache = new Map<string, Chunk[]>();

function pagesFile(docId: string): string {
  return path.join(storage.docDir(docId), "text.json");
}

export async function loadPages(docId: string): Promise<PageText[]> {
  const cached = pageCache.get(docId);
  if (cached) { return cached; }
  const file = pagesFile(docId);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PageText[];
      pageCache.set(docId, parsed);
      return parsed;
    } catch { /* fall through to extraction */ }
  }
  const source = storage.sourceFile(docId);
  if (!fs.existsSync(source)) { return []; }
  let pages: PageText[] = [];
  try {
    const { stdout } = await execFileAsync(pythonExe(), [path.join(engineDir(), "extract_text.py"), source], {
      cwd: engineDir(),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    pages = JSON.parse(stdout) as PageText[];
    storage.ensureDocDir(docId);
    fs.writeFileSync(file, JSON.stringify(pages), "utf8");
  } catch {
    pages = [];
  }
  pageCache.set(docId, pages);
  return pages;
}

function chunkPages(docId: string, pages: PageText[]): Chunk[] {
  const chunks: Chunk[] = [];
  let index = 0;
  for (const { page, text } of pages) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!clean) { continue; }
    let start = 0;
    while (start < clean.length) {
      const slice = clean.slice(start, start + CHUNK_SIZE);
      chunks.push({ docId, page, index: index++, text: slice });
      if (start + CHUNK_SIZE >= clean.length) { break; }
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }
  return chunks;
}

export async function loadChunks(docId: string): Promise<Chunk[]> {
  const cached = chunkCache.get(docId);
  if (cached) { return cached; }
  const chunks = chunkPages(docId, await loadPages(docId));
  chunkCache.set(docId, chunks);
  return chunks;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const latin = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = latin.exec(text.toLowerCase())) !== null) { out.push(m[0]); }
  const cjk = /[\u4e00-\u9fff]/g;
  while ((m = cjk.exec(text)) !== null) { out.push(m[0]); }
  return out;
}

export interface Hit { docId: string; page: number; score: number; text: string }

export async function search(docIds: string[], query: string, limit = 8): Promise<Hit[]> {
  const qTerms = Array.from(new Set(tokenize(query)));
  if (qTerms.length === 0) { return []; }
  const all: Chunk[] = [];
  for (const id of docIds) { all.push(...await loadChunks(id)); }
  if (all.length === 0) { return []; }

  const docFreq = new Map<string, number>();
  const chunkTerms: Map<string, number>[] = [];
  for (const chunk of all) {
    const tf = new Map<string, number>();
    for (const term of tokenize(chunk.text)) { tf.set(term, (tf.get(term) || 0) + 1); }
    chunkTerms.push(tf);
    for (const term of qTerms) { if (tf.has(term)) { docFreq.set(term, (docFreq.get(term) || 0) + 1); } }
  }
  const N = all.length;
  const avgLen = all.reduce((s, c) => s + c.text.length, 0) / N || 1;
  const k1 = 1.2, b = 0.75;

  const scored = all.map((chunk, i) => {
    const tf = chunkTerms[i];
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term) || 0;
      if (!f) { continue; }
      const df = docFreq.get(term) || 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (chunk.text.length / avgLen)));
    }
    return { docId: chunk.docId, page: chunk.page, score, text: chunk.text };
  });
  return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

export function pageRange(docId: string, pages: PageText[], spec?: string): PageText[] {
  if (!spec) { return pages; }
  const wanted = new Set<number>();
  for (const part of String(spec).split(",")) {
    const p = part.trim();
    if (!p) { continue; }
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((x) => parseInt(x, 10));
      if (!isNaN(a) && !isNaN(b)) { for (let i = a; i <= b; i++) { wanted.add(i); } }
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) { wanted.add(n); }
    }
  }
  return wanted.size ? pages.filter((pg) => wanted.has(pg.page)) : pages;
}
