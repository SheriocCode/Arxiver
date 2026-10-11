import * as library from "../library";
import * as text from "./text";
import type { ToolDef } from "./model";

export interface ToolImpl {
  def: ToolDef;
  write?: boolean;
  run: (args: Record<string, unknown>) => Promise<string>;
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
  return TOOLS.map((t) => t.def);
}

export async function runTool(name: string, argsJson: string): Promise<string> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) { return `未知工具：${name}`; }
  let args: Record<string, unknown> = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }
  try { return await tool.run(args); } catch (err) { return `工具执行出错：${(err as Error).message}`; }
}
