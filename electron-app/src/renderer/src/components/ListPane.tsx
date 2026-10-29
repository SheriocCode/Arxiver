import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { LibraryDoc } from "../../../shared/types";
import { Icon } from "./Icons";
import type { LibraryApi } from "../state/useLibrary";
import { tagColor } from "../state/tagColors";

function arxivId(url: string): string {
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url || ""));
  return m ? "arXiv:" + m[1] : "";
}
function citationText(doc: LibraryDoc): string {
  const a = doc.authors || "Unknown";
  const y = doc.year || "n.d.";
  const v = doc.venue ? doc.venue + ". " : "";
  const id = doc.doi || arxivId(doc.sourceUrl) || "";
  return `${a} (${y}). ${doc.title}. ${v}${id}`.trim();
}

function fmtDate(ts?: number): string {
  if (!ts) { return "—"; }
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DEFAULT_COLS = { title: 360, tags: 140, year: 64, added: 96, modified: 96 };
const COL_MAX = { title: 720, tags: 320, year: 320, added: 320, modified: 320 };
const SORT_LABEL = { "added-desc": "按添加时间", "year-desc": "按年份", "title-asc": "按标题" } as const;
const SORT_NEXT = { "added-desc": "year-desc", "year-desc": "title-asc", "title-asc": "added-desc" } as const;

export default function ListPane({
  lib,
  onAddDocument,
  showUnread,
  fetchMeta,
  onOpenDoc
}: {
  lib: LibraryApi;
  onAddDocument: () => void;
  showUnread: boolean;
  fetchMeta: boolean;
  onOpenDoc: (id: string) => void;
}): JSX.Element {
  const [cols, setCols] = useState(DEFAULT_COLS);
  const dragging = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; doc: LibraryDoc } | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [importing, setImporting] = useState("");
  const dropBusy = useRef(false);

  useEffect(() => {
    if (!menu) { return; }
    const close = (): void => setMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  // 右键菜单在靠近窗口边缘时向内收，避免下半部分被窗口裁掉。
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) { return; }
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad));
    const y = Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menu]);

  // 拖入后的读取 / 解析阶段提示（来自主进程）；只在本列表自己的拖拽导入期间显示
  useEffect(() => {
    const off = window.api.onLibraryProgress((p) => {
      if (dropBusy.current && !p.done && p.text) { setImporting(p.text); }
    });
    return off;
  }, []);

  const gridTemplate = `24px ${cols.title}px ${cols.tags}px ${cols.year}px ${cols.added}px ${cols.modified}px 44px minmax(0, 1fr)`;
  // 当前正在看的分类（非伪分类、非标签视图）
  const curCol = !lib.tag ? lib.collections.find((c) => c.id === lib.collId) || null : null;
  // how many tag dots fit in the (resizable) tags column; the rest collapse into a
  // trailing "+N" pill (9px dot + 5px gap = 14px each, plus room for the pill)
  const maxDots = Math.max(1, Math.floor((cols.tags - 24) / 14));

  const startResize = useCallback((key: keyof typeof DEFAULT_COLS, e: React.MouseEvent) => {
    dragging.current = key;
    const startX = e.clientX;
    const startW = cols[key];
    const max = COL_MAX[key];
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(48, Math.min(max, startW + (ev.clientX - startX)));
      setCols((c) => ({ ...c, [key]: Math.round(w) }));
    };
    const onUp = () => {
      dragging.current = null;
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [cols]);

  const isTrash = lib.collId === "trash" && !lib.tag;
  const title = lib.tag ? "标签: " + lib.tag
    : { all: "全部文献", recent: "最近添加", unfiled: "未分类", duplicates: "重复条目", trash: "回收站" }[lib.collId] || "全部文献";
  const subtitle = isTrash ? `${lib.trashed.length} 条已删除` : `${lib.visible.length} 篇文献`;

  const chips: [string, string, number][] = [
    ["all", "全部", lib.scoped.length],
    ["unread", "未读", lib.scoped.filter((d) => !d.read).length],
    ["note", "有笔记", lib.scoped.filter((d) => d.notes && d.notes.length > 0).length],
    ["star", "已加星", lib.scoped.filter((d) => d.starred).length]
  ];

  const multi = lib.selectedIds.length > 1;

  const onDropFiles = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDropOver(false);
    if (isTrash) { return; }
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) { return; }
    const target = ["all", "recent", "unfiled", "duplicates", "trash"].includes(lib.collId) ? [] : [lib.collId];
    dropBusy.current = true;
    try {
      for (const f of files) {
        setImporting(`正在导入 ${f.name}…`);
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const doc = await window.api.libraryAdd({ sourceBytes: bytes, name: f.name, collections: target });
          if (fetchMeta) { await window.api.libraryEnrichMetadata(doc.id); }
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
    } finally {
      dropBusy.current = false;
      setImporting("");
      await lib.refresh();
    }
  };

  return (
    <main
      className="list-pane"
      aria-label="文献列表"
      onDragOver={(e) => { if (!e.dataTransfer.types.includes("Files") || isTrash) { return; } e.preventDefault(); setDropOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropOver(false); } }}
      onDrop={(e) => { void onDropFiles(e); }}
    >
      <div className="list-toolbar">
        <div className="list-heading">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="list-actions">
          {multi ? (
            <>
              <span className="muted" style={{ fontSize: 12 }}>已选 {lib.selectedIds.length}</span>
              {isTrash ? (
                <>
                  <button className="btn btn-ghost" onClick={() => lib.setTrash(lib.selectedIds, false)}><Icon name="history" small /> 恢复</button>
                  <button className="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={() => { if (confirm(`永久删除 ${lib.selectedIds.length} 条？`)) { void lib.purge(lib.selectedIds); } }}><Icon name="trash" small /> 永久删除</button>
                </>
              ) : (
                <button className="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={() => lib.setTrash(lib.selectedIds, true)}><Icon name="trash" small /> 移入回收站</button>
              )}
              <button className="btn btn-ghost" onClick={lib.clearSelection}>取消</button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" aria-label="排序方式" onClick={() => lib.setSort(SORT_NEXT[lib.sort])}>
                <Icon name="sort" small /><span>{SORT_LABEL[lib.sort]}</span>
              </button>
              {isTrash && lib.trashed.length > 0 && (
                <button className="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={() => { if (confirm(`清空回收站（${lib.trashed.length} 条）？此操作不可恢复。`)) { void lib.emptyTrash(); } }}><Icon name="trash" small /> 清空回收站</button>
              )}
              <button className="btn btn-primary" onClick={onAddDocument}><Icon name="plus" small /><span>新建文献</span></button>
            </>
          )}
        </div>
      </div>

      <div className="filter-bar" role="group" aria-label="筛选">
        {chips.map(([id, label, n]) => (
          <button key={id} className="chip" aria-pressed={lib.filter === id} onClick={() => lib.setFilter(id as never)}>
            {label}<span className="chip-count">{n}</span>
          </button>
        ))}
        <div className="list-search">
          <Icon name="search" small />
          <input
            type="search"
            placeholder="搜索标题、作者、标签…"
            value={lib.query}
            onChange={(e) => lib.setQuery(e.target.value)}
          />
          {lib.query.length > 0 && (
            <button type="button" className="list-search-clear" aria-label="清除搜索" title="清除搜索" onClick={() => lib.setQuery("")}>
              <Icon name="x" small />
            </button>
          )}
        </div>
      </div>

      <div className="list-scroll">
      <div className="col-head" style={{ "--list-grid": gridTemplate } as CSSProperties} aria-hidden="true">
        <span />
        <span className="col-title">标题 / 作者<ResizeHandle onStart={(e) => startResize("title", e)} /></span>
        <span className="col-tags">标签<ResizeHandle onStart={(e) => startResize("tags", e)} /></span>
        <span className="col-year">年份<ResizeHandle onStart={(e) => startResize("year", e)} /></span>
        <span className="col-added">添加日期<ResizeHandle onStart={(e) => startResize("added", e)} /></span>
        <span className="col-modified">修改日期<ResizeHandle onStart={(e) => startResize("modified", e)} /></span>
        <span>状态</span>
      </div>

      <div className="item-list" style={{ "--list-grid": gridTemplate } as CSSProperties}>
        {lib.visible.length === 0 ? (
          <div className="empty">
            <div className="empty-mark"><Icon name={isTrash ? "trash" : "inbox"} /></div>
            <h3>{isTrash ? "回收站是空的" : "还没有文献"}</h3>
            <p>{isTrash ? "删除的文献会出现在这里。" : "点击右上角「新建文献」导入 PDF。"}</p>
          </div>
        ) : (
          lib.visible.map((doc) => (
            <Row
              key={doc.id}
              doc={doc}
              lib={lib}
              isTrash={isTrash}
              showUnread={showUnread}
              maxDots={maxDots}
              onOpen={() => onOpenDoc(doc.id)}
              onContext={(e) => setMenu({ x: e.clientX, y: e.clientY, doc })}
            />
          ))
        )}
      </div>
      </div>

      {(dropOver || importing) && (
        <div className="drop-veil">
          {importing ? <span className="spinner" /> : <Icon name="plus" />}
          <span>{importing || "松开以导入 PDF（可多选）"}</span>
        </div>
      )}

      {menu && (
        <div ref={menuRef} className="ctx-menu" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { const id = menu.doc.id; setMenu(null); onOpenDoc(id); }}><Icon name="book" small /> 查看</button>
          <button onClick={() => { void navigator.clipboard.writeText(citationText(menu.doc)); setMenu(null); }}><Icon name="copy" small /> 复制引用</button>
          {!menu.doc.trash && curCol && menu.doc.collections.includes(curCol.id) && (
            <button onClick={() => { const doc = menu.doc; setMenu(null); void lib.update(doc.id, { collections: doc.collections.filter((c) => c !== curCol.id) }); }}>
              <Icon name="folder" small /> 移出分类「{curCol.name}」
            </button>
          )}
          {!menu.doc.trash && menu.doc.collections.length > 0 && (!curCol || !menu.doc.collections.includes(curCol.id)) && (
            <button onClick={() => { const doc = menu.doc; setMenu(null); void lib.update(doc.id, { collections: [] }); }}>
              <Icon name="folder" small /> 移出全部分类
            </button>
          )}
          <button onClick={() => { lib.select(menu.doc.id); lib.setTab("info"); lib.setEditMode(true); setMenu(null); }}><Icon name="note" small /> 编辑</button>
          <button onClick={() => { void window.api.libraryReveal(menu.doc.id); setMenu(null); }}>
            <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="#4c9aff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7" /><path d="M8 7h9v9" />
            </svg>
            在系统资源管理器中显示
          </button>
          {menu.doc.trash ? (
            <>
              <button onClick={() => { void lib.setTrash([menu.doc.id], false); setMenu(null); }}><Icon name="history" small /> 恢复</button>
              <button className="danger" onClick={() => { if (confirm("永久删除该条目？")) { void lib.purge([menu.doc.id]); } setMenu(null); }}><Icon name="trash" small /> 永久删除</button>
            </>
          ) : (
            <button className="danger" onClick={() => { void lib.setTrash([menu.doc.id], true); setMenu(null); }}><Icon name="trash" small /> 移入回收站</button>
          )}
        </div>
      )}
    </main>
  );
}

function ResizeHandle({ onStart }: { onStart: (e: ReactMouseEvent) => void }): JSX.Element {
  return (
    <span
      className="col-resize"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onStart(e); }}
    />
  );
}

function Row({ doc, lib, isTrash, showUnread, maxDots, onOpen, onContext }: {
  doc: LibraryDoc;
  lib: LibraryApi;
  isTrash: boolean;
  showUnread: boolean;
  maxDots: number;
  onOpen: () => void;
  onContext: (e: ReactMouseEvent) => void;
}): JSX.Element {
  const tags = doc.tags || [];
  const shown = tags.slice(0, maxDots);
  const extra = tags.length - shown.length;
  const sub = [doc.venue, doc.authors].filter(Boolean).join(" · ");
  const selected = lib.selectedIds.includes(doc.id);
  return (
    <div
      className={"item-row" + (selected ? " is-selected" : "")}
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => {
        if (!selected) { lib.select(doc.id); }
        const ids = lib.selectedIds.includes(doc.id) && lib.selectedIds.length ? lib.selectedIds : [doc.id];
        e.dataTransfer.setData("application/x-arxiver-docs", JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "copy";
        // 默认拖影是整行（含标签/日期/星标），宽度上千像素很难看：换成一个小的标题卡片
        const ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        const name = document.createElement("span");
        name.className = "drag-ghost-name";
        name.textContent = doc.title;
        ghost.appendChild(name);
        if (ids.length > 1) {
          const count = document.createElement("span");
          count.className = "drag-ghost-count";
          count.textContent = `${ids.length} 篇`;
          ghost.appendChild(count);
        }
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 14, 18);
        setTimeout(() => ghost.remove(), 0);
      }}
      onClick={(e) => lib.select(doc.id, e.ctrlKey || e.metaKey)}
      onDoubleClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onContext(e); }}
    >
      <span className="item-type"><Icon name={/preprint|预印/i.test(doc.type) ? "globe" : "file"} /></span>
      <span className="item-main">
        <span className="item-title">{doc.title}</span>
        {sub && <span className="item-sub">{sub}</span>}
      </span>
      <span className="item-tags" title={tags.length ? tags.join(", ") : undefined}>
        {shown.map((t) => <span key={t} className="tag-dot" style={{ background: tagColor(lib.tagColors[t]) }} />)}
        {extra > 0 && <span className="item-tag-more" title={tags.join(", ")}>+{extra}</span>}
      </span>
      <span className="item-year">{doc.year || ""}</span>
      <span className="item-date col-added">{fmtDate(doc.added_at)}</span>
      <span className="item-date col-modified">{fmtDate(doc.modified_at)}</span>
      <span className="item-flags">
        {isTrash ? (
          <>
            <button className="flag-btn" title="恢复" onClick={(e) => { e.stopPropagation(); void lib.setTrash([doc.id], false); }}><Icon name="history" small /></button>
            <button className="flag-btn" title="永久删除" style={{ color: "var(--danger)" }} onClick={(e) => { e.stopPropagation(); if (confirm("永久删除该条目？")) { void lib.purge([doc.id]); } }}><Icon name="trash" small /></button>
          </>
        ) : (
          <>
            {!doc.read && showUnread && <span className="unread-dot" />}
            <button className={"flag-btn" + (doc.starred ? " is-on" : "")} title="星标" onClick={(e) => { e.stopPropagation(); void lib.update(doc.id, { starred: !doc.starred }); }}><Icon name="star" small /></button>
          </>
        )}
      </span>
    </div>
  );
}
