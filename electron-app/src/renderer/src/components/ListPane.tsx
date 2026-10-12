import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent as ReactMouseEvent } from "react";
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
  onOpenDoc
}: {
  lib: LibraryApi;
  onAddDocument: () => void;
  showUnread: boolean;
  onOpenDoc: (id: string) => void;
}): JSX.Element {
  const [cols, setCols] = useState(DEFAULT_COLS);
  const dragging = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; doc: LibraryDoc } | null>(null);

  useEffect(() => {
    if (!menu) { return; }
    const close = (): void => setMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const gridTemplate = `24px ${cols.title}px ${cols.tags}px ${cols.year}px ${cols.added}px ${cols.modified}px 44px minmax(0, 1fr)`;
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

  return (
    <main className="list-pane" aria-label="文献列表">
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

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { const id = menu.doc.id; setMenu(null); onOpenDoc(id); }}><Icon name="book" small /> 查看</button>
          <button onClick={() => { void navigator.clipboard.writeText(citationText(menu.doc)); setMenu(null); }}><Icon name="copy" small /> 复制引用</button>
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
