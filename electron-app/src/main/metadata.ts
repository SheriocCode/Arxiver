import type { ResolvedMeta } from "../shared/types";

// 按标识符取元信息（对齐 Zotero 的做法：走官方接口，不爬页面）
//   arXiv → https://export.arxiv.org/api/query?id_list=…  (Atom XML)
//   DOI   → https://api.crossref.org/works/<doi>          (JSON)
const UA = "Arxiver/0.8 (+https://github.com/SheriocCode/Arxiver)";

const ARXIV_ID = /(?:arxiv\.org\/(?:abs|pdf)\/)?((?:[a-z-]+(?:\.[A-Z]{2})?\/)?\d{4}\.\d{4,5}(?:v\d+)?)/;
const DOI_RE = /(10\.\d{4,9}\/[^\s"'<>]+)/;

export function parseIdentifier(input: string): { kind: "arxiv" | "doi"; id: string } | null {
  const s = String(input || "").trim();
  if (!s) { return null; }
  const doi = DOI_RE.exec(s.replace(/^doi:\s*/i, "").trim());
  if (doi) {
    const id = doi[1].replace(/[.,;)\]]+$/, "");
    // arXiv 的 DOI 形式 10.48550/arXiv.2401.12345 → 直接按 arXiv 处理
    const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(id);
    if (ax) { return { kind: "arxiv", id: ax[1] }; }
    return { kind: "doi", id };
  }
  const ax = ARXIV_ID.exec(s);
  if (ax) { return { kind: "arxiv", id: ax[1] }; }
  return null;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function getText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) { return null; }
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveArxiv(id: string): Promise<ResolvedMeta | null> {
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  if (!xml) { return null; }
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) { return null; }
  const tag = (name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decode(m[1]) : "";
  };
  const title = tag("title");
  if (!title || /^error/i.test(title)) { return null; }
  const authors = Array.from(entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g))
    .map((m) => decode(m[1])).filter(Boolean);
  const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry)?.[1] || `https://arxiv.org/pdf/${id}`;
  return {
    kind: "arxiv",
    id,
    title,
    authors: authors.join(", "),
    year: tag("published").slice(0, 4),
    venue: tag("arxiv:journal_ref") || "arXiv 预印本",
    doi: tag("arxiv:doi"),
    abstract: tag("summary"),
    pdfUrl: pdf,
    pageUrl: `https://arxiv.org/abs/${id}`
  };
}

export async function resolveDoi(doi: string): Promise<ResolvedMeta | null> {
  const text = await getText(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!text) { return null; }
  let msg: Record<string, any> | null = null;
  try { msg = JSON.parse(text)?.message ?? null; } catch { return null; }
  if (!msg) { return null; }
  const parts = (msg.issued?.["date-parts"]?.[0] || []) as number[];
  const authors = ((msg.author || []) as any[])
    .map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name || "")
    .filter(Boolean);
  const abstract = String(msg.abstract || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    kind: "doi",
    id: doi,
    title: String((msg.title || [])[0] || "").trim(),
    authors: authors.join(", "),
    year: parts[0] ? String(parts[0]) : "",
    venue: String((msg["container-title"] || [])[0] || msg.publisher || "").trim(),
    doi,
    abstract,
    pdfUrl: "",
    pageUrl: String(msg.URL || `https://doi.org/${doi}`)
  };
}

export async function resolveIdentifier(input: string): Promise<ResolvedMeta | null> {
  const parsed = parseIdentifier(input);
  if (!parsed) { return null; }
  return parsed.kind === "arxiv" ? resolveArxiv(parsed.id) : resolveDoi(parsed.id);
}
