import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pythonExe, engineDir } from "./paths";
import * as storage from "./storage";
import type { DocOutline } from "../shared/types";

const execFileAsync = promisify(execFile);

const memory = new Map<string, DocOutline>();

function cacheFile(docId: string): string {
  return path.join(storage.docDir(docId), "outline.json");
}

// Outline for a document: the PDF's own bookmarks, or an offline heuristic when it
// has none. Result is cached in memory and on disk (outline.json next to the PDF).
export async function getOutline(docId: string): Promise<DocOutline> {
  const cached = memory.get(docId);
  if (cached) { return cached; }
  const file = cacheFile(docId);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DocOutline;
      if (Array.isArray(parsed.items)) { memory.set(docId, parsed); return parsed; }
    } catch { /* re-extract below */ }
  }
  const source = storage.sourceFile(docId);
  if (!fs.existsSync(source)) { return { source: "none", items: [] }; }

  let result: DocOutline = { source: "none", items: [] };
  try {
    const { stdout } = await execFileAsync(pythonExe(), [path.join(engineDir(), "outline.py"), source], {
      cwd: engineDir(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    const parsed = JSON.parse(stdout) as DocOutline;
    if (Array.isArray(parsed.items)) { result = parsed; }
    storage.ensureDocDir(docId);
    fs.writeFileSync(file, JSON.stringify(result), "utf8");
  } catch {
    result = { source: "none", items: [] };
  }
  memory.set(docId, result);
  return result;
}
