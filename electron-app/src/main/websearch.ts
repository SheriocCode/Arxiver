import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaperHit } from "../shared/types";
import * as logger from "./logger";
import { engineDir, pythonExe } from "./paths";
import { tokenize } from "./agent/text";

const execFileAsync = promisify(execFile);

// 联网搜索：可选服务商（Tavily / 博查），两家都归一化成 RawHit 再走同一套清洗、去重、排序。
// 不再调用 arXiv 的查询接口；论文类结果靠"受控查询 + 学术域名偏好"拿到，
// 再按 URL 里的 arXiv 编号 / DOI 决定能不能一键导入。
// 关键词与查询式必须是英文（由模型负责改写，见 agent 的系统提示词）。

const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";
const BOCHA_SEARCH = "https://api.bochaai.com/v1/web-search";
const DEEPSEEK_SEARCH = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH = "https://api.deepseek.com/v1/tools/fetch";
const TIMEOUT = 20000;
const UA = "Arxiver/0.8 (+https://github.com/SheriocCode/Arxiver)";
const MAX_QUERIES = 4;

export type SearchProvider = "tavily" | "bocha" | "deepseek";

export const PROVIDER_NAMES: Record<SearchProvider, string> = { tavily: "Tavily", bocha: "博查", deepseek: "DeepSeek" };

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
  provider?: SearchProvider;
}

// 各家服务商归一化后的原始结果
interface RawHit {
  title: string;
  url: string;
  content: string;
  date: string;
  site?: string;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string | null;
}

// DeepSeek（/v1/tools/search）的返回结构
interface DeepSeekItem {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  site_name?: string | null;
  date?: string | null;
  rerank_score?: number;
}

// 博查（Web Search API）的返回结构
interface BochaItem {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
  dateLastCrawled?: string;
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

// 博查的标题常带站点后缀（如 "[2509.15459] CAGE: … – arxiv"）
function cleanBochaTitle(t: string): string {
  return cleanTitle(t).replace(/\s*[-–—|]\s*(arxiv(\.org)?|researchgate|semanticscholar)\s*$/i, "").trim();
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

function httpHint(status: number, detail: string): string {
  const hint = status === 401 || status === 403 ? "API Key 无效或没有权限"
    : status === 402 ? "账户余额不足"
      : status === 432 || status === 433 ? "套餐额度已用尽"
        : status === 429 ? "请求过于频繁（稍后重试）"
          : `HTTP ${status}`;
  return `${hint}${detail ? "：" + detail : ""}`;
}

async function tavilySearch(
  key: string,
  body: Record<string, unknown>
): Promise<{ hits: RawHit[]; credits: number } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(TAVILY_SEARCH, {
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
      return { error: httpHint(res.status, detail) };
    }
    const json = (await res.json()) as { results?: TavilyResult[]; usage?: { credits?: number } };
    return {
      hits: (json.results || []).map((r) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        content: String(r.content || ""),
        date: String(r.published_date || "")
      })),
      credits: Number(json.usage?.credits || 0)
    };
  } catch (e) {
    return { error: logger.errText(e) };
  } finally {
    clearTimeout(timer);
  }
}

const BOCHA_FRESHNESS: Record<string, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

// 博查：一次一条 query；summary=true 拿长摘要（比 snippet 完整）；没有 include_domains，学术权重靠本地排序
async function bochaSearch(
  key: string,
  query: string,
  o: { count: number; timeRange?: WebSearchOptions["timeRange"] }
): Promise<{ hits: RawHit[]; credits: number } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(BOCHA_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        query,
        summary: true,
        count: o.count,
        freshness: o.timeRange ? BOCHA_FRESHNESS[o.timeRange] : "noLimit"
      }),
      signal: ctrl.signal
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) { return { error: httpHint(res.status, text.slice(0, 200)) }; }
    const json = JSON.parse(text) as { code?: number; msg?: string; data?: { webPages?: { value?: BochaItem[] } } };
    if (json.code !== undefined && json.code !== 200) {
      return { error: `博查返回 ${json.code}${json.msg ? "：" + json.msg : ""}` };
    }
    const items = json.data?.webPages?.value || [];
    return {
      hits: items.filter((x) => x.url).map((x) => ({
        title: cleanBochaTitle(String(x.name || "")),
        url: String(x.url || ""),
        content: String(x.summary || x.snippet || ""),
        date: String(x.datePublished || x.dateLastCrawled || "")
      })),
      credits: 0
    };
  } catch (e) {
    return { error: logger.errText(e) };
  } finally {
    clearTimeout(timer);
  }
}

const DEEPSEEK_QUERY_MAX = 128;

// DeepSeek 的 query 限 1~128 字符，超了直接 400：按预算截断（宁可少一点限定，也别整条失败）
function clipDeepSeekQuery(q: string, max = DEEPSEEK_QUERY_MAX): string {
  const t = String(q || "").trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

// time_range → after:YYYY-MM-DD（DeepSeek 支持精确到日的日期限定）
function deepSeekTimeFilter(tr?: WebSearchOptions["timeRange"]): string {
  const days = tr === "day" ? 1 : tr === "week" ? 7 : tr === "month" ? 30 : tr === "year" ? 365 : 0;
  if (!days) { return ""; }
  return "after:" + new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// DeepSeek 搜索：一次一条 query；summary（600~800 字）比 snippet 更适合给模型读，
// 正文留给 fetch，所以 need_content 固定 false。按请求计费，不返回 credits。
async function deepseekSearch(
  key: string,
  query: string,
  o: { count: number; timeRange?: WebSearchOptions["timeRange"] }
): Promise<{ hits: RawHit[]; credits: number } | { error: string }> {
  const filter = deepSeekTimeFilter(o.timeRange);
  const body = JSON.stringify({
    query: filter ? clipDeepSeekQuery(query, DEEPSEEK_QUERY_MAX - filter.length - 1) + " " + filter : clipDeepSeekQuery(query),
    count: o.count,
    need_content: false
  });
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(DEEPSEEK_SEARCH, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body,
        signal: ctrl.signal
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const detail = (() => {
          try { return String((JSON.parse(text) as any)?.error?.message || ""); } catch { return text.slice(0, 200); }
        })();
        // 408 / 429 / 5xx 值得等一等再试一次（文档建议）
        if (attempt === 0 && (res.status === 408 || res.status === 429 || res.status >= 500)) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        return { error: httpHint(res.status, detail) };
      }
      const json = JSON.parse(text) as { results?: DeepSeekItem[] };
      return {
        hits: (json.results || []).filter((x) => x.url).map((x) => ({
          title: String(x.title || ""),
          url: String(x.url || ""),
          content: String(x.summary || x.snippet || ""),
          date: String(x.date || ""),
          site: String(x.site_name || "")
        })),
        credits: 0
      };
    } catch (e) {
      return { error: logger.errText(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface OneQueryOpts {
  scope: "academic" | "web";
  mode: "prefer" | "restrict";
  timeRange?: WebSearchOptions["timeRange"];
  maxResults: number;
}

function searchOne(
  provider: SearchProvider, key: string, query: string, o: OneQueryOpts
): Promise<{ hits: RawHit[]; credits: number } | { error: string }> {
  if (provider === "bocha") {
    return bochaSearch(key, query, { count: o.maxResults, timeRange: o.timeRange });
  }
  if (provider === "deepseek") {
    return deepseekSearch(key, query, { count: o.maxResults, timeRange: o.timeRange });
  }
  return tavilySearch(key, {
    query,
    search_depth: "basic",
    max_results: o.maxResults,
    topic: "general",
    include_usage: true,
    include_published_date: true,
    ...(o.scope === "academic"
      ? { include_domains: ACADEMIC_DOMAINS, include_domains_mode: o.mode === "restrict" ? "restrict" : "prefer" }
      : {}),
    ...(o.timeRange ? { time_range: o.timeRange } : {})
  });
}

function toHit(r: RawHit): PaperHit | null {
  const url = String(r.url || "").trim();
  const title = cleanTitle(String(r.title || ""));
  if (!url || !title) { return null; }
  const host = hostOf(url);
  const raw = String(r.content || "");
  const snippet = tidySnippet(raw, /arxiv\.org\/abs\//i.test(url));
  const arxivId = arxivIdIn(url) || arxivIdIn(raw);
  const doi = doiIn(url);
  const published = String(r.date || "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : "";
  return {
    key: doi ? "doi:" + doi.toLowerCase() : (arxivId ? "ax:" + arxivId : "url:" + urlKey(url)),
    source: host,
    title,
    authors: "",
    year: date.slice(0, 4) || yearIn(title) || yearIn(snippet),
    date,
    venue: siteName(host) || String(r.site || ""),
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

// 并发上限：DeepSeek 的 Search 是账号级 5 QPS，四条查询全并发正好踩线（用户连点两次就 429），限到 2
async function settleLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) { return; }
      try { out[i] = { status: "fulfilled", value: await tasks[i]() }; }
      catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return out;
}

export async function searchWeb(o: WebSearchOptions, apiKey: string): Promise<PaperHit[]> {
  const queries = Array.from(new Set((o.queries || []).map((q) => String(q || "").trim()).filter(Boolean))).slice(0, MAX_QUERIES);
  if (!queries.length) { return []; }
  const provider: SearchProvider = o.provider === "bocha" ? "bocha" : o.provider === "deepseek" ? "deepseek" : "tavily";
  const scope = o.scope === "web" ? "web" : "academic";
  const mode = o.mode === "restrict" ? "restrict" : "prefer";
  const maxResults = Math.max(1, Math.min(20, Number(o.maxResults) || 8));
  const started = Date.now();
  const results = await settleLimited(
    queries.map((q) => () => searchOne(provider, apiKey, q, { scope, mode, timeRange: o.timeRange, maxResults })),
    provider === "deepseek" ? 2 : queries.length
  );
  const flat: PaperHit[] = [];
  let credits = 0;
  let billed = 0;
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if ("error" in r.value) {
        errors.push(r.value.error);
        logger.warn("websearch", `查询失败「${queries[i].slice(0, 60)}」：${r.value.error}`);
        return;
      }
      credits += r.value.credits;
      const hits = r.value.hits.map(toHit).filter((x): x is PaperHit => !!x);
      if (hits.length) { billed += 1; }
      logger.info("websearch", `「${queries[i].slice(0, 60)}」→ ${hits.length} 条`);
      flat.push(...hits);
    } else {
      errors.push(logger.errText(r.reason));
    }
  });
  // 博查 / DeepSeek 没有域名限制参数：学术 + restrict 时用本地白名单兜住（Tavily 端已过滤，这里是等价操作）
  const pool = scope === "academic" && mode === "restrict"
    ? flat.filter((p) => ACADEMIC_DOMAINS.some((d) => p.source === d || p.source.endsWith("." + d)))
    : flat;
  const merged = merge(pool)
    .sort((a, b) => {
      // 1) 学术域名优先 2) 可导入（有 arXiv/DOI）优先 3) 新→旧
      const tier = (p: PaperHit): number => (siteName(p.source) ? 1 : 0) + (p.arxivId || p.doi ? 1 : 0);
      const t = tier(b) - tier(a);
      if (t !== 0) { return t; }
      return (b.year || "0").localeCompare(a.year || "0");
    });
  // Tavily 按 credits 计费，博查 / DeepSeek 按请求次数计费（无结果不计费）
  const usage = provider === "tavily" ? `${credits} credits` : `${billed} 次请求`;
  logger.info("websearch", `${PROVIDER_NAMES[provider]} 合计 ${merged.length} 条，用量 ${usage}，耗时 ${Date.now() - started}ms` +
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

// ---- 读正文（fetch_url）----
// 优先 Tavily extract（带 query 让服务端挑相关段落，1 credit / 5 个 URL）；
// 取不到（没配 Tavily Key / 该 URL 失败）再自己抓，自己抓时做 SSRF 防护并本地挑段落。
// 博查没有 extract 接口，所以读正文固定用 Tavily 的 Key（有没有配都行，没配就本地抓）。

export interface PageContent {
  url: string;
  title: string;
  domain: string;
  text: string;
  via: string;
}

const MAX_BYTES = 3 * 1024 * 1024;
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.)/;
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) { return true; }
  if (PRIVATE_V4.test(h) || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) { return true; }
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("不是合法的网址"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") { throw new Error("只允许 http / https 链接"); }
  if (isPrivateHost(u.hostname)) { throw new Error("不允许访问内网 / 本机地址"); }
  // DNS 解析后再确认一次（防内网域名 / 重绑定）
  try {
    const dns = await import("node:dns/promises");
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivateHost(a.address))) { throw new Error("不允许访问内网 / 本机地址"); }
  } catch (e) {
    if (e instanceof Error && e.message.includes("不允许")) { throw e; }
    /* 解析失败就让 fetch 去报错 */
  }
  return u;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleOf(html: string, url: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? htmlToText(t).slice(0, 200) : hostOf(url);
}

async function pdfToText(bytes: Buffer, name: string): Promise<string> {
  const file = path.join(os.tmpdir(), `arxiver-fetch-${Date.now()}.pdf`);
  fs.writeFileSync(file, bytes);
  try {
    const { stdout } = await execFileAsync(pythonExe(), [path.join(engineDir(), "extract_text.py"), file], {
      cwd: engineDir(),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    const pages = JSON.parse(stdout) as { text?: string }[];
    return pages.map((p) => p.text || "").join("\n\n");
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

// 自己抓：手动跟随跳转并逐跳校验，限体积 3MB
async function fetchPageText(raw: string): Promise<{ title: string; text: string; finalUrl: string }> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*" }, redirect: "manual", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) { throw new Error(`HTTP ${res.status}（没有跳转地址）`); }
      url = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) { throw new Error("页面太大，已放弃读取"); }
    const finalUrl = res.url || u.toString();
    if (type.includes("application/pdf")) {
      return { title: hostOf(finalUrl), text: await pdfToText(buf, "fetched.pdf"), finalUrl };
    }
    const body = buf.toString("utf8");
    if (type.includes("html") || /<html|<!doctype/i.test(body.slice(0, 800))) {
      return { title: titleOf(body, finalUrl), text: htmlToText(body), finalUrl };
    }
    return { title: hostOf(finalUrl), text: body.trim(), finalUrl };
  }
  throw new Error("跳转次数过多");
}

// 本地挑段落：把正文按空行切块，按与 query 的词重合度打分，拼到预算为止
function pickPassages(text: string, query: string, budget: number): string {
  const clean = String(text || "").replace(/\r/g, "").trim();
  if (!clean) { return ""; }
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40);
  const terms = tokenize(query || "");
  if (!paras.length) { return clean.slice(0, budget); }
  if (!terms.length) { return paras.join("\n\n").slice(0, budget); }
  const scored = paras.map((p, i) => {
    const set = new Set(tokenize(p));
    let hit = 0;
    for (const t of new Set(terms)) { if (set.has(t)) { hit += 1; } }
    // 轻微偏好靠前的段落
    return { p, i, score: hit / Math.max(1, new Set(terms).size) + (i < 3 ? 0.15 : 0) };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
  const out: string[] = [];
  let used = 0;
  for (const s of scored) {
    if (s.score <= 0.15 && out.length) { break; }
    if (used + s.p.length > budget) { continue; }
    out.push(s.p);
    used += s.p.length;
    if (used > budget * 0.9 || out.length >= 6) { break; }
  }
  return (out.length ? out : [paras[0]]).join("\n\n---\n\n");
}

async function tavilyExtract(url: string, query: string, apiKey: string): Promise<{ text: string; credits: number } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(TAVILY_EXTRACT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        urls: url,
        ...(query ? { query, chunks_per_source: 4 } : {}),
        extract_depth: "basic",
        format: "text",
        include_usage: true,
        timeout: 25
      }),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) { return { error: `Tavily extract HTTP ${res.status}：${text.slice(0, 160)}` }; }
    const json = JSON.parse(text) as { results?: { url: string; raw_content?: string }[]; failed_results?: { error?: string }[]; usage?: { credits?: number } };
    const first = (json.results || [])[0];
    if (!first || !first.raw_content) {
      return { error: String(json.failed_results?.[0]?.error || "Tavily 没取到内容") };
    }
    return { text: first.raw_content, credits: Number(json.usage?.credits || 0) };
  } catch (e) {
    return { error: logger.errText(e) };
  } finally {
    clearTimeout(timer);
  }
}

// DeepSeek Fetch：直接返回 Markdown 正文，当 Tavily extract 取不到时的兜底（按请求计费）
async function deepseekFetch(url: string, apiKey: string): Promise<{ text: string; title: string } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(DEEPSEEK_FETCH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ url }),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = (() => {
        try { return String((JSON.parse(text) as any)?.error?.message || ""); } catch { return text.slice(0, 160); }
      })();
      return { error: httpHint(res.status, detail) };
    }
    const json = JSON.parse(text) as { title?: string; content?: string };
    const content = String(json.content || "").trim();
    if (!content) { return { error: "DeepSeek Fetch 没取到正文" }; }
    return { text: content, title: String(json.title || "") };
  } catch (e) {
    return { error: logger.errText(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function readPage(url: string, opts: { query?: string; tavilyKey?: string; deepseekKey?: string; maxChars?: number } = {}): Promise<PageContent> {
  const budget = Math.max(2000, Math.min(20000, Number(opts.maxChars) || 8000));
  const query = String(opts.query || "").trim();
  const tavilyKey = String(opts.tavilyKey || "");
  const deepseekKey = String(opts.deepseekKey || "");
  const started = Date.now();
  let text = "";
  let title = "";
  let via = "";
  let finalUrl = url;
  if (tavilyKey) {
    const r = await tavilyExtract(url, query, tavilyKey);
    if ("text" in r) {
      text = r.text;
      via = `Tavily extract${r.credits ? `（${r.credits} credits）` : ""}`;
    } else {
      logger.warn("websearch", `Tavily extract 失败，改用直接抓取：${r.error}`);
    }
  }
  // DeepSeek Fetch 兜底：先做一次内网地址检查，别把 localhost / 内网 URL 发给服务商
  if (!text && deepseekKey && (await assertPublicUrl(url).then(() => true, () => false))) {
    const r = await deepseekFetch(url, deepseekKey);
    if ("text" in r) {
      text = pickPassages(r.text, query, budget) || r.text.slice(0, budget);
      title = r.title;
      via = "DeepSeek Fetch";
    } else {
      logger.warn("websearch", `DeepSeek Fetch 失败，改用直接抓取：${r.error}`);
    }
  }
  if (!text) {
    const r = await fetchPageText(url);
    title = r.title;
    finalUrl = r.finalUrl;
    text = pickPassages(r.text, query, budget);
    via = "直接抓取";
  } else if (via.startsWith("Tavily")) {
    // Tavily 已按 query 重排过，这里只做长度与格式收敛
    text = text.replace(/\s*\n\s*/g, "\n").trim().slice(0, budget);
    title = hostOf(finalUrl);
  }
  if (!title) { title = hostOf(finalUrl); }
  logger.info("websearch", `读取 ${hostOf(finalUrl)}（${via}，${text.length} 字，${Date.now() - started}ms）`);
  return { url: finalUrl, title, domain: hostOf(finalUrl), text, via };
}
