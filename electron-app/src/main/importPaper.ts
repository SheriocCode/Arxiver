import path from "node:path";
import * as library from "./library";
import * as logger from "./logger";
import { parseIdentifier, resolveIdentifier } from "./metadata";
import { enrichDocMeta } from "./enrich";

// 按标识符（arXiv / DOI）或链接把一篇论文导入文库：
//   1) 能解析出 arXiv/DOI → 走官方接口取元信息（arXiv 接口不可用时用 PDF 兜底）；
//   2) 链接是 PDF → 直接下载；
//   3) 链接是网页 → 找 citation_pdf_url / <link type="application/pdf"> / 第一个 .pdf 链接；
// 入库后用 enrichDocMeta 补全（PDF 自带的标题、作者、首页里的编号）。
// 供 IPC（新建文献里的"按标识符导入"）与 agent 工具（import_paper）共用。

const UA = "Arxiver/0.8 (+https://github.com/SheriocCode/Arxiver)";

function arxivToPdf(url: string): string {
  const m = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/abs\/([^?#\s]+)/i.exec(url);
  return m ? `https://arxiv.org/pdf/${m[1].replace(/v\d+$/, "")}.pdf` : url;
}

export async function fetchPdf(
  url: string,
  onProgress?: (text: string) => void
): Promise<{ bytes: Buffer; name: string; sourceUrl: string }> {
  const target = arxivToPdf(url);
  const ctrl = new AbortController();
  // 不限制总时长（大 PDF 慢慢下也能下完），只在"连续一段时间收不到任何数据"时才判定超时
  const IDLE_MS = 60000;
  let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_MS);
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_MS);
  };
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  try {
    const res = await fetch(target, { redirect: "follow", headers: { "User-Agent": UA }, signal: ctrl.signal });
    touch();
    if (!res.ok) { throw new Error(`下载失败：HTTP ${res.status}`); }
    const total = Number(res.headers.get("content-length")) || 0;
    let bytes: Buffer;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastPct = -1;
      let lastReported = 0;
      let lastText = "";
      const report = (text: string): void => {
        if (text === lastText) { return; }
        lastText = text;
        onProgress?.(text);
      };
      for (;;) {
        const { done, value } = await reader.read();
        touch();
        if (done) { break; }
        if (!value || !value.length) { continue; }
        chunks.push(value);
        received += value.length;
        // 有 Content-Length 就同时报大小和百分比；没有就按已下载大小报，避免一直停在"正在下载"
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            report(`正在下载 PDF… ${mb(received)} / ${mb(total)} MB（${pct}%）`);
          }
        } else if (received - lastReported >= 1024 * 1024) {
          lastReported = received;
          report(`正在下载 PDF… ${mb(received)} MB`);
        }
      }
      bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } else {
      onProgress?.("正在下载 PDF…");
      bytes = Buffer.from(await res.arrayBuffer());
    }
    let name = "paper.pdf";
    try {
      const parsed = new URL(res.url || target);
      name = path.basename(decodeURIComponent(parsed.pathname)) || name;
    } catch { /* keep default */ }
    if (!/\.pdf$/i.test(name)) { name += ".pdf"; }
    return { bytes, name, sourceUrl: target };
  } catch (e) {
    if (timedOut) { throw new Error(`下载超时：${IDLE_MS / 1000} 秒内没有收到新数据`); }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 网页里找 PDF 直链（CVF / PMLR / 出版社页面常见）
async function findPdfOnPage(url: string): Promise<{ pdfUrl: string; title: string } | null> {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA } });
  if (!res.ok) { return null; }
  const html = (await res.text()).slice(0, 400000);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
  const meta = /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i.exec(html);
  let href = meta?.[1] || "";
  if (!href) {
    const alt = /<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/i.exec(html);
    href = alt?.[1] || "";
  }
  if (!href) {
    const m = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i.exec(html);
    href = m?.[1] || "";
  }
  if (!href) { return null; }
  try { return { pdfUrl: new URL(href, url).toString(), title }; } catch { return null; }
}

export interface ImportResult {
  ok: boolean;
  doc?: ReturnType<typeof library.getDocument>;
  error?: string;
}

export async function importPaper(input: {
  identifier?: string;
  url?: string;
  collections?: string[];
  onProgress?: (text: string) => void;
}): Promise<ImportResult> {
  const say = (t: string): void => { try { input.onProgress?.(t); } catch { /* ignore */ } };
  const collections = Array.isArray(input.collections) ? input.collections.filter(Boolean) : [];
  const raw = String(input.identifier || input.url || "").trim();
  if (!raw) { return { ok: false, error: "需要 arXiv/DOI 编号或一个链接" }; }
  const parsed = parseIdentifier(raw);
  try {
    let bytes: Buffer | undefined;
    let name = "";
    let sourceUrl = "";
    let title = "";
    let type = "文档";
    let probeFallback = false;

    if (parsed) {
      say("正在查询元信息…");
      let meta = await resolveIdentifier(raw);
      if (!meta && parsed.kind === "arxiv") {
        // arXiv 元信息接口不可用（限流 / 离线）时兜底：直接下 PDF，元信息交给 PDF 探测
        meta = {
          kind: "arxiv", id: parsed.id, title: parsed.id, authors: "", year: "",
          venue: "arXiv 预印本", doi: "", abstract: "",
          pdfUrl: `https://arxiv.org/pdf/${parsed.id}`,
          pageUrl: `https://arxiv.org/abs/${parsed.id}`
        };
        probeFallback = true;
        logger.warn("library", `arXiv 元信息接口不可用，改用 PDF 兜底导入：${parsed.id}`);
      }
      if (!meta) { return { ok: false, error: "没识别出 arXiv 编号或 DOI（可直接粘贴链接）" }; }
      name = meta.id.replace(/[\\/:*?"<>|]/g, "_") + ".pdf";
      sourceUrl = meta.pageUrl;
      title = meta.title || meta.id;
      type = meta.kind === "arxiv" ? "预印本" : "期刊论文";
      if (meta.pdfUrl) {
        try {
          say("正在下载 PDF…");
          const loaded = await fetchPdf(meta.pdfUrl, say);
          bytes = loaded.bytes;
          if (loaded.name) { name = loaded.name; }
        } catch (e) {
          logger.warn("library", "下载 PDF 失败（仍导入元信息）：" + logger.errText(e));
        }
      }
      say("正在写入文库…");
      const doc = library.addDocument({ bytes, name, sourceUrl, title, type, collections });
      library.updateDocument(doc.id, {
        authors: meta.authors, year: meta.year, venue: meta.venue, doi: meta.doi,
        abstract: meta.abstract, summary: meta.abstract
      });
      logger.info("library", `按标识符导入：${title}（${meta.kind}）`);
      if (probeFallback) { say("正在从 PDF 补全标题/作者…"); }
      const finalDoc = probeFallback ? await enrichDocMeta(doc.id, say) : library.getDocument(doc.id);
      return { ok: true, doc: finalDoc };
    }

    // 不是 arXiv/DOI：按链接处理
    const url = raw;
    const isPdf = /\.pdf(\?|$)/i.test(url);
    let pdfUrl = isPdf ? url : "";
    if (!pdfUrl) {
      say("正在解析页面里的 PDF 链接…");
      const found = await findPdfOnPage(url);
      if (!found) {
        return { ok: false, error: "这个链接既不是 arXiv/DOI，页面里也没找到 PDF 直链（可以给我 PDF 链接）" };
      }
      pdfUrl = found.pdfUrl;
      title = found.title || "";
    }
    say("正在下载 PDF…");
    const loaded = await fetchPdf(pdfUrl, say);
    bytes = loaded.bytes;
    name = loaded.name;
    sourceUrl = url;
    if (!title) { title = name.replace(/\.pdf$/i, ""); }
    say("正在写入文库…");
    const doc = library.addDocument({ bytes, name, sourceUrl, title, type: "文档", collections });
    logger.info("library", `按链接导入：${title}（${pdfUrl}）`);
    say("正在从 PDF 补全标题/作者…");
    const finalDoc = await enrichDocMeta(doc.id, say);
    return { ok: true, doc: finalDoc };
  } catch (e) {
    logger.warn("library", "导入失败：" + logger.errText(e));
    return { ok: false, error: logger.errText(e, 200) };
  }
}
