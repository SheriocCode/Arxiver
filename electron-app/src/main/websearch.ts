import type { PaperHit } from "../shared/types";
import * as logger from "./logger";

// 联网搜索：Tavily（AI Agent 友好的搜索 API）。
// 不再调用 arXiv 的查询接口（本机 IP 被限流）；论文类结果靠"受控查询 + 学术域名偏好"拿到，
// 再按 URL 里的 arXiv 编号 / DOI 决定能不能一键导入。
// 关键词与查询式必须是英文（由模型负责改写，见 agent 的系统提示词）。

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT = 20000;
const MAX_QUERIES = 4;

// 学术优先白名单：用 prefer 模式（提升权重但不排他），避免把项目主页 / 博客直接过滤掉
const ACADEMIC_DOMAINS = [
  "arxiv.org", "ar5iv.labs.arxiv.org", "alphaxiv.org",
  "openreview.net", "proceedings.neurips.cc", "papers.nips.cc",
  "openaccess.thecvf.com", "thecvf.com", "ecva.net",
  "proceedings.mlr.press", "mlr.press", "journal.ijcai.org", "ojs.aaai.org",
  "aclanthology.org", "semanticscholar.org", "paperswithcode.com",
  "dl.acm.org", "ieeexplore.ieee.org", "link.springer.com", "sciencedirect.com",
  "nature.com", "science.org", "pubmed.ncbi.nlm.nih.gov", "biorxiv.org", "medrxiv.org"
];

const SITE_NAMES: [RegExp, string][] = [
  [/arxiv\.org|ar5iv|alphaxiv/i, "arXiv"],
  [/openreview\.net/i, "OpenReview"],
  [/neurips\.cc|nips\.cc/i, "NeurIPS"],
  [/thecvf\.com|ecva\.net/i, "CVPR / ICCV / ECCV"],
  [/mlr\.press/i, "ICML / PMLR"],
  [/aclanthology\.org/i, "ACL"],
  [/aaai\.org|ijcai\.org/i, "AAAI / IJCAI"],
  [/semanticscholar\.org/i, "Semantic Scholar"],
  [/paperswithcode\.com/i, "Papers with Code"],
  [/github\.com/i, "GitHub"],
  [/dl\.acm\.org/i, "ACM DL"],
  [/ieeexplore\.ieee\.org/i, "IEEE Xplore"],
  [/pubmed|ncbi\.nlm/i, "PubMed"],
  [/biorxiv\.org|medrxiv\.org/i, "bioRxiv / medRxiv"],
  [/nature\.com|science\.org/i, "Nature / Science"],
  [/link\.springer\.com|sciencedirect\.com|wiley\.com|tandfonline\.com/i, "出版社"]
];

export interface WebSearchOptions {
  queries: string[];
  scope?: "academic" | "web";
  mode?: "prefer" | "restrict";
  timeRange?: "day" | "week" | "month" | "year";
  maxResults?: number;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string | null;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return ""; }
}

function siteName(host: string): string {
  for (const [re, name] of SITE_NAMES) { if (re.test(host)) { return name; } }
  return "";
}

function arxivIdIn(text: string): string {
  const m = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i.exec(text || "");
  return m ? m[1] : "";
}

function doiIn(url: string): string {
  // 只认 URL 里的 DOI（doi.org/10.…、dl.acm.org/doi/10.…），避免从摘要里误抓别人的 DOI
  const m = /(?:doi\.org\/|doi\/)(10\.\d{4,9}\/[^\s"'<>?#]+)/i.exec(url || "");
  return m ? m[1].replace(/[.,;)\]]+$/, "") : "";
}

// arXiv 摘要页的标题常带 "[2602.09016] " 前缀
function cleanTitle(t: string): string {
  return String(t || "").replace(/^\s*\[(?:arXiv:)?[0-9a-z.\/-]{4,40}\]\s*/i, "").replace(/\s+/g, " ").trim();
}

// 搜索结果里常混着页面样板（arXiv 摘要页的 Announce Type / Subjects / Title …），
// 抽取真正的摘要；抽不到就宁可留空，也不显示"archive # Computer Science > …"这种噪声。
// arXiv 摘要页在 Tavily 里常返回页脚/侧栏样板（arXivLabs、Bibliographic Explorer…）
const ARXIV_CHROME = /arXivLabs|Bibliographic Explorer|Bibliographic and Citation Tools|Recommenders and Search Tools|We gratefully acknowledge|collaboration between arXiv|Submission history|Full-text links|Change to browse|Export BibTeX|Code, Data and Media|About arXivLabs|e-print archive|Conference paper|Journal article|Book chapter/i;

function tidySnippet(s: string, isArxivAbs: boolean): string {
  let t = String(s || "").replace(/\r/g, "");
  const m = /Abstract:\s*([\s\S]*)/i.exec(t);
  if (m) {
    t = m[1].split(/\n\s*(Subjects|Comments|Journal reference|Cite as|Submission history|DOI|Report number)\s*:/i)[0];
  } else if (isArxivAbs && (ARXIV_CHROME.test(t) || /Announce Type:|Subjects:|Title:\s/i.test(t))) {
    return ""; // 宁可不显示，也不显示页面样板
  }
  return t
    .replace(/^[\s#>*\-–—"'“”]+/, "")
    .replace(/\s*#\s*/g, " ")
    .replace(/\bTitle:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function yearIn(text: string): string {
  const now = new Date().getFullYear();
  const years = (text.match(/\b(19[89]\d|20[0-4]\d)\b/g) || []).map((y) => parseInt(y, 10)).filter((y) => y <= now);
  return years.length ? String(Math.max(...years)) : "";
}

function pdfUrlOf(url: string, arxivId: string): string {
  if (arxivId) { return `https://arxiv.org/pdf/${arxivId}`; }
  return /\.pdf($|\?)/i.test(url) ? url : "";
}

// 同一个网页的不同入口（utm/锚点/大小写）要合并
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    const keep = [...u.searchParams.entries()].filter(([k]) => !/^utm_|^ref$|^source$/.test(k));
    u.search = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return (u.pathname.replace(/\/$/, "") + u.search).toLowerCase() + "@" + u.hostname;
  } catch {
    return url.toLowerCase();
  }
}

async function tavilySearch(
  key: string,
  body: Record<string, unknown>
): Promise<{ results: TavilyResult[]; credits: number } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = (() => {
        try { return String((JSON.parse(text) as any)?.detail?.error || ""); } catch { return text.slice(0, 200); }
      })();
      const hint = res.status === 401 ? "API Key 无效"
        : res.status === 432 || res.status === 433 ? "套餐额度已用尽"
          : res.status === 429 ? "请求过于频繁（稍后重试）"
            : `HTTP ${res.status}`;
      return { error: `${hint}${detail ? "：" + detail : ""}` };
    }
    const json = (await res.json()) as { results?: TavilyResult[]; usage?: { credits?: number } };
    return { results: json.results || [], credits: Number(json.usage?.credits || 0) };
  } catch (e) {
    return { error: logger.errText(e) };
  } finally {
    clearTimeout(timer);
  }
}

function toHit(r: TavilyResult): PaperHit | null {
  const url = String(r.url || "").trim();
  const title = cleanTitle(String(r.title || ""));
  if (!url || !title) { return null; }
  const host = hostOf(url);
  const raw = String(r.content || "");
  const snippet = tidySnippet(raw, /arxiv\.org\/abs\//i.test(url));
  const arxivId = arxivIdIn(url) || arxivIdIn(raw);
  const doi = doiIn(url);
  const published = r.published_date ? String(r.published_date) : "";
  const date = /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : "";
  return {
    key: doi ? "doi:" + doi.toLowerCase() : (arxivId ? "ax:" + arxivId : "url:" + urlKey(url)),
    source: host,
    title,
    authors: "",
    year: date.slice(0, 4) || yearIn(title) || yearIn(snippet),
    date,
    venue: siteName(host),
    url,
    pdfUrl: pdfUrlOf(url, arxivId),
    arxivId,
    doi,
    citations: 0,
    abstract: snippet
  };
}

function merge(list: PaperHit[]): PaperHit[] {
  const byUrl = new Map<string, PaperHit>();
  const byId = new Map<string, PaperHit>();
  for (const p of list) {
    const id = p.arxivId ? "ax:" + p.arxivId : (p.doi ? "doi:" + p.doi.toLowerCase() : "");
    const uk = urlKey(p.url);
    const existing = (id && byId.get(id)) || byUrl.get(uk);
    if (!existing) {
      byUrl.set(uk, p);
      if (id) { byId.set(id, p); }
      continue;
    }
    // 同一个条目：保留信息更全的一份，但补上缺失的编号
    const keep = existing.abstract.length >= p.abstract.length ? existing : p;
    keep.arxivId = existing.arxivId || p.arxivId;
    keep.doi = existing.doi || p.doi;
    keep.pdfUrl = existing.pdfUrl || p.pdfUrl;
    keep.venue = existing.venue || p.venue;
    keep.year = existing.year || p.year;
    keep.date = existing.date || p.date;
    byUrl.set(uk, keep);
    if (id) { byId.set(id, keep); }
  }
  return Array.from(new Set(byUrl.values()));
}

export async function searchWeb(o: WebSearchOptions, apiKey: string): Promise<PaperHit[]> {
  const queries = Array.from(new Set((o.queries || []).map((q) => String(q || "").trim()).filter(Boolean))).slice(0, MAX_QUERIES);
  if (!queries.length) { return []; }
  const scope = o.scope === "web" ? "web" : "academic";
  const maxResults = Math.max(1, Math.min(20, Number(o.maxResults) || 8));
  const started = Date.now();
  const results = await Promise.allSettled(queries.map((q) => tavilySearch(apiKey, {
    query: q,
    search_depth: "basic",
    max_results: maxResults,
    topic: "general",
    include_usage: true,
    include_published_date: true,
    ...(scope === "academic"
      ? { include_domains: ACADEMIC_DOMAINS, include_domains_mode: o.mode === "restrict" ? "restrict" : "prefer" }
      : {}),
    ...(o.timeRange ? { time_range: o.timeRange } : {})
  })));
  const flat: PaperHit[] = [];
  let credits = 0;
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if ("error" in r.value) {
        errors.push(r.value.error);
        logger.warn("websearch", `查询失败「${queries[i].slice(0, 60)}」：${r.value.error}`);
        return;
      }
      credits += r.value.credits;
      const hits = r.value.results.map(toHit).filter((x): x is PaperHit => !!x);
      logger.info("websearch", `「${queries[i].slice(0, 60)}」→ ${hits.length} 条`);
      flat.push(...hits);
    } else {
      errors.push(logger.errText(r.reason));
    }
  });
  const merged = merge(flat)
    .sort((a, b) => {
      // 1) 学术域名优先 2) 可导入（有 arXiv/DOI）优先 3) 新→旧
      const tier = (p: PaperHit): number => (siteName(p.source) ? 1 : 0) + (p.arxivId || p.doi ? 1 : 0);
      const t = tier(b) - tier(a);
      if (t !== 0) { return t; }
      return (b.year || "0").localeCompare(a.year || "0");
    });
  logger.info("websearch", `合计 ${merged.length} 条，用量 ${credits} credits，耗时 ${Date.now() - started}ms` +
    (errors.length ? `，失败 ${errors.length} 个查询` : ""));
  if (!merged.length && errors.length) {
    throw new Error(errors[0]);
  }
  return merged;
}

function clip(s: string, n: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 给模型看的紧凑列表（卡片会单独渲染给用户）
export function resultsForModel(list: PaperHit[], credits = 0): string {
  if (!list.length) {
    return "（没有检索到结果：可换更具体的英文检索式（加会议名 / site: 限定 / 领域词），或放宽时间范围；" +
      "不要用同一条查询反复重试。）";
  }
  const head = `共 ${list.length} 条（已作为卡片展示给用户，可用卡片上的「导入到文库」入库；引用它们请写 [[card:N]]，N 就是下面的编号）。\n\n`;
  return head + list.map((p, i) => {
    const ids = [p.arxivId ? `arXiv:${p.arxivId}` : "", p.doi ? `doi:${p.doi}` : ""].filter(Boolean).join(" ");
    const site = p.venue && p.venue !== p.source ? `${p.venue}（${p.source}）` : p.source;
    return `${p.idx ?? i + 1}. ${p.title}\n   ${site}${p.year ? ` · ${p.year}` : ""}${ids ? ` · ${ids}` : ""}\n   ${clip(p.abstract, 260)}\n   ${p.url}`;
  }).join("\n\n");
}
