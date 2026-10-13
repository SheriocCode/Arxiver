import * as library from "../library";
import * as text from "./text";
import * as websearch from "../websearch";
import { get as getConfig } from "../config";
import type { ToolDef } from "./model";
import type { PaperHit } from "../../shared/types";

export interface ToolImpl {
  def: ToolDef;
  write?: boolean;
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}

// 工具可以把结构化结果额外推给界面（如检索到的论文卡片），并把本轮已发出卡片的编号传进来
export interface ToolContext {
  emit?: (event: { type: "papers"; papers: PaperHit[] }) => void;
  cardBase?: number;
}

// 「联网搜索」开关与 API Key 来自 设置 → AI 助手（config.json）
export function webSearchEnabled(): boolean {
  const c = getConfig();
  return !!(c.search_enabled && c.search_api_key);
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

export const TOOLS: ToolImpl[] = [
  {
    def: {
      name: "search_web",
      description: "联网搜索（Tavily），用于查找本地文库之外的最新论文、会议论文、项目主页、代码或任意资料。" +
        "结果以卡片展示给用户（标题/站点/年份/摘要片段/链接），可直接导入文库（有 arXiv 编号或 DOI 的条目）。" +
        "检索式要求：**一律用英文**；不要直接把用户的中文原句丢进来，先改写成 1~4 条**受控检索式**——" +
        "带领域词（如 computer vision / diffusion model）、带会议或年份锚点（如 NeurIPS 2025、CVPR 2024）、必要时加 site: 限定（site:arxiv.org、site:openreview.net）。" +
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
        maxResults: Number(args.max_results) || 8
      }, getConfig().search_api_key);
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
      name: "list_library",
      description: "列出文库中的文献（可选按关键词过滤标题/作者）。返回 id、标题、年份、作者。",
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
      let docs = aliveDocs();
      if (q) { docs = docs.filter((d) => (d.title + " " + d.authors).toLowerCase().includes(q)); }
      const lines = docs.slice(0, limit).map((d) => `${d.id} | ${d.title} | ${d.year} | ${d.authors}`);
      return lines.length ? lines.join("\n") : "（文库为空或没有匹配的文献）";
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
  return TOOLS.filter((t) => t.def.name !== "search_web" || webSearchEnabled()).map((t) => t.def);
}

export async function runTool(name: string, argsJson: string, ctx?: ToolContext): Promise<string> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) { return `未知工具：${name}`; }
  if (name === "search_web" && !webSearchEnabled()) {
    return "「联网搜索」未开启或没填 Tavily API Key：请让用户在 设置 → AI 助手 → 联网搜索 里开启并保存，然后再试（在此之前不要猜测外部论文）。";
  }
  let args: Record<string, unknown> = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }
  try { return await tool.run(args, ctx); } catch (err) { return `工具执行出错：${(err as Error).message}`; }
}
