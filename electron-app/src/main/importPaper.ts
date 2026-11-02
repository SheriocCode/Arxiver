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
  onProgress?: (text: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; name: string; sourceUrl: string }> {
  const target = arxivToPdf(url);
  const ctrl = new AbortController();
  // 不限制总时长（大 PDF 慢慢下也能下完），只在"连续一段时间收不到任何数据"时才判定超时
  const IDLE_MS = 60000;
  let timedOut = false;
  let cancelled = false;
  let timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_MS);
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_MS);
  };
  // 用户手动取消（AI 面板的停止 / 卡片上的取消）：立刻中断下载
  const onAbort = (): void => { cancelled = true; ctrl.abort(); };
  if (signal) {
    if (signal.aborted) { throw new Error("已取消导入"); }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  const speedText = (bytesPerSec: number): string => (bytesPerSec >= 1024 * 1024
    ? `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
    : `${Math.max(0, Math.round(bytesPerSec / 1024))} KB/s`);
  const etaText = (sec: number): string => (sec >= 120 ? `剩 ${Math.round(sec / 60)} 分` : `剩 ${Math.max(1, Math.round(sec))}s`);
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
      let lastReportAt = 0;
      let lastText = "";
      // 速度按 600ms 窗口算，避免瞬时抖动
      const startedAt = Date.now();
      let sampleAt = startedAt;
      let sampleBytes = 0;
      let speed = 0;
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
        const now = Date.now();
        if (now - sampleAt >= 600) {
          speed = (received - sampleBytes) / ((now - sampleAt) / 1000);
          sampleAt = now;
          sampleBytes = received;
        }
        // 有 Content-Length 就报大小 / 百分比 / 速度 / 剩余时间；没有就只报大小和速度
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          const retime = pct !== lastPct || now - lastReportAt >= 600;
          if (retime) {
            lastPct = pct;
            lastReportAt = now;
            const eta = speed > 0 ? (total - received) / speed : 0;
            report(`正在下载 PDF… ${mb(received)} / ${mb(total)} MB（${pct}%${speed > 0 ? " · " + speedText(speed) : ""}${eta > 0 ? " · " + etaText(eta) : ""}）`);
          }
        } else if (now - lastReportAt >= 600) {
          lastReportAt = now;
          report(`正在下载 PDF… ${mb(received)} MB${speed > 0 ? "（" + speedText(speed) + "）" : ""}`);
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
    if (cancelled || signal?.aborted) { throw new Error("已取消导入"); }
    if (timedOut) { throw new Error(`下载超时：${IDLE_MS / 1000} 秒内没有收到新数据（已下载的部分不会保留）`); }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
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
  // 用户取消（AI 面板停止 / 卡片上的取消）：中止下载，且不留下半个条目
  signal?: AbortSignal;
}): Promise<ImportResult> {
  const say = (t: string): void => { try { input.onProgress?.(t); } catch { /* ignore */ } };
  const collections = Array.isArray(input.collections) ? input.collections.filter(Boolean) : [];
  const raw = String(input.identifier || input.url || "").trim();
  if (!raw) { return { ok: false, error: "需要 arXiv/DOI 编号或一个链接" }; }
  if (input.signal?.aborted) { return { ok: false, error: "已取消导入" }; }
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
        // 下载失败 / 被取消就整体失败：不建"只有元信息、没有 PDF"的空条目，
        // 否则用户会得到一个打不开、也不能翻译的文献。
        say("正在下载 PDF…");
        const loaded = await fetchPdf(meta.pdfUrl, say, input.signal);
        bytes = loaded.bytes;
        if (loaded.name) { name = loaded.name; }
      } else {
        return { ok: false, error: "没有找到这篇论文的 PDF 地址；可以手动下载后拖进文库" };
      }
      say("正在写入文库…");
      const doc = library.addDocument({ bytes, name, sourceUrl, title, type, collections });
      try {
        library.updateDocument(doc.id, {
          authors: meta.authors, year: meta.year, venue: meta.venue, doi: meta.doi,
          abstract: meta.abstract, summary: meta.abstract
        });
        // 补全失败不影响已经入库的 PDF（enrichDocMeta 自己会兜底）
        if (probeFallback) { say("正在从 PDF 补全标题/作者…"); }
        const finalDoc = probeFallback ? await enrichDocMeta(doc.id, say) : library.getDocument(doc.id);
        logger.info("library", `按标识符导入：${title}（${meta.kind}）`);
        return { ok: true, doc: finalDoc };
      } catch (e) {
        // 回滚：元信息写入失败就别留这条记录
        library.purge(doc.id);
        logger.warn("library", "写入文库失败，已回滚：" + logger.errText(e));
        return { ok: false, error: "写入文库失败：" + logger.errText(e, 160) };
      }
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
    const loaded = await fetchPdf(pdfUrl, say, input.signal);
    bytes = loaded.bytes;
    name = loaded.name;
    sourceUrl = url;
    if (!title) { title = name.replace(/\.pdf$/i, ""); }
    say("正在写入文库…");
    const doc = library.addDocument({ bytes, name, sourceUrl, title, type: "文档", collections });
    try {
      logger.info("library", `按链接导入：${title}（${pdfUrl}）`);
      say("正在从 PDF 补全标题/作者…");
      const finalDoc = await enrichDocMeta(doc.id, say);
      return { ok: true, doc: finalDoc };
    } catch (e) {
      library.purge(doc.id);
      logger.warn("library", "写入文库失败，已回滚：" + logger.errText(e));
      return { ok: false, error: "写入文库失败：" + logger.errText(e, 160) };
    }
  } catch (e) {
    const msg = logger.errText(e, 200);
    logger.warn("library", "导入失败：" + msg);
    // 取消是用户主动行为，不加"重试"提示
    if (/已取消/.test(msg)) { return { ok: false, error: "已取消导入" }; }
    return { ok: false, error: `${msg}（可重试；也可以手动下载 PDF 后拖进文库）` };
  }
}
