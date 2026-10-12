import { useEffect, useRef, useState, type JSX, type MutableRefObject } from "react";
import type { LibraryDoc, Conversation, ConversationSummary } from "../../../shared/types";
import { Icon } from "./Icons";
import { formatDate } from "../lib/format";
import { getPdfjs } from "../lib/pdf";
import type { LibraryApi } from "../state/useLibrary";
import { tagColor } from "../state/tagColors";
import type { AppSettings } from "../state/settings";
import { Markdown } from "../lib/markdown";

function arxivId(url: string): string {
  const match = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(String(url || ""));
  return match ? "arXiv:" + match[1] : "";
}

function docKind(doc: LibraryDoc): string {
  return doc.type || (/arxiv/i.test(doc.sourceUrl || "") ? "预印本" : "文档");
}

function TagChip({ tag, lib }: { tag: string; lib: LibraryApi }): JSX.Element {
  return (
    <button className="tag" onClick={() => lib.setTag(tag)}>
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
  aiSelection,
  onCite,
  onClearSelection,
  openDocs
}: {
  lib: LibraryApi;
  onOpen: (doc: LibraryDoc) => void;
  settings: AppSettings;
  aiSelection?: { text: string; page: number } | null;
  onCite?: (docId: string, page: number) => void;
  onClearSelection?: () => void;
  openDocs?: { id: string; name: string }[];
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
        ) : (
          <div className={"tab-panel" + (lib.tab === "ai" ? " ai-tab" : "")}>
            {lib.tab === "info" && (lib.editMode
              ? <InfoEdit lib={lib} doc={doc} />
              : <InfoDisplay lib={lib} doc={doc} onOpenView={openDoc} citeDoi={settings.citeDoi} />)}
            {lib.tab === "notes" && <NotesPanel lib={lib} doc={doc} />}
            {lib.tab === "tags" && <TagsPanel lib={lib} doc={doc} />}
            {lib.tab === "ai" && settings.aiEnabled && <AiPanel doc={doc} settings={settings} selection={aiSelection} onCite={onCite || (() => {})} onClearSelection={onClearSelection || (() => {})} openDocs={openDocs || []} resolveDocTitle={(id) => lib.documents.find((d) => d.id === id)?.title || id} />}
          </div>
        )}
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
          : all.map((t) => <TagChip key={t} tag={t} lib={lib} />)}
      </div>
    </>
  );
}

interface AiToolTrace { name: string; args?: string; content?: string }
interface AiConfirm { confirmId: string; name: string; args: string; status: "pending" | "approved" | "rejected" }
interface AiTurn {
  role: "user" | "assistant";
  text: string;
  tools?: AiToolTrace[];
  confirmations?: AiConfirm[];
  reasoning?: string;
  error?: string;
  streaming?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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

function convAnchors(list: AiTurn[]): NavAnchor[] {
  const runs: { first: number; last: number; text: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].role !== "user" || !list[i].text.trim()) { continue; }
    const prev = runs[runs.length - 1];
    if (prev && prev.last === i - 1) { prev.last = i; prev.text += " / " + list[i].text.trim(); }
    else { runs.push({ first: i, last: i, text: list[i].text.trim() }); }
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

function AiPanel({ doc, settings, selection, onCite, onClearSelection, openDocs, resolveDocTitle }: {
  doc: LibraryDoc;
  settings: AppSettings;
  selection?: { text: string; page: number } | null;
  onCite: (docId: string, page: number) => void;
  onClearSelection: () => void;
  openDocs: { id: string; name: string }[];
  resolveDocTitle: (id: string) => string;
}): JSX.Element {
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [convId, setConvId] = useState("");
  const [convList, setConvList] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [refs, setRefs] = useState<{ id: string; title: string }[]>([]);
  const [atOpen, setAtOpen] = useState(false);
  const [histQuery, setHistQuery] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnRef = useRef("");
  const turnsRef = useRef<AiTurn[]>([]);
  const convIdRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
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
    const clean = messages.filter((m) => m.text.trim() || m.error || (m.tools && m.tools.length > 0) || (m.confirmations && m.confirmations.length > 0));
    const docIds = new Set<string>();
    if (doc.id) { docIds.add(doc.id); }
    for (const m of messages) {
      for (const t of m.tools || []) {
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
      title: (firstUser?.text || "新对话").slice(0, 60),
      updated_at: 0,
      messages: clean.map((m) => ({ role: m.role, text: m.text, tools: m.tools, reasoning: m.reasoning, error: m.error, usage: m.usage }))
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
        if (!cancelled && conv) { setTurns(conv.messages as AiTurn[]); setConvId(conv.id); convIdRef.current = conv.id; }
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
      if (e.turnId !== turnRef.current) { return; }
      setTurns((prev) => {
        if (prev.length === 0) { return prev; }
        const next = prev.slice();
        const i = next.length - 1;
        const cur: AiTurn = { ...next[i] };
        if (e.type === "delta" && e.text) { cur.text += e.text; }
        else if (e.type === "reasoning" && e.text) { cur.reasoning = (cur.reasoning || "") + e.text; }
        else if (e.type === "tool_call") { cur.tools = [...(cur.tools || []), { name: e.name || "", args: e.args }]; }
        else if (e.type === "tool_result") {
          const tools = (cur.tools || []).slice();
          for (let j = tools.length - 1; j >= 0; j--) { if (tools[j].name === e.name && tools[j].content === undefined) { tools[j] = { ...tools[j], content: e.content }; break; } }
          cur.tools = tools;
        }
        else if (e.type === "confirmation") { cur.confirmations = [...(cur.confirmations || []), { confirmId: e.confirmId || "", name: e.name || "", args: e.args || "{}", status: "pending" }]; }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const send = (preset?: string): void => {
    const q = (preset !== undefined ? preset : input).trim();
    if (!q || sending) { return; }
    if (!convIdRef.current) {
      const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      convIdRef.current = id;
      setConvId(id);
    }
    setInput("");
    atBottomRef.current = true;
    setShowJump(false);
    const history = turnsRef.current
      .filter((t) => t.text.trim())
      .map((t) => ({ role: t.role, content: t.text }));
    setTurns((prev) => [...prev, { role: "user", text: q }, { role: "assistant", text: "", streaming: true }]);
    setSending(true);
    const sel = selection ? selection : undefined;
    const refIds = refs.map((r) => r.id);
    setRefs([]);
    setAtOpen(false);
    void window.api.agentChat({ scope: "library", docId: doc.id, selection: sel, refs: refIds, message: q, history })
      .then(({ turnId }) => { turnRef.current = turnId; })
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

  const stop = (): void => { if (turnRef.current) { void window.api.agentCancel(turnRef.current); } };

  const atOptions = openDocs.filter((d) => d.id !== doc.id);
  const anchors = convAnchors(turns);
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
    setTurns((prev) => prev.map((t) => t.confirmations
      ? { ...t, confirmations: t.confirmations.map((c) => c.confirmId === confirmId ? { ...c, status: approved ? "approved" : "rejected", args: args ?? c.args } : c) }
      : t));
    void window.api.agentConfirm(confirmId, { approved, args });
  };

  const newConv = (): void => { setTurns([]); setConvId(""); convIdRef.current = ""; setShowHistory(false); };
  const openConv = async (id: string): Promise<void> => {
    const conv = await window.api.agentConversation(id);
    if (conv) { setTurns(conv.messages as AiTurn[]); setConvId(conv.id); convIdRef.current = conv.id; }
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
        <div className="ai-hist-wrap">
          <button type="button" className="icon-btn" title="历史对话" onClick={() => setShowHistory((v) => !v)}><Icon name="history" small /></button>
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
      <div className="ai-scroll" ref={scrollRef} onScroll={onScroll}>
        {turns.length === 0 ? (
          <div className="ai-intro">
            <div className="ai-mark"><Icon name="arxiver" /></div>
            <h3>向 Arxiver 提问</h3>
            <p>会自动判断该读《{doc.title}》还是检索整库，需要时跨文献查找或反问你；回答带可点击引用。涉及修改（如标签、元数据）会先请你批准。</p>
            <div className="ai-suggest">
              <button onClick={() => send("总结核心贡献")}>总结核心贡献</button>
              <button onClick={() => send("解释主要方法")}>解释主要方法</button>
              <button onClick={() => send("分析局限性")}>分析局限性</button>
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} ref={(el) => { msgRefs.current[i] = el; }} className={"msg " + (t.role === "user" ? "msg-user" : "msg-assistant")}>
              <div className="msg-avatar">{t.role === "user" ? "我" : <Icon name="arxiver" small />}</div>
              <div className="msg-body">
                <div className="msg-role">{t.role === "user" ? "我" : "Arxiver"}</div>
                {t.role === "user" ? (
                  <div className="msg-content">{t.text}</div>
                ) : (
                  <>
                    {t.reasoning ? (
                      <details className="ai-reasoning" open={!!(t.streaming && !t.text)}>
                        <summary>思考过程</summary>
                        <div className="ai-reasoning-body">{t.reasoning}</div>
                      </details>
                    ) : null}
                    {t.confirmations && t.confirmations.map((c) => <ConfirmCard key={c.confirmId} item={c} onDecide={decide} />)}
                    {t.tools && t.tools.length > 0 && (
                      <details className="ai-tools">
                        <summary>工具调用（{t.tools.length}）</summary>
                        {t.tools.map((tool, j) => (
                          <div key={j} className="ai-tool"><span className="ai-tool-name">{tool.name}</span>{tool.args ? <span className="ai-tool-args">{tool.args}</span> : null}</div>
                        ))}
                      </details>
                    )}
                    <div className="msg-content ai-md"><Markdown text={t.text} onCite={onCite} /></div>
                    {t.error ? <div className="ai-error">{t.error}</div> : null}
                    {t.streaming && !t.text ? <span className="typing"><i /><i /><i /></span> : null}
                    {t.usage ? <div className="ai-usage">tokens: {t.usage.prompt_tokens}+{t.usage.completion_tokens}</div> : null}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
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
        {(selection && selection.text.trim()) || refs.length > 0 ? (
          <div className="ai-refs">
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
          </div>
        ) : null}
        <form className="composer-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea
            ref={inputRef}
            placeholder="随心输入，@ 引用已打开的文献"
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
            <span className="od-fill" />
            {sending
              ? <button type="button" className="send-btn" title="停止" onClick={stop}><Icon name="x" small /></button>
              : <button type="submit" className="send-btn" aria-label="发送" disabled={!input.trim()}><Icon name="arrow-up" small /></button>}
          </div>
        </form>
      </div>
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
