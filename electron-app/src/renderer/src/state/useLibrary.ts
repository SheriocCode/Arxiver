import { useCallback, useEffect, useMemo, useState } from "react";
import type { LibraryCollection, LibraryDoc, ReadingRecord } from "../../../shared/types";

export type Section = "collections" | "tags" | "recent" | "overleaf" | "logs";
export type LibChip = "all" | "unread" | "note" | "star";
export type LibSort = "added-desc" | "year-desc" | "title-asc";
export type LibTab = "info" | "notes" | "tags" | "ai";

export const PSEUDO = [
  { id: "all", name: "全部文献", icon: "inbox" },
  { id: "recent", name: "最近添加", icon: "clock" },
  { id: "unfiled", name: "未分类", icon: "file" },
  { id: "duplicates", name: "重复条目", icon: "copy" },
  { id: "trash", name: "回收站", icon: "trash" }
] as const;

function sortItems(list: LibraryDoc[], sort: LibSort): LibraryDoc[] {
  const copy = list.slice();
  if (sort === "year-desc") {
    copy.sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
  } else if (sort === "title-asc") {
    copy.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else {
    copy.sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
  }
  return copy;
}

export function useLibrary() {
  const [documents, setDocuments] = useState<LibraryDoc[]>([]);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [history, setHistory] = useState<ReadingRecord[]>([]);
  const [tagColors, setTagColors] = useState<Record<string, string>>({});
  const [tagNames, setTagNames] = useState<string[]>([]);

  const [section, setSection] = useState<Section>("collections");
  const [collId, setCollId] = useState<string>("all");
  const [tag, setTag] = useState<string>("");
  const [filter, setFilter] = useState<LibChip>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibSort>("added-desc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<LibTab>("info");
  const [editMode, setEditMode] = useState(false);

  const refresh = useCallback(async () => {
    const data = await window.api.libraryState();
    setDocuments(data.documents);
    setCollections(data.collections);
    setHistory(data.history);
    setTagColors(data.tag_colors || {});
    setTagNames(data.tag_names || []);
    setSelectedIds((prev) => {
      const ids = new Set(data.documents.map((d) => d.id));
      const kept = prev.filter((id) => ids.has(id));
      if (kept.length) { return kept; }
      const live = data.documents.filter((d) => !d.trash);
      return live.length ? [live[0].id] : [];
    });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const live = useMemo(() => documents.filter((d) => !d.trash), [documents]);
  const trashed = useMemo(() => documents.filter((d) => d.trash), [documents]);

  const itemsForCollection = useCallback((id: string): LibraryDoc[] => {
    if (id === "trash") { return trashed.slice().sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0)); }
    if (id === "all") { return live.slice(); }
    if (id === "recent") { return live.slice().sort((a, b) => (b.added_at || 0) - (a.added_at || 0)).slice(0, 5); }
    if (id === "unfiled") { return live.filter((d) => d.collections.length === 0); }
    if (id === "duplicates") { return []; }
    const children = collections.filter((c) => c.parent === id).map((c) => c.id);
    return live.filter((d) => d.collections.includes(id) || d.collections.some((c) => children.includes(c)));
  }, [live, trashed, collections]);

  const countFor = useCallback((id: string): number => {
    if (id === "trash") { return trashed.length; }
    if (id === "duplicates") { return 0; }
    return itemsForCollection(id).length;
  }, [itemsForCollection, trashed]);

  const scoped = useMemo(() => {
    let list = tag ? live.filter((d) => d.tags.includes(tag)) : itemsForCollection(collId);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((d) =>
        String(d.title).toLowerCase().includes(q) ||
        String(d.authors).toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)));
    }
    return list;
  }, [tag, collId, itemsForCollection, live, query]);

  const visible = useMemo(() => {
    let list = scoped;
    if (filter === "unread") { list = list.filter((d) => !d.read); }
    else if (filter === "note") { list = list.filter((d) => d.notes && d.notes.length > 0); }
    else if (filter === "star") { list = list.filter((d) => d.starred); }
    return sortItems(list, sort);
  }, [scoped, filter, sort]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    // 显式新建过的标签即使暂时没有文献也列出来
    for (const t of tagNames) { counts[t] = 0; }
    for (const doc of live) {
      for (const t of doc.tags) { counts[t] = (counts[t] || 0) + 1; }
    }
    return counts;
  }, [live, tagNames]);

  const selectedId = selectedIds[0] || "";
  const selected = documents.find((d) => d.id === selectedId) || null;

  const select = useCallback((id: string, additive = false) => {
    setEditMode(false);
    setSelectedIds((prev) => {
      if (!additive) { return [id]; }
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds([]), []);

  const update = useCallback(async (id: string, patch: Partial<LibraryDoc>) => {
    await window.api.libraryUpdate(id, patch);
    setDocuments((docs) => docs.map((d) => (d.id === id ? { ...d, ...patch, modified_at: Date.now() / 1000 } : d)));
  }, []);

  const setTrash = useCallback(async (ids: string[], trashed: boolean) => {
    for (const id of ids) { await window.api.librarySetTrash(id, trashed); }
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    await refresh();
  }, [refresh]);

  const purge = useCallback(async (ids: string[]) => {
    for (const id of ids) { await window.api.libraryPurge(id); }
    await refresh();
  }, [refresh]);

  const emptyTrash = useCallback(async () => {
    await window.api.libraryEmptyTrash();
    await refresh();
  }, [refresh]);

  const addCollection = useCallback(async (name: string, parent: string | null = null) => {
    const created = await window.api.libraryAddCollection(name, parent);
    await refresh();
    return created;
  }, [refresh]);

  const removeCollection = useCallback(async (id: string) => {
    await window.api.libraryRemoveCollection(id);
    setCollId((c) => (c === id ? "all" : c));
    await refresh();
  }, [refresh]);

  const setTagColor = useCallback(async (name: string, color: string) => {
    setTagColors((prev) => {
      const next = { ...prev };
      if (color) { next[name] = color; } else { delete next[name]; }
      return next;
    });
    await window.api.librarySetTagColor(name, color);
  }, []);

  const renameTag = useCallback(async (from: string, to: string) => {
    await window.api.libraryRenameTag(from, to);
    setTag((cur) => (cur === from ? to : cur));
    await refresh();
  }, [refresh]);

  const deleteTag = useCallback(async (name: string) => {
    await window.api.libraryDeleteTag(name);
    setTag((cur) => (cur === name ? "" : cur));
    await refresh();
  }, [refresh]);

  const addTag = useCallback(async (name: string) => {
    const t = name.trim();
    if (!t) { return; }
    setTagNames((prev) => (prev.includes(t) ? prev : [...prev, t]));
    await window.api.libraryAddTag(t);
  }, []);

  const moveCollection = useCallback(async (id: string, target: string | null, position: "before" | "after" | "inside") => {
    await window.api.libraryMoveCollection(id, target, position);
    await refresh();
  }, [refresh]);

  const renameCollection = useCallback(async (id: string, name: string) => {
    await window.api.libraryRenameCollection(id, name);
    await refresh();
  }, [refresh]);

  const setDocsCollection = useCallback(async (ids: string[], collectionId: string | null) => {
    await window.api.librarySetDocsCollection(ids, collectionId);
    await refresh();
  }, [refresh]);

  const recordOpen = useCallback(async (id: string) => {
    await window.api.libraryRecordOpen(id);
    setHistory((prev) => [{ itemId: id, at: Date.now() / 1000 }, ...prev.filter((r) => r.itemId !== id)].slice(0, 500));
  }, []);

  return {
    documents, collections, history, live, trashed, tagColors,
    section, collId, tag, filter, query, sort, selectedIds, tab, editMode,
    scoped, visible, tagCounts, selected, selectedId,
    setSection, setCollId, setTag, setFilter, setQuery, setSort, setTab, setEditMode,
    select, clearSelection, update, setTrash, purge, emptyTrash, addCollection, removeCollection,
    setTagColor, renameTag, deleteTag, addTag, moveCollection, renameCollection, setDocsCollection, recordOpen, countFor, itemsForCollection, refresh
  };
}

export type LibraryApi = ReturnType<typeof useLibrary>;
