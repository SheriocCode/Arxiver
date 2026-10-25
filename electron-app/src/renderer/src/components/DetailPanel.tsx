import { useCallback, useEffect, useRef, useState, type JSX, type MutableRefObject } from "react";
import type { LibraryDoc, Conversation, ConversationSummary, PaperHit, ConvBlock, AppConfig, Skill } from "../../../shared/types";
import { Icon } from "./Icons";
import { formatDate } from "../lib/format";
import { getPdfjs } from "../lib/pdf";
import type { LibraryApi } from "../state/useLibrary";
import { tagColor } from "../state/tagColors";
import type { AppSettings } from "../state/settings";
import { Markdown } from "../lib/markdown";
import { normalizeImage, readImageFile } from "../lib/images";
import BtwPanel, { type BtwSeed } from "./BtwPanel";

function arxivId(url: string): string {
  const match = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url || ""));
  return match ? "arXiv:" + match[1] : "";
}

function docKind(doc: LibraryDoc): string {
  return doc.type || (/arxiv/i.test(doc.sourceUrl || "") ? "预印本" : "文档");
}

function TagChip({ tag, lib, on, title, onClick }: { tag: string; lib: LibraryApi; on?: boolean; title?: string; onClick?: () => void }): JSX.Element {
  return (
    <button className={"tag" + (on ? " is-on" : "")} title={title} onClick={onClick || (() => lib.setTag(tag))}>
      <span className="tag-dot" style={{ background: tagColor(lib.tagColors[tag]) }} />
      {tag}
    </button>
  );
}

function citation(doc: LibraryDoc, withDoi: boolean): string {
  const authors = doc.authors || "Unknown";
  const year = doc.year || "n.d.";
  const venue = doc.venue ? doc.venue + ". " : "";
  const id = withDoi ? doc.doi || arxivId(doc.sourceUrl) || "" : "";
  return `${authors} (${year}). ${doc.title}. ${venue}${id}`.trim();
}

export default function DetailPanel({
  lib,
  onOpen,
  settings,
  config,
  aiSelection,
  aiImage,
  onCite,
  onClearSelection,
  onClearAiImage,
  openDocs,
  onOpenSettings
}: {
  lib: LibraryApi;
  onOpen: (doc: LibraryDoc) => void;
  settings: AppSettings;
  config?: AppConfig | null;
  aiSelection?: { text: string; page: number } | null;
  aiImage?: { id: string; dataUrl: string; page: number; anchor?: number; text?: string } | null;
  onCite?: (docId: string, page: number, quote?: string) => void;
  onClearSelection?: () => void;
  onClearAiImage?: () => void;
  openDocs?: { id: string; name: string }[];
  onOpenSettings?: (section?: string) => void;
}): JSX.Element {
  const doc = lib.selected;

  function openDoc(d: LibraryDoc): void {
    onOpen(d);
  }

  return (
    <aside className="detail" aria-label="文献详情">
      <div className="tab-body">
        {!doc ? (
          <div className="empty">
            <div className="empty-mark"><Icon name="file" /></div>
            <h3>未选择文献</h3>
            <p>从中间列表选择一篇文献以查看信息、PDF 预览、笔记与标签。</p>
          </div>
        ) : null}
        {/* 其它标签：只在不是 AI 时渲染（避免空包装层占满高度把 AI 面板挤出视口） */}
        {doc && lib.tab !== "ai" ? (
          <div className="tab-panel">
            {lib.tab === "info" && (lib.editMode
              ? <InfoEdit lib={lib} doc={doc} />
              : <InfoDisplay lib={lib} doc={doc} onOpenView={openDoc} citeDoi={settings.citeDoi} />)}
            {lib.tab === "notes" && <NotesPanel lib={lib} doc={doc} />}
            {lib.tab === "tags" && <TagsPanel lib={lib} doc={doc} />}
          </div>
        ) : null}
        {/* AI 面板常驻挂载（切到别的标签只是隐藏），否则切一次标签会话就被卸载重建，上下文全丢 */}
        {settings.aiEnabled && doc ? (
          <div className="tab-panel ai-tab" hidden={lib.tab !== "ai"}>
            <AiPanel lib={lib} doc={doc} settings={settings} config={config} onOpenSettings={onOpenSettings} active={lib.tab === "ai"} selection={aiSelection} image={aiImage} onCite={onCite || (() => {})} onClearSelection={onClearSelection || (() => {})} onClearImage={onClearAiImage || (() => {})} openDocs={openDocs || []} resolveDocTitle={(id) => lib.documents.find((d) => d.id === id)?.title || id} />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function InfoDisplay({ lib, doc, onOpenView, citeDoi }: { lib: LibraryApi; doc: LibraryDoc; onOpenView: (d: LibraryDoc) => void; citeDoi: boolean }): JSX.Element {
  const ident = doc.doi || arxivId(doc.sourceUrl) || "—";
  const colNames = doc.collections.map((c) => lib.collections.find((x) => x.id === c)?.name).filter(Boolean);
  const tags = doc.tags || [];
  return (
    <>
      <span className="doc-kind"><Icon name={docKind(doc) === "预印本" ? "globe" : "file"} small />{docKind(doc)}</span>
      <h2 className="doc-title">{doc.title}</h2>
      {doc.authors && <p className="doc-authors">{doc.authors}</p>}
      <dl className="meta-grid">
        <dt>年份</dt><dd>{doc.year || "—"}</dd>
        <dt>来源</dt><dd>{doc.venue || "—"}</dd>
        <dt>标识符</dt><dd>{ident}</dd>
        <dt>添加日期</dt><dd>{formatDate(doc.added_at)}</dd>
      </dl>
      {colNames.length > 0 && (<><div className="section-title">分类</div><div className="tag-cloud">{colNames.map((n) => <span className="tag" key={n}>{n}</span>)}</div></>)}

      {(doc.abstract || doc.summary) && (<><div className="section-title">摘要</div><p className="abstract">{doc.abstract || doc.summary}</p></>)}

      <div className="section-title">附件</div>
      <button className="attach attach-btn" onClick={() => onOpenView(doc)}>
        <span className="attach-ic"><Icon name="file" small /></span>
        <span className="item-main">
          <span className="attach-name od-truncate">{doc.sourceName || "source.pdf"}</span>
          <span className="attach-meta">已保存 · 全文可检索</span>
        </span>
        <span className="od-fill" />
        <span className="item-type"><Icon name="external" small /></span>
      </button>

      <div className="section-title">预览</div>
      <DocPreview doc={doc} />

      <div className="section-title">标签</div>
      <div className="tag-cloud">
        {tags.map((t) => <TagChip key={t} tag={t} lib={lib} />)}
        <button className="tag-add" onClick={() => lib.setTab("tags")}><Icon name="plus" small /> 添加</button>
      </div>
    </>
  );
}

function InfoEdit({ lib, doc }: { lib: LibraryApi; doc: LibraryDoc }): JSX.Element {
  const [form, setForm] = useState({
    title: doc.title, authors: doc.authors, year: doc.year, venue: doc.venue,
    doi: doc.doi, type: doc.type, abstract: doc.abstract, summary: doc.summary
  });
  const [cols, setCols] = useState<string[]>(doc.collections || []);
  const set = (k: keyof typeof form, v: string): void => setForm((f) => ({ ...f, [k]: v }));
  const inputStyle = { height: 34, background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", color: "var(--text)", padding: "0 10px", outline: "none" } as const;
  return (
    <>
      <h2 className="doc-title">编辑文献</h2>
      <div className="field"><label>标题</label><input style={inputStyle} value={form.title} onChange={(e) => set("title", e.target.value)} /></div>
      <div className="field"><label>作者</label><input style={inputStyle} value={form.authors} onChange={(e) => set("authors", e.target.value)} /></div>
      <div className="field-row">
        <div className="field"><label>年份</label><input style={inputStyle} value={form.year} onChange={(e) => set("year", e.target.value)} /></div>
        <div className="field"><label>来源</label><input style={inputStyle} value={form.venue} onChange={(e) => set("venue", e.target.value)} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label>标识符</label><input style={inputStyle} value={form.doi} onChange={(e) => set("doi", e.target.value)} /></div>
        <div className="field"><label>类型</label><input style={inputStyle} value={form.type} onChange={(e) => set("type", e.target.value)} /></div>
      </div>
      <div className="field">
        <label>分类</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {lib.collections.length === 0 && <span className="muted" style={{ fontSize: 12 }}>无分类</span>}
          {lib.collections.map((c) => (
            <label key={c.id} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--text-2)" }}>
              <input
                type="checkbox"
                checked={cols.includes(c.id)}
                onChange={(e) => setCols((cur) => e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id))}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field"><label>摘要</label><textarea style={{ ...inputStyle, height: 100, padding: 10, resize: "vertical" }} value={form.abstract} onChange={(e) => set("abstract", e.target.value)} /></div>
      <div className="detail-actions">
        <button className="btn btn-primary" onClick={async () => { await lib.update(doc.id, { ...form, collections: cols }); lib.setEditMode(false); }}>完成</button>
        <button className="btn btn-ghost" onClick={() => lib.setEditMode(false)}>取消</button>
      </div>
    </>
  );
}

function NotesPanel({ lib, doc }: { lib: LibraryApi; doc: LibraryDoc }): JSX.Element {
  const [input, setInput] = useState("");
  const notes = doc.notes || [];
  useEffect(() => { setInput(""); }, [doc.id]);
  const add = (): void => {
    const text = input.trim();
    if (!text) { return; }
    const note = { id: "n" + Date.now(), text, date: new Date().toISOString().slice(0, 10) };
    void lib.update(doc.id, { notes: [note, ...notes] });
    setInput("");
  };
  return (
    <>
      <div className="note-editor">
        <textarea
          value={input}
          placeholder={`为《${doc.title}》添加一条笔记…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }}
        />
        <div className="od-row">
          <span className="od-fill" />
          <button className="btn btn-primary" onClick={add}><Icon name="plus" small /> 保存笔记</button>
        </div>
      </div>
      {notes.length === 0 ? (
        <p className="empty" style={{ padding: "20px 0", color: "var(--faint)" }}>还没有笔记，写一条吧。</p>
      ) : (
        notes.map((n) => (
          <div className="note-card" key={n.id}>
            <p>{n.text}</p>
            <time>{n.date}</time>
          </div>
        ))
      )}
    </>
  );
}

function TagsPanel({ lib, doc }: { lib: LibraryApi; doc: LibraryDoc }): JSX.Element {
  const [input, setInput] = useState("");
  const tags = doc.tags || [];
  const all = Object.keys(lib.tagCounts).sort();
  const add = (): void => {
    const tag = input.trim();
    if (!tag) { return; }
    if (!tags.includes(tag)) { void lib.update(doc.id, { tags: [...tags, tag] }); }
    setInput("");
  };
  // 「所有标签」是给本文加/去标签的入口，不做左侧「我的标签」那种联动过滤
  const toggle = (tag: string): void => {
    const next = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    void lib.update(doc.id, { tags: next });
  };
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>当前标签</div>
      <div className="tag-cloud">
        {tags.length === 0 ? <span style={{ color: "var(--faint)", fontSize: 13 }}>暂无标签</span>
          : tags.map((t) => <TagChip key={t} tag={t} lib={lib} />)}
      </div>
      <div className="section-title">添加标签</div>
      <div className="od-row">
        <input
          className="od-fill"
          value={input}
          placeholder="输入标签后回车"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { add(); } }}
          style={{ height: 38, padding: "0 11px", background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: 10, outline: "none", color: "var(--text)" }}
        />
        <button className="btn btn-primary" onClick={add}><Icon name="plus" small /> 添加</button>
      </div>
      <div className="section-title">所有标签</div>
      <div className="tag-cloud">
        {all.length === 0 ? <span style={{ color: "var(--faint)", fontSize: 13 }}>无</span>
          : all.map((t) => (
            <TagChip
              key={t}
              tag={t}
              lib={lib}
              on={tags.includes(t)}
              title={tags.includes(t) ? "点击从本文移除该标签" : "点击为本文添加该标签"}
              onClick={() => toggle(t)}
            />
          ))}
      </div>
    </>
  );
}

interface AiToolTrace { name: string; args?: string; content?: string; ms?: number; at?: number; progress?: string }
interface AiConfirm { confirmId: string; name: string; args: string; status: "pending" | "approved" | "rejected" }
// 按到达顺序渲染：模型可能"检索 → 分析 → 再检索 → 作答"，界面要还原这个顺序
type AiBlock = ConvBlock | { kind: "confirm"; items: AiConfirm[] };
interface AiTurn {
  role: "user" | "assistant";
  text: string;
  // 用户这一轮附带的图片（data URL）；渲染成缩略图，也随会话持久化
  images?: string[];
  // 用户这一轮启用的技能 id
  skills?: string[];
  blocks?: AiBlock[];
  error?: string;
  // 未配置模型时的引导轮：不发起请求，只给一句说明 + 「去设置」按钮
  setup?: boolean;
  // 用户主动暂停：保留已生成内容，并给一个「重新编辑问题」入口
  stopped?: boolean;
  streaming?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const textOf = (blocks: AiBlock[] | undefined): string =>
  (blocks || []).filter((b): b is { kind: "text"; text: string } => b.kind === "text").map((b) => b.text).join("");
const toolsOf = (blocks: AiBlock[]): AiToolTrace[] => blocks.flatMap((b) => (b.kind === "tools" ? b.items : []));
const papersOf = (blocks: AiBlock[]): PaperHit[] => blocks.flatMap((b) => (b.kind === "papers" ? b.items : []));

// 旧会话（没有 blocks）按"推理 → 工具 → 卡片 → 文本"补一个块序列
function blocksOf(m: { text?: string; reasoning?: string; tools?: AiToolTrace[]; papers?: PaperHit[]; blocks?: ConvBlock[] }): AiBlock[] {
  if (m.blocks && m.blocks.length) { return m.blocks as AiBlock[]; }
  const out: AiBlock[] = [];
  if (m.reasoning) { out.push({ kind: "reasoning", text: m.reasoning }); }
  if (m.tools && m.tools.length) { out.push({ kind: "tools", items: m.tools }); }
  if (m.papers && m.papers.length) { out.push({ kind: "papers", items: m.papers }); }
  if (m.text) { out.push({ kind: "text", text: m.text }); }
  return out;
}

function appendText(cur: AiTurn, patch: Partial<AiTurn>, kind: "text" | "reasoning", chunk: string): void {
  const blocks = (cur.blocks || []).slice();
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) { blocks[blocks.length - 1] = { kind, text: last.text + chunk } as AiBlock; }
  else { blocks.push({ kind, text: chunk } as AiBlock); }
  Object.assign(cur, patch, { blocks });
  if (kind === "text") { cur.text = textOf(blocks); }
}

function fmtConvTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) { return hm; }
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
}

interface NavAnchor { first: number; text: string; answer: string }

function convAnchors(list: AiTurn[], skillName: (id: string) => string): NavAnchor[] {
  const runs: { first: number; last: number; text: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const skills = (list[i].skills || []).map((id) => skillName(id) || "技能");
    const label = [list[i].text.trim(), skills.length ? `✦ ${skills.join("、")}` : ""].filter(Boolean).join(" · ");
    if (list[i].role !== "user" || !label) { continue; }
    const prev = runs[runs.length - 1];
    if (prev && prev.last === i - 1) { prev.last = i; prev.text += " / " + label; }
    else { runs.push({ first: i, last: i, text: label }); }
  }
  return runs.map((r) => {
    const next = list[r.last + 1];
    const answer = next && next.role === "assistant" ? next.text.trim() : "";
    return { first: r.first, text: r.text, answer };
  });
}

const NAV_BASE = 26;
const NAV_MIN = 14;

function QuestionNav({ anchors, anchorsRef, msgRefs, scrollRef, onGoto }: {
  anchors: NavAnchor[];
  anchorsRef: MutableRefObject<NavAnchor[]>;
  msgRefs: MutableRefObject<(HTMLDivElement | null)[]>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  onGoto: (i: number) => void;
}): JSX.Element {
  const [hover, setHover] = useState(-1);
  const [hoverTop, setHoverTop] = useState(0);
  const [active, setActive] = useState(0);
  const hoverRef = useRef(-1);
  const activeRef = useRef(0);
  const barRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) { return; }
    const onScroll = (): void => {
      const list = anchorsRef.current;
      const rectTop = el.getBoundingClientRect().top;
      let act = 0;
      for (let k = 0; k < list.length; k++) {
        const me = msgRefs.current[list[k].first];
        if (!me) { continue; }
        if (me.getBoundingClientRect().top - rectTop <= el.clientHeight * 0.32) { act = k; } else { break; }
      }
      if (act !== activeRef.current) { activeRef.current = act; setActive(act); }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [anchorsRef, msgRefs, scrollRef]);

  const onNavMove = (e: { clientY: number }): void => {
    const navEl = navRef.current;
    let best = -1;
    let bestD = Infinity;
    let bestTop = 0;
    for (let k = 0; k < barRefs.current.length; k++) {
      const el = barRefs.current[k];
      if (!el) { continue; }
      const r = el.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      if (d < bestD) {
        bestD = d;
        best = k;
        bestTop = navEl ? r.top + r.height / 2 - navEl.getBoundingClientRect().top : 0;
      }
    }
    if (best !== hoverRef.current) { hoverRef.current = best; setHover(best); setHoverTop(bestTop); }
  };
  const onNavLeave = (): void => { if (hoverRef.current !== -1) { hoverRef.current = -1; setHover(-1); } };

  const cur = hover >= 0 ? anchors[hover] : null;
  return (
    <div className="ai-qnav" ref={navRef} onMouseMove={onNavMove} onMouseLeave={onNavLeave}>
      {cur && (
        <div className="ai-qnav-tip" style={{ top: hoverTop }}>
          <div className="ai-qnav-tip-title">{cur.text}</div>
          {cur.answer ? <div className="ai-qnav-tip-body">{cur.answer}</div> : null}
        </div>
      )}
      {anchors.map((a, k) => {
        const len = hover < 0 ? NAV_MIN : Math.max(7, NAV_BASE - Math.abs(k - hover) * 4);
        const cls = "ai-qnav-bar" + (hover === k ? " active" : (hover < 0 && k === active ? " current" : ""));
        return (
          <button key={a.first} ref={(el) => { barRefs.current[k] = el; }} type="button" className={cls} onClick={() => onGoto(a.first)}>
            <span className="ai-qnav-line" style={{ transform: "scaleX(" + (len / NAV_BASE).toFixed(3) + ")" }} />
          </button>
        );
      })}
    </div>
  );
}

function ConfirmCard({ item, onDecide }: { item: AiConfirm; onDecide: (confirmId: string, approved: boolean, args?: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState(item.args);
  if (item.status !== "pending") {
    return <div className={"ai-confirm is-" + item.status}>{item.status === "approved" ? "✓ 已批准" : "✕ 已拒绝"}：{item.name}</div>;
  }
  let pretty = args;
  try { pretty = JSON.stringify(JSON.parse(args), null, 2); } catch { pretty = args; }
  return (
    <div className="ai-confirm">
      <div className="ai-confirm-head">需要你确认：<code>{item.name}</code></div>
      {editing
        ? <textarea className="ai-confirm-args" value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
        : <pre className="ai-confirm-args">{pretty}</pre>}
      <div className="ai-confirm-actions">
        <button type="button" className="btn primary" onClick={() => onDecide(item.confirmId, true, editing ? args : undefined)}>批准</button>
        <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>{editing ? "取消修改" : "修改"}</button>
        <button type="button" className="btn danger" onClick={() => onDecide(item.confirmId, false)}>拒绝</button>
      </div>
    </div>
  );
}

// 一批检索结果：过程性的那几批默认**折叠成一行**（图标 + 数量 + 站点），最后一批展开成卡片。
// 展开状态由父组件控制，这样 [[card:N]] 跳转时能把目标那一批展开并高亮。
function PaperBlock({ papers, open, onToggle, onJumped, state, progress, inLibrary, onImport, onOpen }: {
  papers: PaperHit[];
  open: boolean;
  onToggle: () => void;
  onJumped?: string;
  state: Record<string, "busy" | "ok" | "err">;
  progress: string;
  inLibrary: (p: PaperHit) => string;
  onImport: (p: PaperHit) => void;
  onOpen: (url: string) => void;
}): JSX.Element {
  const sites = Array.from(new Set(papers.map((p) => p.venue || p.source).filter(Boolean))).slice(0, 3).join(" / ");
  return (
    <div className={"paper-block" + (open ? "" : " is-collapsed")}>
      <button type="button" className="paper-head" aria-expanded={open} onClick={onToggle}>
        <Icon name="search" small />
        <span className="paper-head-label">外部检索结果（{papers.length}）</span>
        {!open && sites ? <span className="paper-head-sites">{sites}</span> : null}
        <div className="od-fill" />
        <Icon name={open ? "chev-down" : "chev-right"} small />
      </button>
      {open ? (
        <PaperCards papers={papers} jumped={onJumped} state={state} progress={progress} inLibrary={inLibrary} onImport={onImport} onOpen={onOpen} />
      ) : null}
    </div>
  );
}

// 外部检索结果卡片：可一键导入文库，或打开链接 / PDF；带本轮对话里的编号（[[card:N]] 用）
function PaperCards({ papers, jumped, state, progress, inLibrary, onImport, onOpen }: {
  papers: PaperHit[];
  jumped?: string;
  state: Record<string, "busy" | "ok" | "err">;
  progress: string;
  inLibrary: (p: PaperHit) => string;
  onImport: (p: PaperHit) => void;
  onOpen: (url: string) => void;
}): JSX.Element {
  // 列表高度受限（CSS max-height + 内部滚动），所以一次性渲染全部卡片：
  // 这样 [[card:N]] 永远能找到目标，不用先点「查看更多」。
  return (
    <div className="paper-list">
      {papers.map((p) => {
        const inLib = !!inLibrary(p) || state[p.key] === "ok";
        const canImport = !!(p.arxivId || p.doi);
        return (
          <div key={p.key} className={"paper-card" + (jumped === String(p.idx) ? " is-jumped" : "")} data-card={p.idx} data-id={p.arxivId || p.doi || ""}>
            <div className="paper-title" title={p.title}>
              {p.idx ? <span className="paper-num">#{p.idx}</span> : null}
              {p.title}
            </div>
            {p.authors ? <div className="paper-sub">{p.authors}</div> : null}
            <div className="paper-meta">
              {p.year ? <span>{p.year}</span> : null}
              {p.venue ? <span className="paper-venue" title={p.venue}>{p.venue}</span> : null}
              <span className="paper-src">{p.source}</span>
              {p.citations > 0 ? <span>被引 {p.citations}</span> : null}
            </div>
            {p.abstract ? <div className="paper-abstract">{p.abstract}</div> : null}
            <div className="paper-actions">
              {inLib
                ? <span className="paper-in">已在文库</span>
                : canImport
                  ? (
                    <button type="button" className="btn btn-ghost" disabled={state[p.key] === "busy"} onClick={() => onImport(p)}>
                      <Icon name={state[p.key] === "err" ? "history" : "plus"} small />
                      {state[p.key] === "busy" ? "导入中…" : state[p.key] === "err" ? "重试导入" : "导入到文库"}
                    </button>
                  )
                  : <span className="paper-noid" title="该条目没有 DOI / arXiv 编号，无法自动取回全文">无标识符</span>}
              {p.url ? <button type="button" className="btn btn-ghost" onClick={() => onOpen(p.url)}><Icon name="external" small /> 打开链接</button> : null}
              {p.pdfUrl ? <button type="button" className="btn btn-ghost" onClick={() => onOpen(p.pdfUrl)}><Icon name="file" small /> PDF</button> : null}
            </div>
            {state[p.key] === "busy" && progress ? (
              <div className="import-note"><span className="spinner" />{progress}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SkillsMenu({ skills, attached, onToggle, onSave, onDelete, onAskAi }: {
  skills: Skill[];
  attached: string[];
  onToggle: (id: string) => void;
  onSave: (input: { id?: string; name: string; description: string; instructions: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAskAi: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [form, setForm] = useState({ name: "", description: "", instructions: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const startEdit = (skill?: Skill): void => {
    setForm(skill
      ? { name: skill.name, description: skill.description, instructions: skill.instructions }
      : { name: "", description: "", instructions: "" });
    setError("");
    setEditing(skill || "new");
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) { return; }
    const name = form.name.trim();
    const instructions = form.instructions.trim();
    if (!name) { setError("给技能起个名字"); return; }
    if (!instructions) { setError("技能里要写清楚提示词 / 步骤"); return; }
    setBusy(true);
    try {
      await onSave({ id: editing === "new" ? undefined : (editing as Skill).id, name, description: form.description.trim(), instructions });
      setEditing(null);
      setError("");
    } catch (err) {
      setError((err as Error)?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    const isNew = editing === "new";
    return (
      <div className="ai-skills-pop">
        <form className="ai-skill-form" onSubmit={(e) => void submit(e)}>
          <div className="ai-skills-head">
            <h4>{isNew ? "新建技能" : "编辑技能"}</h4>
            <button type="button" className="icon-btn" title="返回技能列表" onClick={() => { setEditing(null); setError(""); }}><Icon name="chev-left" small /></button>
          </div>
          <label className="ai-skill-field">
            <span>名称</span>
            <input value={form.name} maxLength={80} placeholder="如：论文速读" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label className="ai-skill-field">
            <span>什么时候用（一句话）</span>
            <input value={form.description} maxLength={400} placeholder="如：快速判断一篇论文值不值得精读" onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </label>
          <label className="ai-skill-field">
            <span>提示词 / 步骤</span>
            <textarea
              value={form.instructions}
              rows={7}
              maxLength={12000}
              placeholder={"写清楚希望 AI 怎么做，例如：\n1. 先用三句话概括问题与贡献\n2. 列出方法与关键实验\n3. 指出局限，并给出值得追的参考文献"}
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
            />
          </label>
          {error ? <div className="ai-skill-error">{error}</div> : null}
          <div className="ai-skill-form-actions">
            <button type="button" className="btn" onClick={() => { setEditing(null); setError(""); }}>取消</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="ai-skills-pop">
      <div className="ai-skills-head">
        <h4>技能</h4>
        <button type="button" className="ai-skill-new" onClick={() => startEdit()}><Icon name="plus" small />新建</button>
      </div>
      <div className="ai-skills-hint">把重复使用的提示词 / 工作流程存成技能；点一下即可启用，也可以让 AI 帮你写。</div>
      {skills.length === 0 ? (
        <div className="ai-skills-empty">还没有技能。新建一个，或对 AI 说「把刚才的做法存成技能」。</div>
      ) : (
        <div className="ai-skills-list">
          {skills.map((s) => {
            const on = attached.includes(s.id);
            return (
              <div key={s.id} className={"ai-skill-item" + (on ? " is-on" : "")}>
                <button type="button" className="ai-skill-main" title={on ? "取消启用" : "启用这个技能"} onClick={() => onToggle(s.id)}>
                  <span className="ai-skill-name">
                    <span className="ai-skill-check">{on ? <Icon name="check" small /> : <Icon name="sparkle" small />}</span>
                    {s.name}
                  </span>
                  <span className="ai-skill-desc">{s.description || "未填写说明"}</span>
                </button>
                <button type="button" className="icon-btn" title="编辑" onClick={() => startEdit(s)}><Icon name="note" small /></button>
                <button type="button" className="icon-btn" title="删除" onClick={() => { if (window.confirm(`删除技能「${s.name}」？`)) { void onDelete(s.id); } }}><Icon name="trash" small /></button>
              </div>
            );
          })}
        </div>
      )}
      <div className="ai-skills-foot">
        <button type="button" className="btn btn-ghost" onClick={onAskAi}><Icon name="sparkle" small />让 AI 帮我写</button>
      </div>
    </div>
  );
}

function AiPanel({ lib, doc, settings, config, onOpenSettings, selection, image, onCite, onClearSelection, onClearImage, openDocs, resolveDocTitle, active }: {
  lib: LibraryApi;
  active?: boolean;
  doc: LibraryDoc;
  settings: AppSettings;
  config?: AppConfig | null;
  onOpenSettings?: (section?: string) => void;
  selection?: { text: string; page: number } | null;
  image?: { id: string; dataUrl: string; page: number; anchor?: number; text?: string } | null;
  onCite: (docId: string, page: number, quote?: string) => void;
  onClearSelection: () => void;
  onClearImage: () => void;
  openDocs: { id: string; name: string }[];
  resolveDocTitle: (id: string) => string;
}): JSX.Element {
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState("");
  const [convList, setConvList] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // 技能：技能库、本轮启用的技能、技能面板开关
  const [skills, setSkills] = useState<Skill[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const skillsReady = useRef(false);
  const skillsRef = useRef<Skill[]>([]);
  skillsRef.current = skills;
  const reloadSkills = useCallback(async (): Promise<void> => {
    try {
      setSkills(await window.api.skillsList());
      skillsReady.current = true;
    } catch { /* 读失败就保持旧列表 */ }
  }, []);
  useEffect(() => { void reloadSkills(); }, [reloadSkills]);
  // 技能被删除后，别让它的 id 还挂在"已启用"里（否则空输入也能发送）
  useEffect(() => {
    if (!skillsReady.current) { return; }
    const known = new Set(skills.map((s) => s.id));
    setAttached((prev) => (prev.some((id) => !known.has(id)) ? prev.filter((id) => known.has(id)) : prev));
  }, [skills]);
  const toggleSkill = (id: string): void => {
    setAttached((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const saveSkill = async (input: { id?: string; name: string; description: string; instructions: string }): Promise<void> => {
    await window.api.skillsSave(input);
    await reloadSkills();
  };
  const deleteSkill = async (id: string): Promise<void> => {
    await window.api.skillsRemove(id);
    setAttached((prev) => prev.filter((x) => x !== id));
    await reloadSkills();
  };
  const [refs, setRefs] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => window.api.onLibraryProgress((p) => setLibProgress(p.done ? "" : p.text)), []);
  // 待发送的图片（阅读器框选截图 / 输入框粘贴 / 选文件），发送后随这一轮清空
  const [images, setImages] = useState<{ id: string; dataUrl: string; page?: number; anchor?: number; text?: string }[]>([]);
  // 导入 / 补全元数据的阶段提示（卡片上的「导入到文库」）
  const [libProgress, setLibProgress] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [atOpen, setAtOpen] = useState(false);
  // 「顺便问一下」小窗：btwSeed 变化即换一个新窗口（key 随之重挂载）
  const [btwSeed, setBtwSeed] = useState<BtwSeed | null>(null);
  // 选中 AI 回答后出现的浮动入口（fixed 定位，不占正文空间）
  const [selAsk, setSelAsk] = useState<{ left: number; top: number; text: string } | null>(null);
  const [histQuery, setHistQuery] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框随内容长高（最多 120px，超过就内部滚动）。
  // 注意：面板隐藏时 scrollHeight=0，不能把 0 写进 height，否则输入框变成 0 高、没法点击。
  const growComposer = useCallback((): void => {
    const el = inputRef.current;
    if (!el || el.clientWidth === 0) { return; }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);
  useEffect(() => { growComposer(); }, [input, active, growComposer]);

  // 从阅读器框选来的截图：归一化后加入待发送图片，并通知上层取走
  useEffect(() => {
    if (!image) { return; }
    const incoming = image;
    onClearImage();
    void normalizeImage(incoming.dataUrl).then((dataUrl) => {
      if (!dataUrl) { return; }
      setImages((prev) => (prev.some((x) => x.dataUrl === dataUrl) ? prev
        : [...prev, { id: incoming.id, dataUrl, page: incoming.page, anchor: incoming.anchor, text: incoming.text }]));
    }).catch(() => { /* 图坏了就忽略 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

  const addImageFiles = useCallback(async (files: File[]): Promise<void> => {
    const picked = files.filter((f) => /^image\//i.test(f.type)).slice(0, 6);
    for (const file of picked) {
      try {
        const dataUrl = await normalizeImage(await readImageFile(file));
        if (!dataUrl) { continue; }
        setImages((prev) => (prev.length >= 8 ? prev : [...prev, {
          id: "img" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          dataUrl
        }]));
      } catch { /* 单张读失败不影响其它 */ }
    }
  }, []);

  // Ctrl+V 粘贴图片：面板显示时全局监听，光标在输入框或消息区都能用（纯文本粘贴不拦截）
  useEffect(() => {
    if (!active) { return; }
    const onPaste = (e: ClipboardEvent): void => {
      // 阅读器打开时，粘贴图片归笔记编辑器处理，不再抢到 AI 面板
      const reader = document.querySelector(".reader-overlay");
      if (reader && !reader.hasAttribute("hidden")) { return; }
      const cd = e.clipboardData;
      // 剪贴板里同时有文字时按普通文本粘贴处理（比如从 PDF 里复制文字），不抢输入
      if ((cd?.getData("text/plain") || "").trim()) { return; }
      const files = [
        ...Array.from(cd?.files || []),
        ...Array.from(cd?.items || [])
          .filter((it) => it.kind === "file" && /^image\//i.test(it.type))
          .map((it) => it.getAsFile())
          .filter((f): f is File => !!f)
      ].filter((f) => /^image\//i.test(f.type));
      if (!files.length) { return; }
      e.preventDefault();
      void addImageFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [active, addImageFiles]);
  const turnRef = useRef("");
  const turnsRef = useRef<AiTurn[]>([]);
  const convIdRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [imp, setImp] = useState<Record<string, "busy" | "ok" | "err">>({});
  // 每批检索结果的展开状态（键：该块在 blocks 里的下标）；未设置时默认"最后一批展开"
  const [paperOpen, setPaperOpen] = useState<Record<string, boolean>>({});
  const [jumped, setJumped] = useState("");
  const [pendingJump, setPendingJump] = useState(0);
  // 对话模型是否已配置（基础地址 + 密钥 + 模型）：没配就别真的发起请求，直接引导去设置
  const aiReady = !!(config && config.chat_base_url && config.chat_api_key && config.chat_model);
  // DeepSeek 的 deepseek-chat / reasoner 收图片不会报错、只是当没传，这里提前提示换模型
  let chatHost = "";
  try { chatHost = new URL(config?.chat_base_url || "").hostname; } catch { /* 非标准地址交给服务端判断 */ }
  const visionBlocked = /(^|\.)deepseek\.com$/i.test(chatHost) && /^deepseek-(chat|reasoner|coder)/i.test(String(config?.chat_model || ""));
  const openAiSettings = (): void => onOpenSettings?.("ai");
  // 长耗时工具运行时每秒推进一次，让"已 Ns"和进度看起来是活的
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!turns.some((t) => toolsOf(t.blocks || []).some((x) => x.content === undefined))) { return; }
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [turns]);

  // [[card:N]] → 展开那一批（等 React 提交后再滚动，避免被重渲染打断）
  const jumpToCard = (n: number): void => {
    if (!n) { return; }
    const list = turnsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const blocks = list[i].blocks || [];
      const bi = blocks.findIndex((b) => b.kind === "papers" && b.items.some((p) => p.idx === n));
      if (bi < 0) { continue; }
      setPaperOpen((s) => ({ ...s, [i + ":" + bi]: true }));
      break;
    }
    setPendingJump(n);
  };

  // 打开「顺便问一下」小窗：把主对话最近的内容作为只读背景，不写入主会话
  const openBtw = (question: string, quote: string): void => {
    const history = turnsRef.current
      .filter((t) => t.text.trim())
      .slice(-12)
      .map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }));
    const cardBase = turnsRef.current.reduce((n, t) => n + papersOf(t.blocks || []).length, 0);
    setSelAsk(null);
    setBtwSeed({
      id: "btw" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      question, quote, history, cardBase
    });
  };

  // 在 AI 回答里选中文字 → 在选区下方浮出「顺便问」入口
  const onAnswerMouseUp = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { return; }
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length > 4000) { setSelAsk(null); return; }
    const node = sel.anchorNode;
    const el = node ? (node.nodeType === 3 ? node.parentElement : node as Element) : null;
    if (!el || !el.closest(".msg-assistant")) { setSelAsk(null); return; }
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { return; }
    setSelAsk({
      left: Math.max(90, Math.min(rect.left + rect.width / 2, window.innerWidth - 90)),
      top: Math.min(rect.bottom + 8, window.innerHeight - 40),
      text
    });
  };

  useEffect(() => {
    if (!selAsk) { return; }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(".btw-sel-ask")) { return; }
      setSelAsk(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selAsk]);

  // 切文献时关掉小窗，避免把上一篇的上下文带过去
  useEffect(() => { setBtwSeed(null); setSelAsk(null); }, [doc.id]);

  useEffect(() => {
    if (!pendingJump) { return; }
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-card="${pendingJump}"]`);
    if (!el) {
      // 目标所在的那批结果还没渲染出来：下一帧再试一次
      const raf = window.requestAnimationFrame(() => {
        const again = scrollRef.current?.querySelector<HTMLElement>(`[data-card="${pendingJump}"]`);
        if (again) { again.scrollIntoView({ block: "center" }); setJumped(String(pendingJump)); }
        setPendingJump(0);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    el.scrollIntoView({ block: "center" });
    setJumped(String(pendingJump));
    const t = window.setTimeout(() => setJumped(""), 1600);
    setPendingJump(0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJump, turns]);

  // 卡片上的「导入到文库」：复用按标识符导入（arXiv id / DOI），导入后刷新文库
  const docIdOfPaper = (p: PaperHit): string => {
    const doi = (p.doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
    const ax = (p.arxivId || "").replace(/v\d+$/, "");
    for (const d of lib.documents) {
      if (d.trash) { continue; }
      const ddoi = (d.doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
      if (doi && ddoi && doi === ddoi) { return d.id; }
      if (ax && new RegExp("arxiv\\.org/(abs|pdf)/" + ax.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(d.sourceUrl || "")) { return d.id; }
    }
    return "";
  };
  const importPaper = (p: PaperHit): void => {
    const id = p.arxivId || p.doi || p.url;
    if (!id) { return; }
    setImp((s) => ({ ...s, [p.key]: "busy" }));
    void window.api.libraryImportByIdentifier(id, [])
      .then(async (r) => {
        if (r && (r as { ok?: boolean }).ok) {
          setImp((s) => ({ ...s, [p.key]: "ok" }));
          await lib.refresh();
        } else {
          setImp((s) => ({ ...s, [p.key]: "err" }));
        }
      })
      .catch(() => setImp((s) => ({ ...s, [p.key]: "err" })));
  };
  const msgRefs = useRef<(HTMLDivElement | null)[]>([]);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const anchorsRef = useRef<NavAnchor[]>([]);
  turnsRef.current = turns;
  convIdRef.current = convId;

  const persist = (messages: AiTurn[]): void => {
    const id = convIdRef.current;
    if (!id) { return; }
    const firstUser = messages.find((m) => m.role === "user");
    const firstSkill = (firstUser?.skills || []).map((id) => skillsRef.current.find((s) => s.id === id)?.name).filter((n): n is string => !!n)[0];
    const clean = messages.filter((m) => m.text.trim() || (m.images && m.images.length) || (m.skills && m.skills.length) || m.error || (m.blocks && m.blocks.length > 0));
    const docIds = new Set<string>();
    if (doc.id) { docIds.add(doc.id); }
    for (const m of messages) {
      for (const t of toolsOf(m.blocks || [])) {
        const re = /"docId"\s*:\s*"([0-9a-fA-F]+)"/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(t.args || "")) !== null) { docIds.add(mm[1]); }
      }
    }
    void window.api.agentSaveConversation({
      id,
      scope: "library",
      docId: undefined,
      docIds: Array.from(docIds),
      title: (firstUser?.text || (firstUser?.images?.length ? "图片提问" : firstSkill ? `技能：${firstSkill}` : "新对话")).slice(0, 60),
      updated_at: 0,
      messages: clean.map((m) => ({
        role: m.role,
        text: m.text,
        images: m.images,
        skills: m.skills,
        // 待确认的卡片不入库（重新打开时已失效）；其余块保留顺序
        blocks: (m.blocks || []).filter((b) => b.kind !== "confirm") as ConvBlock[],
        reasoning: m.blocks?.filter((b) => b.kind === "reasoning").map((b) => (b as { text: string }).text).join(""),
        tools: toolsOf(m.blocks || []),
        papers: papersOf(m.blocks || []),
        error: m.error,
        usage: m.usage
      }))
    });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await window.api.agentConversations({ scope: "library" });
      if (cancelled) { return; }
      setConvList(list);
      if (list[0]) {
        const conv = await window.api.agentConversation(list[0].id);
        if (!cancelled && conv) {
          setTurns(conv.messages.map((m) => ({ ...m, blocks: blocksOf(m) })));
          setConvId(conv.id);
          convIdRef.current = conv.id;
          const last = [...conv.messages].reverse().find((m) => m.role === "user" && m.skills && m.skills.length);
          setAttached(last?.skills ? [...last.skills] : []);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) { el.scrollTop = el.scrollHeight; }
  }, [turns]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) { return; }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (near !== atBottomRef.current) { atBottomRef.current = near; setShowJump(!near); }
    if (selAsk) { setSelAsk(null); }
  };
  const jumpToBottom = (): void => {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; }
    atBottomRef.current = true;
    setShowJump(false);
  };
  const gotoMsg = (i: number): void => {
    const el = msgRefs.current[i];
    const sc = scrollRef.current;
    if (!el || !sc) { return; }
    sc.scrollTop = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8;
  };

  useEffect(() => {
    const off = window.api.onAgentEvent((e) => {
      if (e.type === "skills_changed") { void reloadSkills(); }
      if (e.turnId !== turnRef.current) { return; }
      setTurns((prev) => {
        if (prev.length === 0) { return prev; }
        const next = prev.slice();
        const i = next.length - 1;
        const cur: AiTurn = { ...next[i] };
        if (e.type === "delta" && e.text) { appendText(cur, {}, "text", e.text); }
        else if (e.type === "reasoning" && e.text) { appendText(cur, {}, "reasoning", e.text); }
        else if (e.type === "tool_call") {
          const blocks = (cur.blocks || []).slice();
          const last = blocks[blocks.length - 1];
          const item: AiToolTrace = { name: e.name || "", args: e.args, at: Date.now() };
          if (last && last.kind === "tools") { blocks[blocks.length - 1] = { kind: "tools", items: [...last.items, item] }; }
          else { blocks.push({ kind: "tools", items: [item] }); }
          cur.blocks = blocks;
        }
        else if (e.type === "progress") {
          // 长耗时工具的进度：挂到最近一个还没返回的调用上，界面就能看到它在动
          const blocks = (cur.blocks || []).slice();
          let done = false;
          for (let bi = blocks.length - 1; bi >= 0 && !done; bi--) {
            const b = blocks[bi];
            if (b.kind !== "tools") { continue; }
            const items = b.items.slice();
            for (let j = items.length - 1; j >= 0; j--) {
              if (items[j].content === undefined && (!e.name || items[j].name === e.name)) {
                items[j] = { ...items[j], progress: e.text || "" };
                blocks[bi] = { kind: "tools", items };
                done = true;
                break;
              }
            }
          }
          cur.blocks = blocks;
        }
        else if (e.type === "tool_result") {
          const blocks = (cur.blocks || []).slice();
          let done = false;
          for (let bi = blocks.length - 1; bi >= 0 && !done; bi--) {
            const b = blocks[bi];
            if (b.kind !== "tools") { continue; }
            const items = b.items.slice();
            for (let j = items.length - 1; j >= 0; j--) {
              if (items[j].name === e.name && items[j].content === undefined) {
                items[j] = { ...items[j], content: e.content, ms: Math.max(0, Date.now() - (items[j].at || Date.now())) };
                blocks[bi] = { kind: "tools", items };
                done = true;
                break;
              }
            }
          }
          cur.blocks = blocks;
        }
        else if (e.type === "confirmation") {
          const blocks = (cur.blocks || []).slice();
          const item: AiConfirm = { confirmId: e.confirmId || "", name: e.name || "", args: e.args || "{}", status: "pending" };
          const last = blocks[blocks.length - 1];
          if (last && last.kind === "confirm") { blocks[blocks.length - 1] = { kind: "confirm", items: [...last.items, item] }; }
          else { blocks.push({ kind: "confirm", items: [item] }); }
          cur.blocks = blocks;
        }
        else if (e.type === "papers" && e.papers) {
          // 每次检索单独成块（保留"哪一批是第几次搜的"），块内按 key 去重
          const add = e.papers.filter((p) => p && p.title);
          if (add.length) { cur.blocks = [...(cur.blocks || []), { kind: "papers", items: add }]; }
        }
        else if (e.type === "read" && e.read) {
          const item = e.read;
          const blocks = (cur.blocks || []).slice();
          const last = blocks[blocks.length - 1];
          if (last && last.kind === "read") { blocks[blocks.length - 1] = { kind: "read", items: [...last.items, item] }; }
          else { blocks.push({ kind: "read", items: [item] }); }
          cur.blocks = blocks;
        }
        else if (e.type === "usage") { cur.usage = e.usage; }
        else if (e.type === "error") { cur.error = e.error || "出错了"; cur.streaming = false; }
        else if (e.type === "done") { cur.streaming = false; }
        next[i] = cur;
        return next;
      });
      if (e.type === "done" || e.type === "error") {
        setSending(false);
        persist(turnsRef.current);
        void window.api.agentConversations({ scope: "library" }).then(setConvList);
      }
    });
    return off;
    // 只在挂载时订阅一次：原来跟着 convId 重订阅，会在"发问 → 主进程立刻报错"时丢掉第一个事件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (preset?: string): void => {
    const raw = (preset !== undefined ? preset : input).trim();
    // /btw：另开小窗问，不打断正在生成的主回答，也不写进主对话
    const btw = /^\/btw(?:\s+([\s\S]*))?$/i.exec(raw);
    if (btw) {
      setInput("");
      setAtOpen(false);
      openBtw((btw[1] || "").trim(), selection?.text.trim() || "");
      return;
    }
    const q = raw;
    const imgs = images;
    const skillIds = attached;
    if ((!q && !imgs.length && !skillIds.length) || sending) { return; }
    // 没配置对话模型：不要真的发起请求（主进程只能回一句冷冰冰的报错，界面还会一直转圈），
    // 直接把问题记下来并引导用户去「设置 → AI 助手」。
    if (!aiReady) {
      setInput("");
      setImages([]);
      atBottomRef.current = true;
      setShowJump(false);
      setTurns((prev) => [...prev, { role: "user", text: q, images: imgs.map((i) => i.dataUrl), skills: skillIds }, { role: "assistant", text: "", setup: true, error: "AI 助手还没配置对话模型：请在「设置 → AI 助手」里填写基础地址、API 密钥与模型。" }]);
      return;
    }
    if (!convIdRef.current) {
      const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      convIdRef.current = id;
      setConvId(id);
    }
    setInput("");
    setImages([]);
    atBottomRef.current = true;
    setShowJump(false);
    // 历史消息里附上每一轮的检索结果卡片摘要：否则模型看不到上一轮检索到了什么，
    // 只能凭自己的正文猜（会顺着用户臆断"检索到了某某论文"）。
    // 历史里只回传最近 6 张图：截图一直显示在会话里，但没必要每轮都重复上传（请求体和 token 都会涨）
    const recentImages = new Set<string>();
    for (let i = turnsRef.current.length - 1; i >= 0 && recentImages.size < 6; i--) {
      const t = turnsRef.current[i];
      if (t.role !== "user" || !t.images) { continue; }
      for (const url of t.images) { if (recentImages.size < 6) { recentImages.add(url); } }
    }
    const skillTitles = (ids?: string[]): string[] =>
      (ids || []).map((id) => skills.find((s) => s.id === id)?.name).filter((n): n is string => !!n);
    const history = turnsRef.current
      .filter((t) => t.text.trim() || (t.images && t.images.length) || (t.skills && t.skills.length))
      .map((t) => {
        const cards = papersOf(t.blocks || []);
        const kept = t.role === "user" && t.images ? t.images.filter((url) => recentImages.has(url)) : [];
        const withImages = kept.length ? { images: kept } : {};
        const sk = t.role === "user" ? skillTitles(t.skills) : [];
        const base = t.text + (sk.length ? `\n\n[本轮启用技能：${sk.join("、")}]` : "");
        if (!cards.length) { return { role: t.role, content: base, ...withImages }; }
        let digest = "";
        for (const p of cards.slice(0, 40)) {
          const ids = [p.arxivId ? `arXiv:${p.arxivId}` : "", p.doi ? `doi:${p.doi}` : ""].filter(Boolean).join(" ");
          const line = `#${p.idx} ${p.title}（${[p.venue || p.source, p.year].filter(Boolean).join(" · ")}${ids ? `，${ids}` : ""}｜${p.url}）\n`;
          if (digest.length + line.length > 3000) { break; }
          digest += line;
        }
        return { role: t.role, content: `${base}\n\n[本轮外部检索结果卡片，编号即 [[card:N]] 里的 N：\n${digest}]`, ...withImages };
      });
    setTurns((prev) => [...prev, { role: "user", text: q, images: imgs.map((i) => i.dataUrl), skills: skillIds }, { role: "assistant", text: "", streaming: true }]);
    setSending(true);
    const sel = selection ? selection : undefined;
    const refIds = refs.map((r) => r.id);
    const skillIdsPayload = skillIds;
    const cardBase = turnsRef.current.reduce((n, t) => n + papersOf(t.blocks || []).length, 0);
    setRefs([]);
    setAtOpen(false);
    setShowSkills(false);
    // turnId 自己先生成、先记下，再发起请求：主进程可能在我们拿到返回值之前就发事件
    const turnId = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    turnRef.current = turnId;
    void window.api.agentChat({
      turnId, scope: "library", docId: doc.id, selection: sel, refs: refIds, message: q, history, cardBase,
      skills: skillIdsPayload,
      images: imgs.map((i) => ({ dataUrl: i.dataUrl, page: i.page, anchor: i.anchor, text: i.text }))
    })
      .catch((err) => {
        setSending(false);
        setTurns((prev) => {
          const next = prev.slice();
          const i = next.length - 1;
          next[i] = { ...next[i], streaming: false, error: String(err?.message || err) };
          return next;
        });
      });
    onClearSelection();
  };

  const stop = (): void => {
    if (turnRef.current) { void window.api.agentCancel(turnRef.current); }
    // 兜底：即使这一轮已经结束（没来得及收到 done/error），也别让按钮永远停在"停止"
    setSending(false);
    // 主动暂停：**保留已经生成的内容**，只把这一轮标成"已暂停生成"；要不要重来由用户点下面的链接决定
    setTurns((prev) => {
      const next = prev.slice();
      const i = next.length - 1;
      if (next[i] && next[i].role === "assistant") { next[i] = { ...next[i], streaming: false, stopped: true }; }
      return next;
    });
  };

  // 点"重新编辑问题"：把这一轮（提问 + 已暂停的回答）撤掉，问题回填输入框继续改
  const editQuestion = (i: number): void => {
    const list = turnsRef.current;
    const q = list[i - 1];
    const text = q && q.role === "user" ? q.text : "";
    setTurns(list.slice(0, Math.max(0, i - 1)));
    if (text) { setInput(text); }
    if (q && q.role === "user" && q.skills && q.skills.length) { setAttached([...q.skills]); }
    if (q && q.role === "user" && q.images && q.images.length) {
      setImages(q.images.map((dataUrl, k) => ({ id: "edit" + Date.now().toString(36) + k, dataUrl })));
    }
    inputRef.current?.focus();
  };

  const atOptions = openDocs.filter((d) => d.id !== doc.id);
  const skillName = (id: string): string => skills.find((s) => s.id === id)?.name || "";
  const anchors = convAnchors(turns, skillName);
  anchorsRef.current = anchors;
  const histFiltered = convList.filter((c) => {
    const q = histQuery.trim().toLowerCase();
    if (!q) { return true; }
    const titles = (c.docIds || []).map(resolveDocTitle).join(" ");
    return (c.title + " " + titles).toLowerCase().includes(q);
  });
  const pickRef = (d: { id: string; name: string }): void => {
    setRefs((prev) => (prev.some((r) => r.id === d.id) ? prev : [...prev, { id: d.id, title: d.name }]));
    setAtOpen(false);
    inputRef.current?.focus();
  };

  const decide = (confirmId: string, approved: boolean, args?: string): void => {
    setTurns((prev) => prev.map((t) => t.blocks
      ? {
        ...t,
        blocks: t.blocks.map((b) => b.kind === "confirm"
          ? { ...b, items: b.items.map((c) => c.confirmId === confirmId ? { ...c, status: approved ? "approved" as const : "rejected" as const, args: args ?? c.args } : c) }
          : b)
      }
      : t));
    void window.api.agentConfirm(confirmId, { approved, args });
  };

  const newConv = (): void => { setTurns([]); setConvId(""); convIdRef.current = ""; setShowHistory(false); setImages([]); setAttached([]); setShowSkills(false); };
  const openConv = async (id: string): Promise<void> => {
    const conv = await window.api.agentConversation(id);
    // 切到别的会话时，没发出去的图片不该跟过去
    setImages([]);
    if (conv) {
      setTurns(conv.messages.map((m) => ({ ...m, blocks: blocksOf(m) })));
      setConvId(conv.id);
      convIdRef.current = conv.id;
      // 恢复这个会话最后一次启用的技能（已删除的会查不到名字，不会显示）
      const last = [...conv.messages].reverse().find((m) => m.role === "user" && m.skills && m.skills.length);
      setAttached(last?.skills ? [...last.skills] : []);
    }
    setShowHistory(false);
  };
  const delConv = async (id: string): Promise<void> => {
    await window.api.agentDeleteConversation(id);
    setConvList(await window.api.agentConversations({ scope: "library" }));
    if (id === convIdRef.current) { newConv(); }
  };

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-badge"><Icon name="arxiver" small /></span>
        <span className="ai-brand">Arxiver</span>
        <span className="od-fill" />
        <button type="button" className="icon-btn" title="新对话" onClick={newConv}><Icon name="plus" small /></button>
        <div className="ai-skills-wrap">
          <button
            type="button"
            className="icon-btn"
            title="技能：可复用的提示词 / 工作流程"
            aria-pressed={showSkills || attached.length > 0}
            onClick={() => { setShowSkills((v) => !v); setShowHistory(false); }}
          >
            <Icon name="sparkle" small />
          </button>
          {showSkills && (
            <SkillsMenu
              skills={skills}
              attached={attached}
              onToggle={toggleSkill}
              onSave={saveSkill}
              onDelete={deleteSkill}
              onAskAi={() => {
                setShowSkills(false);
                setInput("帮我创建一个技能。先问清这个技能要解决什么任务、希望按什么步骤执行、输出成什么格式，确认后把它保存成技能。");
                inputRef.current?.focus();
              }}
            />
          )}
        </div>
        <div className="ai-hist-wrap">
          <button type="button" className="icon-btn" title="历史对话" onClick={() => { setShowHistory((v) => !v); setShowSkills(false); }}><Icon name="history" small /></button>
          {showHistory && (
            <div className="ai-hist-pop">
              <input className="ai-hist-search" placeholder="搜索对话或论文…" value={histQuery} onChange={(e) => setHistQuery(e.target.value)} />
              {histFiltered.length === 0 ? <div className="ai-hist-empty">无匹配记录</div> : histFiltered.map((c) => {
                const titles = (c.docIds || []).map(resolveDocTitle);
                const para = titles.slice(0, 2).join(" · ") + (titles.length > 2 ? ` +${titles.length - 2}` : "");
                return (
                  <div key={c.id} className={"ai-hist-item" + (c.id === convId ? " active" : "")}>
                    <button type="button" className="ai-hist-open" onClick={() => { void openConv(c.id); }}>
                      <span className="ai-hist-title od-truncate">{c.title}</span>
                      <span className="ai-hist-meta od-truncate">{para ? para + " · " : ""}{c.count} 问 · {fmtConvTime(c.updated_at)}</span>
                    </button>
                    <button type="button" className="icon-btn" title="删除" onClick={() => { void delConv(c.id); }}><Icon name="trash" small /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className={"ai-scroll" + (anchors.length >= 2 ? " has-qnav" : "")} ref={scrollRef} onScroll={onScroll} onMouseUp={onAnswerMouseUp}>
        {turns.length === 0 ? (
          <div className="ai-intro">
            <div className="ai-mark"><Icon name="arxiver" /></div>
            <h3>向 Arxiver 提问</h3>
            <p>会自动判断该读《{doc.title}》还是检索整库，需要时跨文献查找或反问你；回答带可点击引用。涉及修改（如标签、元数据）会先请你批准。</p>
            {!aiReady ? (
              <div className="ai-setup-note">
                <Icon name="settings" small />
                <span>还没配置对话模型：先填好基础地址、API 密钥与模型才能提问。</span>
                <button type="button" className="btn btn-primary" onClick={openAiSettings}>去设置</button>
              </div>
            ) : null}
            <div className="ai-suggest">
              <button onClick={() => send("总结核心贡献")}>总结核心贡献</button>
              <button onClick={() => send("解释主要方法")}>解释主要方法</button>
              <button onClick={() => send("分析局限性")}>分析局限性</button>
            </div>
            <div className="ai-skill-quick">
              <div className="ai-skill-quick-head">
                <span><Icon name="sparkle" small />技能</span>
                <button type="button" className="ai-skill-manage" onClick={() => { setShowSkills(true); setShowHistory(false); }}>管理</button>
              </div>
              {skills.length ? (
                <div className="ai-skill-quick-list">
                  {skills.slice(0, 4).map((s) => {
                    const on = attached.includes(s.id);
                    return (
                      <button key={s.id} type="button" className={"ai-skill-quick-chip" + (on ? " is-on" : "")} title={s.description || s.name} onClick={() => toggleSkill(s.id)}>
                        {on ? <Icon name="check" small /> : null}{s.name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <button type="button" className="ai-skill-quick-empty" onClick={() => { setShowSkills(true); setShowHistory(false); }}>
                  把常用的提示词 / 流程存成技能，之后一键启用
                </button>
              )}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} ref={(el) => { msgRefs.current[i] = el; }} className={"msg " + (t.role === "user" ? "msg-user" : "msg-assistant")}>
              <div className="msg-body">
                <div className="msg-role">{t.role === "user" ? "我" : "Arxiver"}</div>
                {t.role === "user" ? (
                  <>
                    {t.skills && t.skills.length ? (
                      <div className="msg-skills">
                        {t.skills.map((id) => {
                          const name = skillName(id);
                          return name ? <span key={id} className="msg-skill-chip"><Icon name="sparkle" small />{name}</span> : null;
                        })}
                      </div>
                    ) : null}
                    {t.text ? <div className="msg-content">{t.text}</div> : null}
                    {t.images && t.images.length ? (
                      <div className="msg-imgs">
                        {t.images.map((src, k) => <img key={k} src={src} alt={`附图 ${k + 1}`} />)}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {(() => {
                      const blocks = t.blocks || [];
                      const lastPapers = blocks.reduce((acc, b, i) => (b.kind === "papers" ? i : acc), -1);
                      const hasText = blocks.some((b) => b.kind === "text");
                      return blocks.map((b, bi) => {
                        if (b.kind === "reasoning") {
                          return (
                            <details key={bi} className="ai-reasoning" open={!!(t.streaming && !hasText)}>
                              <summary>思考过程</summary>
                              <div className="ai-reasoning-body">{b.text}</div>
                            </details>
                          );
                        }
                        if (b.kind === "confirm") {
                          return b.items.map((c) => <ConfirmCard key={c.confirmId} item={c} onDecide={decide} />);
                        }
                        if (b.kind === "read") {
                          return (
                            <div key={bi} className="read-block">
                              {b.items.map((r, j) => (
                                <div key={j} className="read-line" title={`${r.title || ""}${r.title ? " · " : ""}${r.url}${r.via ? ` · ${r.via}` : ""}`}>
                                  <Icon name="book" small />
                                  <span className="read-label">已读正文</span>
                                  <span className="read-title">{r.title || r.domain}</span>
                                  <span className="read-meta">{r.domain}{r.chars ? ` · ${(r.chars / 1000).toFixed(1)}k 字` : ""}</span>
                                  <div className="od-fill" />
                                  <button type="button" className="read-open" title="在浏览器打开" onClick={() => { void window.api.openExternal(r.url); }}><Icon name="external" small /></button>
                                </div>
                              ))}
                            </div>
                          );
                        }
                        if (b.kind === "tools") {
                          const pending = b.items.filter((x) => x.content === undefined).length;
                          const running = [...b.items].reverse().find((x) => x.content === undefined);
                          return (
                            <details key={bi} className="ai-tools" open={pending > 0}>
                              <summary>
                                工具调用（{b.items.length}）
                                {pending > 0 ? <span className="ai-tool-run">运行中…</span> : null}
                                {running?.progress ? <span className="ai-tool-progress"> · {running.progress}</span> : null}
                              </summary>
                              {b.items.map((tool, j) => (
                                <div key={j} className="ai-tool">
                                  {tool.content === undefined ? <span className="spinner" /> : null}
                                  <span className="ai-tool-name">{tool.name}</span>
                                  {tool.content === undefined && tool.progress ? <span className="ai-tool-progress">{tool.progress}</span> : null}
                                  {tool.args ? <span className="ai-tool-args">{tool.args}</span> : null}
                                </div>
                              ))}
                            </details>
                          );
                        }
                        if (b.kind === "papers") {
                          const key = i + ":" + bi;
                          return (
                            <PaperBlock
                              key={bi}
                              papers={b.items}
                              open={paperOpen[key] ?? (bi === lastPapers)}
                              onToggle={() => setPaperOpen((s) => ({ ...s, [key]: !(s[key] ?? (bi === lastPapers)) }))}
                              onJumped={jumped}
                              state={imp}
                              progress={libProgress}
                              inLibrary={docIdOfPaper}
                              onImport={importPaper}
                              onOpen={(u) => { void window.api.openExternal(u); }}
                            />
                          );
                        }
                        return <div key={bi} className="msg-content ai-md"><Markdown text={b.text} onCite={onCite} onCard={jumpToCard} /></div>;
                      });
                    })()}
                    {t.error ? <div className="ai-error">{t.error}</div> : null}
                    {t.stopped ? (
                      <div className="ai-stopped">
                        <span>已暂停生成</span>
                        <button type="button" onClick={() => editQuestion(i)}>重新编辑问题</button>
                      </div>
                    ) : null}
                    {t.setup ? (
                      <div className="ai-setup">
                        <button type="button" className="btn btn-primary" onClick={openAiSettings}><Icon name="settings" small /> 打开设置</button>
                      </div>
                    ) : null}
                    {(() => {
                      const pend = toolsOf(t.blocks || []).filter((x) => x.content === undefined);
                      if (!pend.length) { return null; }
                      const last = pend[pend.length - 1];
                      const secs = Math.max(0, Math.round((Date.now() - (last.at || Date.now())) / 1000));
                      return (
                        <div className="ai-running">
                          <span className="spinner" />
                          <span className="ai-running-name">正在执行 {last.name}…</span>
                          {last.progress ? <span className="ai-running-hint">{last.progress}</span> : null}
                          <div className="od-fill" />
                          <span className="ai-running-time">已 {secs}s</span>
                        </div>
                      );
                    })()}
                    {t.streaming && !t.text ? <span className="typing"><i /><i /><i /></span> : null}
                    {t.usage ? <div className="ai-usage">tokens: {t.usage.prompt_tokens}+{t.usage.completion_tokens}</div> : null}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {selAsk && (
        <button
          type="button"
          className="btw-sel-ask"
          style={{ left: selAsk.left, top: selAsk.top }}
          title="就选中内容另开小窗提问，不写入主对话"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const text = selAsk.text;
            window.getSelection()?.removeAllRanges();
            openBtw("", text);
          }}
        >
          <Icon name="message" small /> 顺便问
        </button>
      )}
      {showJump && (
        <button type="button" className="ai-jump" title="回到底部" onClick={jumpToBottom}><Icon name="chev-down" small /></button>
      )}
      {anchors.length >= 2 && (
        <QuestionNav anchors={anchors} anchorsRef={anchorsRef} msgRefs={msgRefs} scrollRef={scrollRef} onGoto={gotoMsg} />
      )}
      <div className="ai-composer">
        {atOpen && (
          <div className="ai-at-pop">
            {atOptions.length === 0
              ? <div className="ai-hist-empty">没有其它已打开的文献</div>
              : atOptions.map((d) => <button key={d.id} type="button" className="ai-at-item" onClick={() => pickRef(d)}>@ {d.name}</button>)}
          </div>
        )}
        {(selection && selection.text.trim()) || refs.length > 0 || images.length > 0 || attached.length > 0 ? (
          <div className="ai-refs">
            {attached.map((id) => {
              const s = skills.find((x) => x.id === id);
              if (!s) { return null; }
              return (
                <span key={id} className="ai-ref-chip ai-skill-chip" title={s.description || s.name}>
                  <Icon name="sparkle" small />{s.name}
                  <button type="button" className="ai-ref-x" title="取消启用" onClick={() => toggleSkill(id)}><Icon name="x" small /></button>
                </span>
              );
            })}
            {selection && selection.text.trim() ? (
              <span className="ai-ref-chip">选文（第 {selection.page} 页）：{selection.text.trim().slice(0, 40)}
                <button type="button" className="ai-ref-x" title="移除" onClick={onClearSelection}><Icon name="x" small /></button>
              </span>
            ) : null}
            {refs.map((r) => (
              <span key={r.id} className="ai-ref-chip">@{r.title}
                <button type="button" className="ai-ref-x" title="移除" onClick={() => setRefs((prev) => prev.filter((x) => x.id !== r.id))}><Icon name="x" small /></button>
              </span>
            ))}
            {images.map((img, k) => (
              <span key={img.id} className="ai-img-chip" title={img.page ? `第 ${img.page} 页截图` : "粘贴 / 选择的图片"}>
                <img src={img.dataUrl} alt="" />
                <span className="ai-img-label">{img.page ? `第 ${img.page} 页` : `图片 ${k + 1}`}</span>
                <button type="button" className="ai-ref-x" title="移除" onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}><Icon name="x" small /></button>
              </span>
            ))}
          </div>
        ) : null}
        {images.length > 0 && visionBlocked ? (
          <div className="ai-img-warn">
            <span>当前对话模型「{config?.chat_model}」不支持图片输入，请改为 deepseek-flash</span>
            <button type="button" onClick={openAiSettings}>去设置</button>
          </div>
        ) : null}
        <form
          className="composer-box"
          onSubmit={(e) => { e.preventDefault(); send(); }}
          onMouseDown={(e) => {
            // 点输入框区域的空白处也聚焦到输入框（按钮/引用胶囊等仍走各自逻辑）
            const t = e.target as HTMLElement | null;
            if (t && t.closest && t.closest("button, textarea, a, select, input")) { return; }
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <textarea
            ref={inputRef}
            placeholder="随心输入，@ 引用已打开文献；/btw 另开小窗问；可粘贴 / 上传图片"
            rows={1}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              if (v.endsWith("@")) { setInput(v.slice(0, -1)); setAtOpen(true); }
              else { setAtOpen(false); setInput(v); }
            }}
            onKeyDown={(e) => { if (e.key === "Escape") { setAtOpen(false); } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div className="composer-row">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; void addImageFiles(files); }}
            />
            <button
              type="button"
              className="composer-icon-btn"
              title="添加图片（也可直接 Ctrl+V 粘贴）"
              onClick={(e) => { e.preventDefault(); fileRef.current?.click(); }}
            >
              <Icon name="image" small />
            </button>
            <button
              type="button"
              className="composer-icon-btn"
              title="顺便问一下（/btw）：另开小窗，不写入主对话"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                const picked = window.getSelection();
                const pickedText = picked && !picked.isCollapsed ? picked.toString().replace(/\s+/g, " ").trim() : "";
                const q = input.trim();
                if (q) { setInput(""); }
                openBtw(q, pickedText || (selection?.text.trim() || ""));
              }}
            >
              <Icon name="message" small />
            </button>
            <span className="od-fill" />
            {sending
              ? <button type="button" className="send-btn" title="停止" onClick={(e) => { e.preventDefault(); stop(); }}><Icon name="x" small /></button>
              : <button type="submit" className="send-btn" aria-label="发送" disabled={!input.trim() && images.length === 0 && attached.length === 0}><Icon name="arrow-up" small /></button>}
          </div>
        </form>
      </div>
      {btwSeed && (
        <BtwPanel
          key={btwSeed.id}
          seed={btwSeed}
          docId={doc.id}
          docTitle={doc.title}
          aiReady={aiReady}
          onClose={() => setBtwSeed(null)}
          onCite={onCite}
          onCard={jumpToCard}
          onOpenSettings={openAiSettings}
        />
      )}
    </div>
  );
}

function DocPreview({ doc }: { doc: LibraryDoc }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const docRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    docRef.current = null;
    setNumPages(0);
    setPage(1);
    (async () => {
      try {
        const data = await window.api.libraryOpen(doc.id);
        if (!data.bytes) { return; }
        const pdfjs = await getPdfjs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.bytes) }).promise;
        if (cancelled) { return; }
        docRef.current = pdf;
        setNumPages(pdf.numPages);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [doc.id]);

  useEffect(() => {
    const pdf = docRef.current;
    if (!pdf) { return; }
    let cancelled = false;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) { return; }
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: (300 * zoom) / base.width });
      const canvas = canvasRef.current;
      if (!canvas) { return; }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    })();
    return () => { cancelled = true; };
  }, [numPages, page, zoom]);

  return (
    <div className="reader reader-inline">
      <div className="reader-stage">
        {numPages === 0
          ? <span style={{ color: "var(--faint)", fontSize: 12 }}>正在生成预览…</span>
          : <canvas ref={canvasRef} style={{ display: "block", margin: "0 auto", background: "#fff", boxShadow: "0 10px 26px rgba(0,0,0,.5)" }} />}
      </div>
      <div className="reader-toolbar">
        <button className="icon-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><Icon name="chev-left" small /></button>
        <span className="pill">{page} / {numPages || "?"}</span>
        <button className="icon-btn" disabled={page >= numPages} onClick={() => setPage((p) => Math.min(numPages, p + 1))}><Icon name="chev-right" small /></button>
        <span className="od-fill" />
        <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}><Icon name="zoom-out" small /></button>
        <span className="pill zoom-val">{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" onClick={() => setZoom((z) => Math.min(2, z + 0.2))}><Icon name="zoom-in" small /></button>
        <button className="icon-btn" onClick={() => setZoom(1)}><Icon name="expand" small /></button>
      </div>
    </div>
  );
}
