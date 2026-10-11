import fs from "node:fs";
import path from "node:path";
import { storageDir } from "../paths";
import type { Conversation, ConversationSummary } from "../../shared/types";

function dir(): string {
  const d = path.join(storageDir(), "conversations");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function file(id: string): string {
  return path.join(dir(), id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

export function list(filter?: { scope: "paper" | "library"; docId?: string }): ConversationSummary[] {
  const out: ConversationSummary[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir()); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) { continue; }
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8")) as Conversation;
      if (!conv || !conv.id) { continue; }
      if (filter && (conv.scope !== filter.scope || (filter.scope === "paper" && conv.docId !== filter.docId))) { continue; }
      out.push({
        id: conv.id,
        scope: conv.scope,
        docId: conv.docId,
        docIds: Array.isArray(conv.docIds) ? conv.docIds : [],
        title: conv.title || "新对话",
        updated_at: conv.updated_at || 0,
        count: (conv.messages || []).filter((m) => m.role === "user").length
      });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

export function get(id: string): Conversation | null {
  try {
    return JSON.parse(fs.readFileSync(file(id), "utf8")) as Conversation;
  } catch {
    return null;
  }
}

export function save(conv: Conversation): void {
  const next: Conversation = { ...conv, updated_at: Date.now() / 1000 };
  const target = file(next.id);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next), "utf8");
  fs.renameSync(tmp, target);
}

export function remove(id: string): void {
  const target = file(id);
  if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); }
}
