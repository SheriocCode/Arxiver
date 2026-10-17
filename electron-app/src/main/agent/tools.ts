import * as library from "../library";
import * as text from "./text";
import * as websearch from "../websearch";
import { importPaper } from "../importPaper";
import { get as getConfig, searchKey, searchProvider, readKeys } from "../config";
import type { ToolDef } from "./model";
import type { PaperHit, PageRead } from "../../shared/types";

export interface ToolImpl {
  def: ToolDef;
  write?: boolean;
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}

// 工具可以把结构化结果额外推给界面（如检索到的论文卡片），并把本轮已发出卡片的编号传进来
export interface ToolContext {
  emit?: (event: { type: "papers"; papers: PaperHit[] } | { type: "read"; read: PageRead }) => void;
  cardBase?: number;
  // 长耗时工具（如 import_paper）用它在界面上报进度，避免看起来像卡死
  progress?: (text: string) => void;
}

// 「联网搜索」总开关（读正文只需开关，不必有 Search Key）/ 有当前服务商的 Key 才可用搜索
export function webEnabled(): boolean {
  return !!getConfig().search_enabled;
}
export function webSearchEnabled(): boolean {
  const c = getConfig();
  return !!(c.search_enabled && searchKey(c));
}
// 三态：开关关闭 / 已开启但当前服务商没有 Key / 可用。给模型看，避免它把「缺 Key」说成「没开启」
export function webSearchState(): { on: boolean; key: boolean; provider: string } {
  const c = getConfig();
  return { on: !!c.search_enabled, key: !!searchKey(c), provider: websearch.PROVIDER_NAMES[searchProvider(c)] };
}
function webProvider(): websearch.SearchProvider {
  return searchProvider(getConfig());
}
function webScope(): "academic" | "web" {
  return getConfig().search_scope === "web" ? "web" : "academic";
}

interface DocMeta { id: string; title: string; year: string; authors: string }

function aliveDocs(): DocMeta[] {
  return library.list().documents
    .filter((d) => !d.trash)
    .map((d) => ({ id: d.id, title: d.title || "未命名", year: d.year || "", authors: d.authors || "" }));
}

function findDoc(id: string): DocMeta | undefined {
  return aliveDocs().find((d) => d.id === id);
}

// 分类支持按名称或 id 指定（模型通常只知道名字）
function findCollection(nameOrId: string): { id: string; name: string } | undefined {
  const s = String(nameOrId || "").trim();
  if (!s) { return undefined; }
  const cols = library.list().collections;
  return cols.find((c) => c.id === s) || cols.find((c) => c.name === s);
}

// 名称对不上时，别让用户自己去核对：把最接近的候选直接列出来
function nearCollections(nameOrId: string): string {
  const s = String(nameOrId || "").trim();
  const cols = library.list().collections;
  if (!cols.length) { return `（当前没有任何分类）`; }
  const lower = s.toLowerCase();
  const scored = cols.map((c) => {
    const n = c.name.toLowerCase();
    let score = 0;
    if (n.includes(lower) || lower.includes(n)) { score = 2; }
    else {
      // 共同字符比例（对 123124 vs 124124 这类只差一位的名字很有效）
      const set = new Set(n);
      const common = Array.from(new Set(lower)).filter((ch) => set.has(ch)).length;
      score = common / Math.max(1, Math.max(set.size, new Set(lower).size));
    }
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).filter((x) => x.score > 0.4).map((x) => `「${x.c.name}」(id: ${x.c.id})`);
  const all = cols.map((c) => `「${c.name}」`).join("、");
  return `没找到分类「${s}」。${top.length ? `最接近的是 ${top.join("、")}，是它吗？` : ""}现有分类：${all}。` +
    `请不要让用户自己去核对拼写——上面就是全部候选，直接问用户确认要操作哪一个。`;
}

function nearTags(name: string): string {
  const tags = library.list().tag_names || [];
  const s = String(name || "").trim().toLowerCase();
  const near = tags.filter((t) => t.toLowerCase().includes(s) || s.includes(t.toLowerCase())).slice(0, 5);
  return near.length ? `（相近的标签：${near.map((t) => `「${t}」`).join("、")}）` : "";
}

export const TOOLS: ToolImpl[] = [
  {
    def: {
      name: "search_web",
      description: "联网搜索（Tavily / 博查 / DeepSeek，在设置里选服务商），用于查找本地文库之外的最新论文、会议论文、项目主页、代码或任意资料。" +
        "结果以卡片展示给用户（标题/站点/年份/摘要片段/链接），可直接导入文库（有 arXiv 编号或 DOI 的条目）。" +
        "检索式要求：**一律用英文**；不要直接把用户的中文原句丢进来，先改写成 1~4 条**受控检索式**——" +
        "带领域词（如 computer vision / diffusion model）、带会议或年份锚点（如 NeurIPS 2025、CVPR 2024）、必要时加 site: 限定（site:arxiv.org、site:openreview.net）。" +
        "**每条检索式控制在 60 字符以内**（部分服务商限 128 字符，太长会被截断丢掉限定词）。" +
        "用户只要一个模糊主题时，用 queries 一次传多条扇出（同一主题的不同说法/不同限定），不要只搜一次。" +
        "本工具的结果来自互联网、不在本地文库，引用时给出链接，不要用 [[cite:…]]。",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description: "1~4 条英文检索式（推荐）；模糊主题时扇出多条。与 query 二选一。"
          },
          query: { type: "string", description: "单条英文检索式（简写；等价于 queries 只传一条）" },
          scope: { type: "string", enum: ["academic", "web"], description: "academic（默认）= 学术域名加权；web = 不限域名" },
          mode: { type: "string", enum: ["prefer", "restrict"], description: "academic 下：prefer（默认）加权不排他；restrict 只在学术域名内检索" },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "只看最近这段时间内发布的（“最新”类问题建议带 year 或 month）" },
          max_results: { type: "number", description: "每条检索式返回条数，默认 8，上限 20" }
        }
      }
    },
    async run(args, ctx) {
      const one = String(args.query || "").trim();
      const many = Array.isArray(args.queries) ? (args.queries as unknown[]).map((q) => String(q || "").trim()) : [];
      const queries = many.length ? many : (one ? [one] : []).filter(Boolean);
      if (!queries.length) { return "必须提供 queries（或 query）"; }
      if (queries.some((q) => /[\u4e00-\u9fff]/.test(q))) {
        return "检索式必须是英文：请先把中文需求改写成 1~4 条英文受控检索式（可加会议名/年份/site: 限定）再调用本工具。";
      }
      const scope = args.scope === "web" || args.scope === "academic" ? args.scope : webScope();
      const timeRange = ["day", "week", "month", "year"].includes(String(args.time_range))
        ? (String(args.time_range) as websearch.WebSearchOptions["timeRange"])
        : undefined;
      const hits = await websearch.searchWeb({
        queries,
        scope,
        mode: args.mode === "restrict" ? "restrict" : "prefer",
        timeRange,
        maxResults: Number(args.max_results) || 8,
        provider: webProvider()
      }, searchKey(getConfig()));
      // 卡片在本轮对话里的全局编号（跨多次检索连续），模型据此用 [[card:N]] 引用
      const base = Number(ctx?.cardBase) || 0;
      hits.forEach((p, i) => { p.idx = base + i + 1; });
      ctx?.emit?.({ type: "papers", papers: hits });
      if (!hits.length) { return websearch.resultsForModel([]); }
      return websearch.resultsForModel(hits) +
        "\n\n回答时：挑出真正相关的几条并说明为什么相关，给出链接；不要逐条复述摘要。" +
        "指代这些结果时**一律用 [[card:N]]**（如 [[card:13]]，会渲染成可点击的卡片引用），不要写 [[N]]、" +
        "不要写「卡片13」这种纯文本，也不要只给链接让用户自己找。" +
        "若结果偏向旧论文或无关站点，说明这一点并用更具体的检索式（加会议名 / site: 限定）再查一次。";
    }
  },
  {
    def: {
      name: "fetch_url",
      description: "读取一个网页或 PDF 的**正文**（优先服务端抽取，取不到就自己抓），用来深入了解某篇论文的方法/实验/结论，" +
        "或者读用户给出的链接。返回与 query 最相关的若干段落。" +
        "用法：在 search_web 找到候选后，挑最相关的 1~3 个（优先 arXiv abs/PDF、OpenReview、会议 proceedings 页）读进来再回答；" +
        "**不要凭搜索片段臆断具体数字、方法细节**。每轮最多读 3 个页面，读不动的链接就如实说明。" +
        "引用读到的内容时给出链接，不要用 [[cite:…]]。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读的网址（http/https；PDF 链接也行）" },
          query: { type: "string", description: "可选：你想从这一页了解什么（英文或中文皆可），用于挑出最相关的段落" },
          max_chars: { type: "number", description: "可选：返回文本上限，默认 8000 字" }
        },
        required: ["url"]
      }
    },
    async run(args, ctx) {
      const url = String(args.url || "").trim();
      if (!url) { return "url 不能为空"; }
      ctx?.progress?.("正在读取页面…");
      const keys = readKeys(getConfig());
      const page = await websearch.readPage(url, {
        query: String(args.query || "").trim(),
        tavilyKey: keys.tavily,
        deepseekKey: keys.deepseek,
        maxChars: Number(args.max_chars) || 8000
      });
      ctx?.emit?.({
        type: "read",
        read: { url: page.url, title: page.title, domain: page.domain, chars: page.text.length, via: page.via }
      });
      if (!page.text) {
        return `已打开 ${page.url}，但没有取到可用正文（可能是动态页面或需要登录）。可以换个链接（如 arXiv abs 页 / PDF）再试。`;
      }
      return `【已读取】${page.title}\n来源：${page.url}（${page.via}，正文约 ${page.text.length} 字）\n\n${page.text}`;
    }
  },
  {
    def: {
      name: "list_library",
      description: "列出文库中的文献（可选按关键词过滤标题/作者）。返回 id、标题、年份、作者、分类与标签。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "可选，用于过滤的关键词" },
          limit: { type: "number", description: "最多返回条数，默认 30" }
        }
      }
    },
    async run(args) {
      const q = String(args.query || "").toLowerCase();
      const limit = Number(args.limit) || 30;
      const cols = library.list().collections;
      const colName = (id: string): string => cols.find((c) => c.id === id)?.name || "";
      let docs = aliveDocs();
      if (q) { docs = docs.filter((d) => (d.title + " " + d.authors).toLowerCase().includes(q)); }
      const lines = docs.slice(0, limit).map((d) => {
        const doc = library.getDocument(d.id);
        const c = (doc?.collections || []).map(colName).filter(Boolean);
        const t = doc?.tags || [];
        return `${d.id} | ${d.title} | ${d.year} | ${d.authors}` +
          `${c.length ? ` | 分类: ${c.join("、")}` : ""}${t.length ? ` | 标签: ${t.join("、")}` : ""}`;
      });
      return lines.length ? lines.join("\n") : "（文库为空或没有匹配的文献）";
    }
  },
  {
    def: {
      name: "list_collections",
      description: "列出文库的所有分类（含 id、名称、父分类、文献数）。用户提到的分类名对不上时，先用它查清楚再纠正/确认。",
      parameters: { type: "object", properties: {} }
    },
    async run() {
      const state = library.list();
      const cols = state.collections;
      if (!cols.length) { return "（还没有任何分类）"; }
      const count = (id: string): number => state.documents.filter((d) => !d.trash && (d.collections || []).includes(id)).length;
      const lines = cols.map((c) => {
        const parent = c.parent ? (cols.find((x) => x.id === c.parent)?.name || c.parent) : "";
        return `- ${c.name}（id: ${c.id}${parent ? `，父分类: ${parent}` : ""}，${count(c.id)} 篇）`;
      });
      return `共 ${cols.length} 个分类：\n${lines.join("\n")}`;
    }
  },
  {
    def: {
      name: "search_library",
      description: "在整本文库中检索与问题最相关的段落（跨文献）。返回带引用标记的段落，引用格式 [[cite:文献id#页码]]。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词或问题" },
          limit: { type: "number", description: "返回段落数，默认 8" }
        },
        required: ["query"]
      }
    },
    async run(args) {
      const query = String(args.query || "");
      const limit = Number(args.limit) || 8;
      const ids = aliveDocs().map((d) => d.id);
      const hits = await text.search(ids, query, limit);
      if (hits.length === 0) { return "（没有检索到相关段落，可尝试换用关键词或改用 list_library 浏览文档）"; }
      return hits.map((h) => {
        const doc = findDoc(h.docId);
        return `[[cite:${h.docId}#${h.page}]] 《${doc ? doc.title : h.docId}》第 ${h.page} 页\n${h.text}`;
      }).join("\n\n---\n\n");
    }
  },
  {
    def: {
      name: "read_document",
      description: "读取某篇文献的正文文本（可指定页码，如 \"1-3,5\"）。返回带页码标记的文本。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          pages: { type: "string", description: "可选，页码范围，如 1-3,5；省略则返回全部" }
        },
        required: ["docId"]
      }
    },
    async run(args) {
      const docId = String(args.docId || "");
      const doc = findDoc(docId);
      if (!doc) { return `（未找到文献 ${docId}）`; }
      const pages = text.pageRange(docId, await text.loadPages(docId), args.pages as string | undefined);
      if (pages.length === 0) { return `（《${doc.title}》没有可用文本，可能未入库或解析失败）`; }
      const body = pages.map((p) => `[第${p.page}页 [[cite:${docId}#${p.page}]]]\n${p.text}`).join("\n\n");
      return `文档 ${docId} 《${doc.title}》\n\n${body}`;
    }
  },
  {
    def: {
      name: "search_in_document",
      description: "在指定文献内检索相关段落。返回带引用标记的段落。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          query: { type: "string", description: "检索词或问题" },
          limit: { type: "number", description: "返回段落数，默认 8" }
        },
        required: ["docId", "query"]
      }
    },
    async run(args) {
      const docId = String(args.docId || "");
      const query = String(args.query || "");
      const limit = Number(args.limit) || 8;
      const hits = await text.search([docId], query, limit);
      if (hits.length === 0) { return "（未检索到相关段落）"; }
      return hits.map((h) => `[[cite:${docId}#${h.page}]] 第 ${h.page} 页\n${h.text}`).join("\n\n---\n\n");
    }
  },
  {
    write: true,
    def: {
      name: "update_metadata",
      description: "更新某篇文献的元数据（标题/作者/年份/期刊/DOI/摘要）。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          title: { type: "string" },
          authors: { type: "string" },
          year: { type: "string" },
          venue: { type: "string" },
          doi: { type: "string" },
          summary: { type: "string" }
        },
        required: ["docId"]
      }
    },
    async run(args) {
      const patch: Record<string, string> = {};
      for (const key of ["title", "authors", "year", "venue", "doi", "summary"]) {
        if (typeof args[key] === "string") { patch[key] = String(args[key]); }
      }
      const doc = library.updateDocument(String(args.docId || ""), patch);
      return doc ? `已更新《${doc.title}》的元数据` : "未找到该文献";
    }
  },
  {
    write: true,
    def: {
      name: "import_paper",
      description: "把一篇**外部论文**导入本地文库（会下载 PDF、补全标题/作者等元信息，耗时可能十几秒）。" +
        "用于用户说“把这篇下下来/存进文库/导入这篇”时——卡片上的链接、arXiv 编号、DOI、arXiv abs 页链接、PDF 直链都行。" +
        "属于写入操作，需用户批准。导入后返回新的文献 id，可接着用 apply_tags / add_to_collection 等继续处理。",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "arXiv 编号（如 2502.01866）或 DOI；与 url 二选一" },
          url: { type: "string", description: "论文链接（arXiv abs 页 / PDF 直链 / 会议页，会在页面里找 citation_pdf_url）" },
          collections: { type: "array", items: { type: "string" }, description: "可选：直接放入这些分类（分类不存在会新建）" }
        }
      }
    },
    async run(args, ctx) {
      const res = await importPaper({
        identifier: args.identifier ? String(args.identifier) : "",
        url: args.url ? String(args.url) : "",
        collections: Array.isArray(args.collections) ? (args.collections as unknown[]).map(String) : [],
        onProgress: (t) => ctx?.progress?.(t)
      });
      if (!res.ok || !res.doc) { return `导入失败：${res.error || "未知原因"}`; }
      const d = res.doc;
      return `已导入《${d.title}》\nid: ${d.id}\n作者：${d.authors || "—"} · 年份：${d.year || "—"} · 来源：${d.venue || "—"}` +
        `${d.doi ? `\nDOI: ${d.doi}` : ""}${d.sourceUrl ? `\n链接: ${d.sourceUrl}` : ""}`;
    }
  },
  {
    write: true,
    def: {
      name: "add_note",
      description: "给某篇文献追加一条笔记。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          text: { type: "string", description: "笔记内容" }
        },
        required: ["docId", "text"]
      }
    },
    async run(args) {
      const doc = library.getDocument(String(args.docId || ""));
      if (!doc) { return "未找到该文献"; }
      const text = String(args.text || "").trim();
      if (!text) { return "笔记内容不能为空"; }
      const note = { id: "n" + Date.now(), text, date: new Date().toISOString().slice(0, 10) };
      library.updateDocument(doc.id, { notes: [note, ...(doc.notes || [])] });
      return `已给《${doc.title}》加了一条笔记（现在共 ${(doc.notes || []).length + 1} 条）`;
    }
  },
  {
    write: true,
    def: {
      name: "delete_note",
      description: "删除某篇文献的笔记（按笔记 id 或按内容片段匹配；两者都给时以 id 为准）。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          noteId: { type: "string", description: "笔记 id（可先用 list_notes 或从上下文里取）" },
          textContains: { type: "string", description: "按内容片段匹配要删的那条" }
        },
        required: ["docId"]
      }
    },
    async run(args) {
      const doc = library.getDocument(String(args.docId || ""));
      if (!doc) { return "未找到该文献"; }
      const notes = doc.notes || [];
      const id = String(args.noteId || "").trim();
      const frag = String(args.textContains || "").trim();
      let target = id ? notes.find((n) => n.id === id) : undefined;
      if (!target && frag) { target = notes.find((n) => n.text.includes(frag)); }
      if (!target) { return `没找到要删的笔记。当前笔记：\n${notes.map((n) => `- [${n.id}] ${n.text.slice(0, 60)}`).join("\n") || "（无）"}`; }
      library.updateDocument(doc.id, { notes: notes.filter((n) => n.id !== target.id) });
      return `已删除《${doc.title}》的一条笔记：${target.text.slice(0, 60)}`;
    }
  },
  {
    write: true,
    def: {
      name: "rename_collection",
      description: "重命名某个分类（名称或 id 指定）。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "现有分类名（或 id）" },
          newName: { type: "string", description: "新名称" }
        },
        required: ["name", "newName"]
      }
    },
    async run(args) {
      const cur = findCollection(String(args.name || ""));
      if (!cur) { return nearCollections(String(args.name || "")); }
      const ok = library.renameCollection(cur.id, String(args.newName || "").trim());
      return ok ? `分类「${cur.name}」已重命名为「${args.newName}」` : "重命名失败（可能重名）";
    }
  },
  {
    write: true,
    def: {
      name: "delete_collection",
      description: "删除某个分类（名称或 id 指定；只删分类本身，里面的文献不会被删除）。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "要删除的分类名（或 id）" } },
        required: ["name"]
      }
    },
    async run(args) {
      const cur = findCollection(String(args.name || ""));
      if (!cur) { return nearCollections(String(args.name || "")); }
      const ok = library.removeCollection(cur.id);
      return ok ? `已删除分类「${cur.name}」` : "删除失败";
    }
  },
  {
    write: true,
    def: {
      name: "remove_from_collection",
      description: "把某篇文献从某个分类里移出（分类本身保留）。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          name: { type: "string", description: "分类名（或 id）" }
        },
        required: ["docId", "name"]
      }
    },
    async run(args) {
      const doc = library.getDocument(String(args.docId || ""));
      if (!doc) { return "未找到该文献"; }
      const cur = findCollection(String(args.name || ""));
      if (!cur) { return nearCollections(String(args.name || "")); }
      const cols = (doc.collections || []).filter((c) => c !== cur.id);
      library.updateDocument(doc.id, { collections: cols });
      return `已把《${doc.title}》从分类「${cur.name}」移出`;
    }
  },
  {
    write: true,
    def: {
      name: "apply_tags",
      description: "为某篇文献添加/移除标签。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "文献 id" },
          add: { type: "array", items: { type: "string" }, description: "要添加的标签" },
          remove: { type: "array", items: { type: "string" }, description: "要移除的标签" }
        },
        required: ["docId"]
      }
    },
    async run(args) {
      const doc = library.getDocument(String(args.docId || ""));
      if (!doc) { return "未找到该文献"; }
      const tags = new Set(doc.tags || []);
      for (const t of (args.add as string[]) || []) { tags.add(String(t)); }
      for (const t of (args.remove as string[]) || []) { tags.delete(String(t)); }
      library.updateDocument(doc.id, { tags: Array.from(tags) });
      return `《${doc.title}》标签已更新为：${Array.from(tags).join(", ") || "（无）"}`;
    }
  },
  {
    write: true,
    def: {
      name: "set_flags",
      description: "设置文献的星标（starred）/已读（read）状态。属于写入操作，需用户批准。",
      parameters: {
        type: "object",
        properties: { docId: { type: "string" }, starred: { type: "boolean" }, read: { type: "boolean" } },
        required: ["docId"]
      }
    },
    async run(args) {
      const patch: Record<string, boolean> = {};
      if (typeof args.starred === "boolean") { patch.starred = args.starred; }
      if (typeof args.read === "boolean") { patch.read = args.read; }
      const doc = library.updateDocument(String(args.docId || ""), patch);
      return doc ? `《${doc.title}》状态已更新` : "未找到该文献";
    }
  },
  {
    write: true,
    def: {
      name: "move_to_trash",
      description: "将某篇文献移入回收站。属于写入操作，需用户批准。",
      parameters: { type: "object", properties: { docId: { type: "string" } }, required: ["docId"] }
    },
    async run(args) {
      const doc = library.setTrash(String(args.docId || ""), true);
      return doc ? `已将《${doc.title}》移入回收站` : "未找到该文献";
    }
  },
  {
    write: true,
    def: {
      name: "restore_from_trash",
      description: "从回收站恢复某篇文献。属于写入操作，需用户批准。",
      parameters: { type: "object", properties: { docId: { type: "string" } }, required: ["docId"] }
    },
    async run(args) {
      const doc = library.setTrash(String(args.docId || ""), false);
      return doc ? `已恢复《${doc.title}》` : "未找到该文献";
    }
  },
  {
    write: true,
    def: {
      name: "add_to_collection",
      description: "把某篇文献加入某个分类（分类不存在则新建）。属于写入操作，需用户批准。",
      parameters: { type: "object", properties: { docId: { type: "string" }, name: { type: "string" } }, required: ["docId", "name"] }
    },
    async run(args) {
      const doc = library.getDocument(String(args.docId || ""));
      if (!doc) { return "未找到该文献"; }
      const name = String(args.name || "").trim();
      if (!name) { return "分类名不能为空"; }
      let col = library.list().collections.find((c) => c.name === name);
      if (!col) { col = library.addCollection(name, null); }
      const cols = new Set(doc.collections || []);
      cols.add(col.id);
      library.updateDocument(doc.id, { collections: Array.from(cols) });
      return `已将《${doc.title}》加入分类「${name}」`;
    }
  }
];

const WRITE_NAMES = new Set(TOOLS.filter((t) => t.write).map((t) => t.def.name));

export function isWriteTool(name: string): boolean {
  return WRITE_NAMES.has(name);
}

export function toolDefs(): ToolDef[] {
  return TOOLS.filter((t) => {
    if (t.def.name === "search_web") { return webSearchEnabled(); }
    if (t.def.name === "fetch_url") { return webEnabled(); }
    return true;
  }).map((t) => t.def);
}

export async function runTool(name: string, argsJson: string, ctx?: ToolContext): Promise<string> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) { return `未知工具：${name}`; }
  if (name === "search_web" && !webSearchEnabled()) {
    const st = webSearchState();
    return st.on
      ? `「联网搜索」已开启，但服务商「${st.provider}」还没填 API Key，搜索不可用：请让用户在 设置 → AI 助手 → 联网搜索 里填「${st.provider}」的 Key 并保存，然后再试（在此之前不要猜测外部论文）。`
      : "「联网搜索」未开启：请让用户在 设置 → AI 助手 → 联网搜索 里开启后再试（在此之前不要猜测外部论文）。";
  }
  if (name === "fetch_url" && !webEnabled()) {
    return "「联网搜索」未开启：联网功能在 设置 → AI 助手 → 联网搜索 里，请让用户开启后再试。";
  }
  let args: Record<string, unknown> = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }
  try { return await tool.run(args, ctx); } catch (err) { return `工具执行出错：${(err as Error).message}`; }
}
