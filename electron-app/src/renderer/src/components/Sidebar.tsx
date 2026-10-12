import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Icon } from "./Icons";
import type { LibraryApi } from "../state/useLibrary";
import { PSEUDO } from "../state/useLibrary";
import { tagColor } from "../state/tagColors";
import TagPalette from "./TagPalette";

const LOG_CATS = [
  { id: "tlog", name: "翻译日志", icon: "log" },
  { id: "ailog", name: "AI对话日志", icon: "message" },
  { id: "syslog", name: "系统运行日志", icon: "terminal" }
];
const LOG_STATUS: Record<string, { id: string; name: string }[]> = {
  tlog: [
    { id: "all", name: "全部" },
    { id: "done", name: "已完成" },
    { id: "running", name: "进行中" },
    { id: "failed", name: "失败" }
  ],
  ailog: [
    { id: "all", name: "全部" },
    { id: "paper", name: "论文对话" },
    { id: "library", name: "文库对话" }
  ],
  syslog: [
    { id: "all", name: "全部" },
    { id: "info", name: "信息" },
    { id: "warn", name: "警告" },
    { id: "error", name: "错误" }
  ]
};
const READ_BUCKETS = ["今天", "昨天", "本周", "更早"];

function bucketOf(ts: number): string {
  const now = new Date();
  const d = new Date(ts * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  const t = d.getTime();
  if (t >= startOfToday) { return "今天"; }
  if (t >= startOfToday - day) { return "昨天"; }
  if (t >= startOfToday - 6 * day) { return "本周"; }
  return "更早";
}

export default function Sidebar({
  lib,
  onOpenDoc,
  showCounts,
  logCat,
  setLogCat,
  logStatus,
  setLogStatus
}: {
  lib: LibraryApi;
  onOpenDoc: (id: string) => void;
  showCounts: boolean;
  logCat: string;
  setLogCat: (v: string) => void;
  logStatus: string;
  setLogStatus: (v: string) => void;
}): JSX.Element {
  return (
    <aside className="sidebar" aria-label="文库与分类">
      <div className="side-search">
        <div className="search-field">
          <Icon name="search" small />
          <input
            type="search"
            placeholder="搜索标题、作者、标签…"
            value={lib.query}
            onChange={(e) => lib.setQuery(e.target.value)}
          />
          <span className="kbd">/</span>
        </div>
      </div>
      <div className="side-scroll">
        {lib.section === "recent" ? (
          <RecentTree lib={lib} onOpenDoc={onOpenDoc} />
        ) : lib.section === "logs" ? (
          <LogTree logCat={logCat} setLogCat={setLogCat} logStatus={logStatus} setLogStatus={setLogStatus} />
        ) : (
          <LibraryTree lib={lib} showCounts={showCounts} />
        )}
      </div>
    </aside>
  );
}

const DOCS_MIME = "application/x-arxiver-docs";
const COL_MIME = "application/x-arxiver-col";

function Group({ name, action, children }: { name: string; action?: JSX.Element; children: ReactNode }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={"side-group" + (collapsed ? " collapsed" : "")}>
      <div className="side-group-head">
        <button className="side-group-btn" title={collapsed ? "展开" : "折叠"} onClick={() => setCollapsed((c) => !c)}>
          <span className="chev"><Icon name="chev-down" small /></span>
          <span className="side-group-name">{name}</span>
        </button>
        {action}
      </div>
      <div className="side-list">{children}</div>
    </div>
  );
}

/** 拖到行的上/下 28% 表示插到前/后（排序），中间表示放进去（成为子分类） */
function dropPos(e: React.DragEvent<HTMLElement>): "before" | "after" | "inside" {
  const r = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - r.top;
  if (y < r.height * 0.28) { return "before"; }
  if (y > r.height * 0.72) { return "after"; }
  return "inside";
}

function LibraryTree({ lib, showCounts }: { lib: LibraryApi; showCounts: boolean }): JSX.Element {
  const Count = ({ n }: { n: number }) => showCounts ? <span className="side-item-count">{n}</span> : <span />;
  const parents = lib.collections.filter((c) => !c.parent);

  const [palette, setPalette] = useState<{ x: number; y: number; tag: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "col" | "tag"; id: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "col" | "tag"; id: string; name: string; value: string } | null>(null);
  const [dragId, setDragId] = useState("");
  const [hint, setHint] = useState<{ id: string; pos: "before" | "after" | "inside" } | null>(null);
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [dupHint, setDupHint] = useState("");
  const [colHint, setColHint] = useState("");
  const [searching, setSearching] = useState(false);
  const [tagQuery, setTagQuery] = useState("");

  useEffect(() => {
    if (!menu && !palette) { return; }
    const close = (): void => { setMenu(null); setPalette(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu, palette]);

  const tags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return Object.keys(lib.tagCounts).filter((t) => !q || t.toLowerCase().includes(q)).sort();
  }, [lib.tagCounts, tagQuery]);

  const commitRename = async (): Promise<void> => {
    const r = renaming;
    setRenaming(null);
    if (!r) { return; }
    const to = r.value.trim();
    if (!to || to === r.name) { return; }
    if (r.kind === "tag") { await lib.renameTag(r.name, to); }
    else { await lib.renameCollection(r.id, to); }
  };

  const commitNewCol = async (value: string): Promise<void> => {
    const n = value.trim();
    if (!n) { setRenaming(null); setColHint(""); return; }
    if (parents.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      setColHint(`「${n}」已存在`);
      return;
    }
    setRenaming(null);
    setColHint("");
    await lib.addCollection(n, null);
  };

  const submitTag = async (): Promise<void> => {
    const t = newTag.trim();
    if (!t) { setAddingTag(false); setNewTag(""); setDupHint(""); return; }
    // 重复检测：已存在（无论来自文献还是已登记）就提示，不再重复添加
    if (lib.tagCounts[t] !== undefined) {
      setDupHint(`「${t}」已存在`);
      return;
    }
    setAddingTag(false);
    setNewTag("");
    setDupHint("");
    await lib.addTag(t);
  };

  return (
    <>
      <Group
        name="我的文库"
        action={<button className="side-group-action" title="新建分类" onClick={() => setRenaming({ kind: "col", id: "", name: "", value: "" })}><Icon name="plus" small /></button>}
      >
        {PSEUDO.map((node) => (
          <button
            key={node.id}
            className={"side-item" + (lib.collId === node.id && !lib.tag ? " is-active" : "")}
            onClick={() => { lib.setTag(""); lib.setCollId(node.id); }}
          >
            <span className="side-item-icon"><Icon name={node.icon} small /></span>
            <span className="side-item-name">{node.name}</span>
            <Count n={lib.countFor(node.id)} />
          </button>
        ))}

        <div className="side-cols">
          {renaming && renaming.kind === "col" && renaming.id === "" && (
            <>
              <input
                className="side-inline-input"
                autoFocus
                value={renaming.value}
                placeholder="新分类名，回车创建"
                onChange={(e) => { setRenaming({ ...renaming, value: e.target.value }); if (colHint) { setColHint(""); } }}
                onKeyDown={(e) => { if (e.key === "Enter") { void commitNewCol(renaming.value); } if (e.key === "Escape") { setRenaming(null); setColHint(""); } }}
                onBlur={() => { setRenaming(null); setColHint(""); }}
              />
              {colHint && <div className="side-inline-hint">{colHint}</div>}
            </>
          )}
          {parents.map((parent) => {
            const children = lib.collections.filter((c) => c.parent === parent.id);
            const active = lib.collId === parent.id && !lib.tag;
            return (
              <div key={parent.id}>
                {renaming && renaming.kind === "col" && renaming.id === parent.id ? (
                  <input
                    className="side-inline-input"
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") { void commitRename(); } if (e.key === "Escape") { setRenaming(null); } }}
                    onBlur={() => { void commitRename(); }}
                  />
                ) : (
                  <button
                    className={"side-item side-draggable" + (active ? " is-active" : "") + (hint?.id === parent.id ? (hint.pos === "inside" ? " is-drop" : " is-drop-" + hint.pos) : "") + (dragId === parent.id ? " is-dragging" : "")}
                    draggable
                    onDragStart={(e) => { setDragId(parent.id); e.dataTransfer.setData(COL_MIME, parent.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragId(""); setHint(null); }}
                    onDragOver={(e) => {
                      const docs = e.dataTransfer.types.includes(DOCS_MIME);
                      const col = e.dataTransfer.types.includes(COL_MIME) || !!dragId;
                      if (!docs && !col) { return; }
                      if (dragId === parent.id) { return; }
                      e.preventDefault(); e.stopPropagation();
                      setHint({ id: parent.id, pos: docs ? "inside" : dropPos(e) });
                    }}
                    onDragLeave={() => setHint((h) => (h && h.id === parent.id ? null : h))}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      const pos = hint && hint.id === parent.id ? hint.pos : "inside";
                      setHint(null);
                      const raw = e.dataTransfer.getData(DOCS_MIME);
                      if (raw) {
                        try { void lib.setDocsCollection(JSON.parse(raw) as string[], parent.id); } catch { /* ignore */ }
                        return;
                      }
                      const colId = e.dataTransfer.getData(COL_MIME) || dragId;
                      setDragId("");
                      if (colId) { void lib.moveCollection(colId, parent.id, pos); }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: "col", id: parent.id, name: parent.name }); }}
                    onClick={() => { lib.setTag(""); lib.setCollId(parent.id); }}
                  >
                    <span className="side-item-icon"><Icon name="folder" small /></span>
                    <span className="side-item-name">{parent.name}</span>
                    <Count n={lib.countFor(parent.id)} />
                  </button>
                )}
                {children.map((child) => (
                  <button
                    key={child.id}
                    className={"side-item is-child side-draggable" + (lib.collId === child.id && !lib.tag ? " is-active" : "") + (hint?.id === child.id ? (hint.pos === "inside" ? " is-drop" : " is-drop-" + hint.pos) : "") + (dragId === child.id ? " is-dragging" : "")}
                    draggable
                    onDragStart={(e) => { setDragId(child.id); e.dataTransfer.setData(COL_MIME, child.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragId(""); setHint(null); }}
                    onDragOver={(e) => {
                      const docs = e.dataTransfer.types.includes(DOCS_MIME);
                      const col = e.dataTransfer.types.includes(COL_MIME) || !!dragId;
                      if (!docs && !col) { return; }
                      if (dragId === child.id) { return; }
                      e.preventDefault(); e.stopPropagation();
                      setHint({ id: child.id, pos: docs ? "inside" : dropPos(e) });
                    }}
                    onDragLeave={() => setHint((h) => (h && h.id === child.id ? null : h))}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      const pos = hint && hint.id === child.id ? hint.pos : "inside";
                      setHint(null);
                      const raw = e.dataTransfer.getData(DOCS_MIME);
                      if (raw) {
                        try { void lib.setDocsCollection(JSON.parse(raw) as string[], child.id); } catch { /* ignore */ }
                        return;
                      }
                      const colId = e.dataTransfer.getData(COL_MIME) || dragId;
                      setDragId("");
                      if (colId) { void lib.moveCollection(colId, child.id, pos); }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: "col", id: child.id, name: child.name }); }}
                    onClick={() => { lib.setTag(""); lib.setCollId(child.id); }}
                  >
                    <span className="side-item-icon"><Icon name="folder" small /></span>
                    <span className="side-item-name">{child.name}</span>
                    <Count n={lib.countFor(child.id)} />
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </Group>

      <Group
        name="我的标签"
        action={
          <>
            <button className="side-group-action" title="添加标签" onClick={() => { setAddingTag(true); setSearching(false); }}><Icon name="plus" small /></button>
            <button className="side-group-action" title="搜索标签" onClick={() => { setSearching((s) => !s); setAddingTag(false); }}><Icon name="search" small /></button>
          </>
        }
      >
        <div className="side-sub">
          {addingTag && (
            <input
              className="side-inline-input"
              autoFocus
              value={newTag}
              placeholder="新标签名，回车添加"
              onChange={(e) => { setNewTag(e.target.value); if (dupHint) { setDupHint(""); } }}
              onKeyDown={(e) => { if (e.key === "Enter") { void submitTag(); } if (e.key === "Escape") { setAddingTag(false); setNewTag(""); setDupHint(""); } }}
              onBlur={() => { setAddingTag(false); setNewTag(""); setDupHint(""); }}
            />
          )}
          {addingTag && dupHint && <div className="side-inline-hint">{dupHint}</div>}
          {searching && (
            <div className="side-search-row">
              <input
                className="side-inline-input"
                autoFocus
                value={tagQuery}
                placeholder="搜索标签"
                onChange={(e) => setTagQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearching(false); setTagQuery(""); } }}
              />
              <button className="side-search-clear" title="清空" onClick={() => setTagQuery("")}><Icon name="x" small /></button>
            </div>
          )}
          {tags.length === 0 ? (
            <div className="side-empty">{tagQuery ? "没有匹配的标签" : "无标签"}</div>
          ) : (
            tags.map((t) => (
              renaming && renaming.kind === "tag" && renaming.name === t ? (
                <input
                  key={t}
                  className="side-inline-input"
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { void commitRename(); } if (e.key === "Escape") { setRenaming(null); } }}
                  onBlur={() => { void commitRename(); }}
                />
              ) : (
                <button
                  key={t}
                  className={"side-item" + (lib.tag === t ? " is-active" : "")}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: "tag", id: t, name: t }); }}
                  onClick={() => { lib.setTag(t); lib.setCollId("all"); }}
                >
                  <span
                    className="side-item-icon side-tag-dot"
                    title="设置颜色"
                    onClick={(e) => { e.stopPropagation(); setPalette({ x: e.clientX, y: e.clientY, tag: t }); }}
                  >
                    <span className="tag-dot" style={{ background: tagColor(lib.tagColors[t]) }} />
                  </span>
                  <span className="side-item-name">{t}</span>
                  <Count n={lib.tagCounts[t]} />
                </button>
              )
            ))
          )}
        </div>
      </Group>

      {menu && (
        <div className="ctx-menu side-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.kind === "col" ? (
            <>
              <button onClick={() => { setRenaming({ kind: "col", id: menu.id, name: menu.name, value: menu.name }); setMenu(null); }}><Icon name="note" small /> 重命名</button>
              <button className="danger" onClick={() => { if (confirm(`删除分类「${menu.name}」？`)) { void lib.removeCollection(menu.id); } setMenu(null); }}><Icon name="trash" small /> 删除分类</button>
              <div className="side-menu-hint">分类只是归类：重命名或删除都不会移动、也不会删除任何文献。</div>
            </>
          ) : (
            <>
              <button onClick={() => { setRenaming({ kind: "tag", id: menu.id, name: menu.name, value: menu.name }); setMenu(null); }}><Icon name="note" small /> 重命名</button>
              <button onClick={() => { setPalette({ x: menu.x, y: menu.y, tag: menu.name }); setMenu(null); }}><Icon name="sparkle" small /> 颜色…</button>
              <button className="danger" onClick={() => { if (confirm(`删除标签「${menu.name}」？会从所有文献上移除。`)) { void lib.deleteTag(menu.name); } setMenu(null); }}><Icon name="trash" small /> 删除标签</button>
              <div className="side-menu-hint">重命名 / 删除会作用到所有带该标签的文献（不会删除文献）。</div>
            </>
          )}
        </div>
      )}
      {palette && <TagPalette lib={lib} tag={palette.tag} x={palette.x} y={palette.y} onClose={() => setPalette(null)} />}
    </>
  );
}

function RecentTree({ lib, onOpenDoc }: { lib: LibraryApi; onOpenDoc: (id: string) => void }): JSX.Element {
  const byId = new Map(lib.documents.map((d) => [d.id, d]));
  return (
    <>
      {READ_BUCKETS.map((bucket) => {
        const rows = lib.history.filter((r) => bucketOf(r.at) === bucket && byId.has(r.itemId) && !byId.get(r.itemId)!.trash);
        if (rows.length === 0) { return null; }
        return (
          <Group key={bucket} name={bucket}>
            <div className="side-sub">
                {rows.map((r) => {
                  const doc = byId.get(r.itemId)!;
                  return (
                    <button key={r.itemId + r.at} className="side-item side-doc" onClick={() => onOpenDoc(r.itemId)}>
                      <span className="side-item-icon"><Icon name="book" small /></span>
                      <span className="side-item-name" title={doc.title}>{doc.title}</span>
                      <span className="side-item-count">{new Date(r.at * 1000).toTimeString().slice(0, 5)}</span>
                    </button>
                  );
                })}
            </div>
          </Group>
        );
      })}
      {lib.history.length === 0 && <div className="side-empty">暂无阅读记录</div>}
    </>
  );
}

function LogTree({
  logCat,
  setLogCat,
  logStatus,
  setLogStatus
}: {
  logCat: string;
  setLogCat: (v: string) => void;
  logStatus: string;
  setLogStatus: (v: string) => void;
}): JSX.Element {
  return (
    <>
      <Group name="日志">
        {LOG_CATS.map((cat) => (
          <button key={cat.id} className={"side-item" + (logCat === cat.id ? " is-active" : "")} onClick={() => { setLogCat(cat.id); setLogStatus("all"); }}>
            <span className="side-item-icon"><Icon name={cat.icon} small /></span>
            <span className="side-item-name">{cat.name}</span>
          </button>
        ))}
      </Group>
      <Group name="状态">
        <div className="side-sub">
          {(LOG_STATUS[logCat] || LOG_STATUS.tlog).map((s) => (
            <button key={s.id} className={"side-item" + (logStatus === s.id ? " is-active" : "")} onClick={() => setLogStatus(s.id)}>
              <span className="side-item-icon"><Icon name="file" small /></span>
              <span className="side-item-name">{s.name}</span>
            </button>
          ))}
        </div>
      </Group>
    </>
  );
}
