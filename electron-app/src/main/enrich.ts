import * as library from "./library";
import { parseIdentifier, resolveIdentifier } from "./metadata";
import { probePdf } from "./pdfmeta";
import * as logger from "./logger";

// 入库后补全元数据：优先文件名里的 arXiv 编号，其次 PDF 自带元信息 / 首页里的 arXiv、DOI。
// 导入（importPaper）与「本地导入后补全」两条路都走这里。
export async function enrichDocMeta(docId: string): Promise<ReturnType<typeof library.getDocument>> {
  const doc = library.getDocument(docId);
  if (!doc) { return null; }
  try {
    const nameHit = parseIdentifier(doc.sourceName || "");
    let meta = nameHit ? await resolveIdentifier(doc.sourceName || "") : null;
    if (!meta) {
      const probe = await probePdf(docId);
      if (probe) {
        const id = probe.arxivId || probe.doi;
        if (id) { meta = await resolveIdentifier(id); }
        if (!meta) {
          // 只有 PDF 自带的 title/author 也要用上
          const patch: Partial<typeof doc> = {};
          if (probe.title && probe.title.length > 3 && probe.title.length < 300) { patch.title = probe.title; }
          if (probe.author) { patch.authors = probe.author; }
          if (Object.keys(patch).length) { library.updateDocument(docId, patch); }
          return library.getDocument(docId);
        }
      }
    }
    if (meta) {
      library.updateDocument(docId, {
        title: meta.title || doc.title,
        authors: meta.authors || doc.authors,
        year: meta.year || doc.year,
        venue: meta.venue || doc.venue,
        doi: meta.doi || doc.doi,
        abstract: meta.abstract || doc.abstract,
        summary: meta.abstract || doc.summary,
        type: meta.kind === "arxiv" ? "预印本" : doc.type
      });
      logger.info("library", `已补全元信息：${meta.title || docId}`);
    }
    return library.getDocument(docId);
  } catch (e) {
    logger.warn("library", "补全元信息失败：" + logger.errText(e));
    return doc;
  }
}
