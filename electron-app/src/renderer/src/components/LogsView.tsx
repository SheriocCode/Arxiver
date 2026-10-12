import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { Conversation, ConversationSummary, SystemLogEntry, TranslationLogEntry } from "../../../shared/types";
import { Icon } from "./Icons";

const TITLES: Record<string, string> = { tlog: "翻译日志", ailog: "AI对话日志", syslog: "系统运行日志" };

function fmtTime(ms?: number | null): string {
  if (!ms) { return "—"; }
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtClock(ms?: number | null): string {
  if (!ms) { return "—"; }
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtBytes(n?: number): string {
  if (!n) { return "—"; }
  if (n < 1024) { return n + " B"; }
  if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
  if (n < 1024 * 1024 * 1024) { return (n / 1024 / 1024).toFixed(1) + " MB"; }
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function fmtDuration(ms?: number): string {
  if (ms == null) { return "—"; }
  if (ms < 1000) { return ms + " ms"; }
  const s = ms / 1000;
  if (s < 60) { return s.toFixed(1) + " s"; }
  return Math.floor(s / 60) + " 分 " + Math.round(s % 60) + " 秒";
}
function prettyArgs(raw?: string): string {
  if (!raw) { return "（无参数）"; }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Head({ title, count, onClose, right }: { title: string; count: number; onClose: () => void; right?: JSX.Element }): JSX.Element {
  return (
    <div className="hist-head">
      <div className="hist-heading">
        <h2>{title}</h2>
        <span className="hist-badge">{count} 条</span>
      </div>
      <div className="hist-head-right">
        {right}
        <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" small /></button>
      </div>
    </div>
  );
}

function Pane({ list, detail }: { list: JSX.Element; detail: JSX.Element }): JSX.Element {
  return (
    <div className="hist-body">
      <div className="hist-main">{list}</div>
      <div className="hist-detail">{detail}</div>
    </div>
  );
}

/* ---------------------------------- 翻译日志 ---------------------------------- */

const T_STATUS: Record<string, { label: string; slug: string }> = {
  done: { label: "已完成", slug: "task" },
  running: { label: "进行中", slug: "tool" },
  queued: { label: "排队中", slug: "tool" },
  failed: { label: "失败", slug: "sys" }
};

function TranslationLog({ logStatus, onClose }: { logStatus: string; onClose: () => void }): JSX.Element {
  const [entries, setEntries] = useState<TranslationLogEntry[]>([]);
  const [selId, setSelId] = useState("");

  const load = useCallback((): void => {
    void window.api.logsTranslation().then((d) => {
      setEntries(d);
      setSelId((cur) => (d.some((x) => x.id === cur) ? cur : d[0]?.id || ""));
    });
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => entries.filter((e) => {
    if (logStatus === "all") { return true; }
    if (logStatus === "running") { return e.status === "running" || e.status === "queued"; }
    return e.status === logStatus;
  }), [entries, logStatus]);

  const sel = filtered.find((x) => x.id === selId) || filtered[0];

  return (
    <section className="history" aria-label="日志">
      <Head
        title={TITLES.tlog}
        count={filtered.length}
        onClose={onClose}
        right={<button className="btn btn-ghost" onClick={load}><Icon name="history" small /> 刷新</button>}
      />
      {!sel ? (
        <div className="hist-empty">暂无记录</div>
      ) : (
        <Pane
          list={
            <div className="hist-log">
              {filtered.map((e) => {
                const st = T_STATUS[e.status] || T_STATUS.done;
                return (
                  <button key={e.id} className={"hist-step" + (e.id === sel.id ? " is-selected" : "")} onClick={() => setSelId(e.id)}>
                    <span className={"hist-step-dot kind-" + st.slug} />
                    <span className={"hist-step-kind kind-" + st.slug}>{st.label}</span>
                    <span className="hist-step-main">
                      <span className="hist-step-name">{e.name}</span>
                      <span className="hist-step-note">{[e.targetLang, e.service, e.pages && e.pages + " 页"].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="hist-step-time">{fmtClock(e.created_at)}</span>
                  </button>
                );
              })}
            </div>
          }
          detail={
            <>
              <div className="hist-detail-head">
                <span className={"hist-step-kind kind-" + (T_STATUS[sel.status] || T_STATUS.done).slug}>{(T_STATUS[sel.status] || T_STATUS.done).label}</span>
                <span className="hist-detail-title">{sel.name}</span>
              </div>
              <div className="hist-detail-body">
                <dl className="hist-meta">
                  <dt>文件</dt><dd>{sel.name}</dd>
                  <dt>源文件</dt><dd>{sel.sourceName || "—"}</dd>
                  <dt>目标语言</dt><dd>{sel.targetLang || "—"}</dd>
                  <dt>服务</dt><dd>{sel.service || "—"}</dd>
                  <dt>输出</dt><dd>{sel.variant || "—"}</dd>
                  <dt>页数</dt><dd>{sel.pages || (sel.totalPages ? `${sel.donePages}/${sel.totalPages}` : "—")}</dd>
                  <dt>大小</dt><dd>{fmtBytes(sel.size)}</dd>
                  <dt>开始</dt><dd>{fmtTime(sel.created_at)}</dd>
                  <dt>完成</dt><dd>{sel.finished_at ? fmtTime(sel.finished_at) : "—"}</dd>
                  {sel.status === "running" && <><dt>进度</dt><dd>{sel.progress != null ? Math.round(sel.progress * 100) + "%" : `${sel.donePages}/${sel.totalPages}`}</dd></>}
                  {sel.message && <><dt>信息</dt><dd>{sel.message}</dd></>}
                  {sel.sourceUrl && <><dt>来源</dt><dd className="hist-wrap">{sel.sourceUrl}</dd></>}
                </dl>
                {sel.docId && (
                  <div className="hist-actions">
                    <button className="btn btn-ghost" onClick={() => { void window.api.libraryReveal(sel.docId); }}><Icon name="external" small /> 在资源管理器中显示</button>
                  </div>
                )}
              </div>
            </>
          }
        />
      )}
    </section>
  );
}

/* -------------------------------- 系统运行日志 -------------------------------- */

const LEVELS: Record<string, { label: string; slug: string }> = {
  info: { label: "信息", slug: "tool" },
  warn: { label: "警告", slug: "task" },
  error: { label: "错误", slug: "sys" }
};

function SystemLog({ logStatus, onClose }: { logStatus: string; onClose: () => void }): JSX.Element {
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const [file, setFile] = useState("");
  const [selIdx, setSelIdx] = useState(0);

  const load = useCallback((): void => {
    void window.api.logsSystem().then((d) => { setEntries(d.entries); setFile(d.file); });
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => (logStatus === "all" ? entries : entries.filter((e) => e.level === logStatus)), [entries, logStatus]);
  const sel = filtered[Math.min(selIdx, Math.max(0, filtered.length - 1))];

  return (
    <section className="history" aria-label="日志">
      <Head
        title={TITLES.syslog}
        count={filtered.length}
        onClose={onClose}
        right={
          <>
            <button className="btn btn-ghost" onClick={() => { if (file) { void window.api.openPath(file); } }}><Icon name="file" small /> 日志文件</button>
            <button className="btn btn-ghost" onClick={load}><Icon name="history" small /> 刷新</button>
          </>
        }
      />
      {!sel ? (
        <div className="hist-empty">暂无记录</div>
      ) : (
        <Pane
          list={
            <div className="hist-log">
              {filtered.map((e, i) => (
                <button key={`${e.at}-${i}`} className={"hist-step" + (i === selIdx ? " is-selected" : "")} onClick={() => setSelIdx(i)}>
                  <span className={"hist-step-dot kind-" + (LEVELS[e.level] || LEVELS.info).slug} />
                  <span className={"hist-step-kind kind-" + (LEVELS[e.level] || LEVELS.info).slug}>{(LEVELS[e.level] || LEVELS.info).label}</span>
                  <span className="hist-step-main">
                    <span className="hist-step-name">{e.scope}</span>
                    <span className="hist-step-text od-truncate">{e.message}</span>
                  </span>
                  <span className="hist-step-time">{fmtClock(e.at)}</span>
                </button>
              ))}
            </div>
          }
          detail={
            <>
              <div className="hist-detail-head">
                <span className={"hist-step-kind kind-" + (LEVELS[sel.level] || LEVELS.info).slug}>{(LEVELS[sel.level] || LEVELS.info).label}</span>
                <span className="hist-detail-title">{sel.scope}</span>
              </div>
              <div className="hist-detail-body">
                <dl className="hist-meta">
                  <dt>时间</dt><dd>{fmtTime(sel.at)}</dd>
                  <dt>级别</dt><dd>{(LEVELS[sel.level] || LEVELS.info).label}</dd>
                  <dt>模块</dt><dd>{sel.scope}</dd>
                </dl>
                <div className="hist-code hist-wrap">{sel.message}</div>
              </div>
            </>
          }
        />
      )}
    </section>
  );
}

/* -------------------------------- AI 对话日志 -------------------------------- */

type Kind = "user" | "tool" | "assistant";
interface Step { kind: Kind; name?: string; text?: string; args?: string; result?: string; at?: number; ms?: number; usage?: string }

const KIND_META: Record<Kind, { label: string; slug: string }> = {
  user: { label: "用户", slug: "user" },
  tool: { label: "工具", slug: "tool" },
  assistant: { label: "助手", slug: "assistant" }
};
const AI_TABS = ["概述", "参数", "结果", "计时"] as const;

function toSteps(conv: Conversation): Step[] {
  const out: Step[] = [];
  for (const m of conv.messages || []) {
    if (m.role === "user") {
      out.push({ kind: "user", text: m.text });
      continue;
    }
    for (const t of m.tools || []) {
      out.push({ kind: "tool", name: t.name, args: t.args, result: t.content, at: t.at, ms: t.ms });
    }
    out.push({
      kind: "assistant",
      text: m.text || (m.tools?.length ? "（仅工具调用）" : ""),
      at: (m.tools || []).reduce<number | undefined>((acc, t) => acc ?? t.at, undefined),
      usage: m.usage ? `${m.usage.prompt_tokens} → ${m.usage.completion_tokens}（共 ${m.usage.total_tokens} tokens）` : undefined
    });
  }
  return out;
}

function AiLog({ logStatus, onClose }: { logStatus: string; onClose: () => void }): JSX.Element {
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const [tab, setTab] = useState<(typeof AI_TABS)[number]>("概述");

  const load = useCallback((): void => {
    void Promise.all([
      window.api.agentConversations({ scope: "library" }),
      window.api.agentConversations({ scope: "paper" })
    ]).then(([a, b]) => {
      const list = [...a, ...b].sort((x, y) => y.updated_at - x.updated_at);
      setConvs(list);
    });
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => (logStatus === "all" ? convs : convs.filter((c) => c.scope === logStatus)), [convs, logStatus]);
  const cur = filtered.find((c) => c.id === conv?.id) || filtered[0];

  useEffect(() => {
    if (!cur) { setConv(null); return; }
    let cancelled = false;
    void window.api.agentConversation(cur.id).then((c) => { if (!cancelled) { setConv(c); setSelIdx(0); setTab("概述"); } });
    return () => { cancelled = true; };
  }, [cur?.id]);

  const steps = useMemo(() => (conv ? toSteps(conv) : []), [conv]);
  const sel = steps[Math.min(selIdx, Math.max(0, steps.length - 1))];

  return (
    <section className="history" aria-label="日志">
      <Head
        title={TITLES.ailog}
        count={filtered.length}
        onClose={onClose}
        right={<button className="btn btn-ghost" onClick={load}><Icon name="history" small /> 刷新</button>}
      />
      {!cur ? (
        <div className="hist-empty">暂无对话记录</div>
      ) : (
        <div className="hist-body hist-ai">
          <div className="hist-convs">
            {filtered.map((c) => (
              <button key={c.id} className={"hist-conv" + (c.id === cur.id ? " is-selected" : "")} onClick={() => setSelIdx(0)}>
                <span className="hist-conv-title od-truncate">{c.title || "新对话"}</span>
                <span className="hist-conv-meta">{c.scope === "paper" ? "论文" : "文库"} · {c.count} 轮 · {fmtClock(c.updated_at * 1000)}</span>
              </button>
            ))}
          </div>
          <div className="hist-main">
            <div className="hist-log">
              {steps.map((s, i) => (
                <button key={i} className={"hist-step" + (i === selIdx ? " is-selected" : "")} onClick={() => { setSelIdx(i); setTab("概述"); }}>
                  <span className={"hist-step-dot kind-" + KIND_META[s.kind].slug} />
                  <span className={"hist-step-kind kind-" + KIND_META[s.kind].slug}>{KIND_META[s.kind].label}</span>
                  <span className="hist-step-main">
                    {s.kind === "tool"
                      ? (
                        <>
                          <span className="hist-step-name">{s.name}</span>
                          <span className="hist-step-args od-truncate">{s.args || ""}</span>
                        </>
                      )
                      : <span className="hist-step-text od-truncate">{s.text}</span>}
                  </span>
                  <span className="hist-step-time">{s.kind === "tool" ? fmtDuration(s.ms) : ""}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="hist-detail">
            {!sel ? <div className="hist-empty">这条对话没有记录步骤</div> : (
              <>
                <div className="hist-detail-head">
                  <span className={"hist-step-kind kind-" + KIND_META[sel.kind].slug}>{KIND_META[sel.kind].label}</span>
                  <span className="hist-detail-title">第 {selIdx + 1} 步 / 共 {steps.length} 步</span>
                </div>
                <div className="hist-detail-tabs" role="tablist">
                  {AI_TABS.map((x) => <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)}>{x}</button>)}
                </div>
                <div className="hist-detail-body">
                  {tab === "概述" && (
                    <dl className="hist-meta">
                      <dt>类型</dt><dd>{KIND_META[sel.kind].label}</dd>
                      <dt>名称</dt><dd>{sel.name || "（消息）"}</dd>
                      <dt>所属对话</dt><dd>{conv?.title || cur.title || "—"}</dd>
                      <dt>范围</dt><dd>{(conv?.scope || cur.scope) === "paper" ? "论文对话" : "文库对话"}</dd>
                      {sel.usage && <><dt>Token</dt><dd>{sel.usage}</dd></>}
                    </dl>
                  )}
                  {tab === "参数" && <pre className="hist-code">{prettyArgs(sel.args)}</pre>}
                  {tab === "结果" && <div className="hist-code hist-wrap">{sel.result || sel.text || "（无返回）"}</div>}
                  {tab === "计时" && (
                    <dl className="hist-meta">
                      <dt>开始时间</dt><dd>{sel.at ? fmtTime(sel.at) : "—"}</dd>
                      <dt>时长</dt><dd>{fmtDuration(sel.ms)}</dd>
                      <dt>轮次</dt><dd>第 {selIdx + 1} 步 / 共 {steps.length} 步</dd>
                    </dl>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function LogsView({ logKey, logStatus, onClose }: { logKey: string; logStatus: string; onClose: () => void }): JSX.Element {
  if (logKey === "tlog") { return <TranslationLog logStatus={logStatus} onClose={onClose} />; }
  if (logKey === "syslog") { return <SystemLog logStatus={logStatus} onClose={onClose} />; }
  return <AiLog logStatus={logStatus} onClose={onClose} />;
}
