import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pythonExe, engineDir } from "./paths";
import * as storage from "./storage";

const execFileAsync = promisify(execFile);

export interface PdfMeta {
  title: string;
  author: string;
  arxivId: string;
  doi: string;
}

/** 用 PyMuPDF 读 PDF 自带元信息 + 首页里的 arXiv 编号 / DOI */
export async function probePdf(docId: string): Promise<PdfMeta | null> {
  const source = storage.sourceFile(docId);
  if (!fs.existsSync(source)) { return null; }
  try {
    const { stdout } = await execFileAsync(pythonExe(), [path.join(engineDir(), "pdfmeta.py"), source], {
      cwd: engineDir(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    const parsed = JSON.parse(stdout) as Partial<PdfMeta>;
    return {
      title: parsed?.title || "",
      author: parsed?.author || "",
      arxivId: parsed?.arxivId || "",
      doi: parsed?.doi || ""
    };
  } catch {
    return null;
  }
}
