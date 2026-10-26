import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { Conversation, ConversationSummary, SystemLogEntry, TranslationLogEntry } from "../../../shared/types";
import { Icon } from "./Icons";

const LOG_TABS: { id: string; name: string }[] = [
  { id: "tlog", name: "翻译" },
  { id: "ailog", name: "AI 对话" },
  { id: "syslog", name: "系统运行" }
];

const FILTERS: Record<string, { id: string; name: string }[]> = {
  tlog: [
    { id: "all", name: "全部" },
    { id: "done", name: "已完成" },
    { id: "running", name: "进行中" },
    { id: "failed", name: "失败" }
  ],
  syslog: [
    { id: "all", name: "全部" },
    { id: "info", name: "信息" },
    { id: "warn", name: "警告" },
    { id: "error", name: "错误" }
  ]
};

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
// 今天的只显示时间，更早的带上月/日
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return startOfDay(ms) === startOfDay(Date.now()) ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
function fmtBytes(n?: number): string {
  if (!n) { return "—"; }
  if (n < 1024) { return n + " B"; }
  if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
  if (n < 1024 * 1024 * 1024) { return (n / 1024 / 1024).toFixed(1) + " MB"; }
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function fmtDuration(ms?: number | null): string {
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

// ---- 时间分组 / 近 7 天活动 ----

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dayLabel(ms: number): string {
  const today = startOfDay(Date.now());
  if (ms === today) { return "今天"; }
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (ms === y.getTime()) { return "昨天"; }
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function groupByDay<T>(items: T[], at: (x: T) => number): { key: number; label: string; items: T[] }[] {
  const map = new Map<number, T[]>();
  for (const x of items) {
    const k = startOfDay(at(x));
    const arr = map.get(k);
    if (arr) { arr.push(x); } else { map.set(k, [x]); }
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, list]) => ({ key, label: dayLabel(key), items: list.slice().sort((a, b) => at(b) - at(a)) }));
}
function daySeries(times: number[]): { key: number; label: string; count: number }[] {
  const today = startOfDay(Date.now());
  const keys: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    keys.push(d.getTime());
  }
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const t of times) {
    const k = startOfDay(t);
    const n = counts.get(k);
    if (n !== undefined) { counts.set(k, n + 1); }
  }
  return keys.map((k) => {
    const d = new Date(k);
    return { key: k, label: `${d.getMonth() + 1}/${d.getDate()}`, count: counts.get(k) || 0 };
  });
}
/** 主进程已经按天统计好（只有 7 个数），不用把全部时间戳传过来 */
function daySeriesFromCounts(counts: number[]): { key: number; label: string; count: number }[] {
  const today = startOfDay(Date.now());
  return counts.map((count, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (counts.length - 1 - i));
    return { key: d.getTime(), label: `${d.getMonth() + 1}/${d.getDate()}`, count };
  });
}

interface Stat { label: string; value: string | number; unit?: string; tone?: "bad" | "warn" | "accent" }

function Overview({ stats, times, dayCounts }: { stats: Stat[]; times?: number[]; dayCounts?: number[] }): JSX.Element {
  const days = useMemo(() => (dayCounts ? daySeriesFromCounts(dayCounts) : daySeries(times || [])), [dayCounts, times]);
  const max = Math.max(1, ...days.map((d) => d.count));
  const weekTotal = days.reduce((a, d) => a + d.count, 0);
  const today = startOfDay(Date.now());
  return (
    <div className="lg-overview">
      <div className="lg-stats">
        {stats.map((s) => (
          <div key={s.label} className={"lg-stat" + (s.tone ? " is-" + s.tone : "")}>
            <span>{s.label}</span>
            <b>{s.value}{s.unit ? <em>{s.unit}</em> : null}</b>
          </div>
        ))}
      </div>
      <div className="lg-chart">
        <div className="lg-chart-head"><span>近 7 天活动</span><em>{weekTotal} 条</em></div>
        <div className="lg-bars">
          {days.map((d) => (
            <i
              key={d.key}
              className={d.key === today ? "is-today" : ""}
              style={{ height: `${Math.max(4, Math.round(d.count / max * 100))}%` }}
              title={`${d.label} · ${d.count} 条`}
            />
          ))}
        </div>
        <div className="lg-days">{days.map((d) => <span key={d.key}>{d.label}</span>)}</div>
      </div>
    </div>
  );
}

function Header({ logKey, onKey, onClose, right }: {
  logKey: string;
  onKey: (k: string) => void;
  onClose: () => void;
  right: JSX.Element;
}): JSX.Element {
  return (
    <header className="lg-head">
      <div className="lg-title">
        <h1>日志</h1>
        <p>运行记录、翻译任务与助手对话</p>
      </div>
      <nav className="lg-tabs" role="tablist" aria-label="日志类型">
        {LOG_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={logKey === t.id} onClick={() => onKey(t.id)}>{t.name}</button>
        ))}
      </nav>
      <div className="lg-actions">
        {right}
        <button type="button" className="lg-action" onClick={onClose}>关闭</button>
      </div>
    </header>
  );
}

function ListHead({ filters, status, onStatus, count, unit = "条" }: {
  filters: { id: string; name: string }[];
  status: string;
  onStatus: (id: string) => void;
  count: number;
  unit?: string;
}): JSX.Element {
  return (
    <div className="lg-list-head">
      <nav className="lg-filters" role="group" aria-label="筛选">
        {filters.map((f) => (
          <button key={f.id} type="button" aria-pressed={status === f.id} onClick={() => onStatus(f.id)}>{f.name}</button>
        ))}
      </nav>
      <span className="lg-count">{count} {unit}</span>
    </div>
  );
}

function Event({ tone, title, meta, time, selected, onClick }: {
  tone: string;
  title: string;
  meta: ReactNode;
  time: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className={"lg-event" + (selected ? " is-selected" : "")} onClick={onClick}>
      <span className={"lg-node " + tone} />
      <span className="lg-main">
        <span className="lg-event-title od-truncate">{title}</span>
        <span className="lg-event-meta od-truncate">{meta}</span>
      </span>
      <span className="lg-event-time">{time}</span>
    </button>
  );
}

function Timeline<T>({ groups, render }: { groups: { key: number; label: string; items: T[] }[]; render: (item: T) => JSX.Element }): JSX.Element {
  return (
    <>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="lg-group"><span>{g.label}</span><span>{fmtDay(g.key)}</span></div>
          <div className="lg-timeline">{g.items.map(render)}</div>
        </div>
      ))}
    </>
  );
}

/* ---------------------------------- 翻译日志 ---------------------------------- */

const T_STATUS: Record<string, { label: string; tone: string }> = {
  done: { label: "已完成", tone: "is-ok" },
  running: { label: "进行中", tone: "is-run" },
  queued: { label: "排队中", tone: "is-wait" },
  failed: { label: "失败", tone: "is-bad" }
};

function TranslationLog({ logStatus, setLogStatus, setLogKey, onClose, active }: {
  logStatus: string;
  setLogStatus: (v: string) => void;
  setLogKey: (k: string) => void;
  onClose: () => void;
  active: boolean;
}): JSX.Element {
  const [entries, setEntries] = useState<TranslationLogEntry[]>([]);
  const [selId, setSelId] = useState("");

  const load = useCallback((): void => {
    void window.api.logsTranslation().then((d) => {
      setEntries(d);
      setSelId((cur) => (d.some((x) => x.id === cur) ? cur : d[0]?.id || ""));
    });
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => entries
    .filter((e) => {
      if (logStatus === "all") { return true; }
      if (logStatus === "running") { return e.status === "running" || e.status === "queued"; }
      return e.status === logStatus;
    })
    .sort((a, b) => b.created_at - a.created_at), [entries, logStatus]);

  const sel = filtered.find((x) => x.id === selId) || filtered[0];
  const selStatus = sel ? (T_STATUS[sel.status] || T_STATUS.done) : T_STATUS.done;
  const grouped = useMemo(() => groupByDay(filtered, (e) => e.created_at), [filtered]);

  const stats = useMemo<Stat[]>(() => {
    const running = entries.filter((e) => e.status === "running" || e.status === "queued").length;
    const failed = entries.filter((e) => e.status === "failed").length;
    const done = entries.filter((e) => e.status === "done" && e.finished_at && e.created_at);
    const avg = done.length ? done.reduce((a, e) => a + ((e.finished_at || 0) - e.created_at), 0) / done.length : null;
    return [
      { label: "总任务", value: entries.length, unit: "个" },
      { label: "进行中", value: running, tone: running ? "accent" : undefined },
      { label: "失败", value: failed, tone: failed ? "bad" : undefined },
      { label: "平均耗时", value: avg != null ? fmtDuration(avg) : "—" }
    ];
  }, [entries]);
  const times = useMemo(() => entries.map((e) => e.created_at), [entries]);

  return (
    <section className="history" aria-label="日志" hidden={!active}>
      <div className="lg-page">
        <Header
          logKey="tlog"
          onKey={setLogKey}
          onClose={onClose}
          right={<button type="button" className="lg-action" onClick={load}>刷新</button>}
        />
        <Overview stats={stats} times={times} />
        <div className="lg-body">
          <section className="lg-list">
            <ListHead filters={FILTERS.tlog} status={logStatus} onStatus={setLogStatus} count={filtered.length} />
            <div className="lg-scroll">
              {filtered.length === 0 ? <div className="lg-empty">没有匹配的翻译记录</div> : (
                <Timeline
                  groups={grouped}
                  render={(e) => {
                    const st = T_STATUS[e.status] || T_STATUS.done;
                    const meta = [e.targetLang, e.service, e.pages && `${e.pages} 页`].filter(Boolean).join(" · ");
                    return (
                      <Event
                        key={e.id}
                        tone={st.tone}
                        title={e.name}
                        meta={<><span className={"lg-state " + st.tone}>{st.label}</span>{meta ? ` · ${meta}` : ""}</>}
                        time={fmtClock(e.created_at)}
                        selected={e.id === sel?.id}
                        onClick={() => setSelId(e.id)}
                      />
                    );
                  }}
                />
              )}
            </div>
          </section>
          <aside className="lg-detail">
            {!sel ? <div className="lg-empty">选择左侧一条记录</div> : (
              <>
                <div className="lg-detail-head">
                  <h2>{sel.name}</h2>
                  <p>
                    <span className={"lg-state " + selStatus.tone}>{selStatus.label}</span>
                    <span className="lg-dotsep"> · </span>
                    {fmtTime(sel.created_at)}
                  </p>
                </div>
                <div className="lg-detail-body">
                  <dl className="lg-meta">
                    <dt>源文件</dt><dd>{sel.sourceName || "—"}</dd>
                    <dt>目标语言</dt><dd>{sel.targetLang || "—"}</dd>
                    <dt>服务</dt><dd>{sel.service || "—"}</dd>
                    <dt>输出</dt><dd>{sel.variant || "—"}</dd>
                    <dt>页数</dt><dd>{sel.pages || (sel.totalPages ? `${sel.donePages}/${sel.totalPages}` : "—")}</dd>
                    <dt>大小</dt><dd>{fmtBytes(sel.size)}</dd>
                    <dt>开始</dt><dd>{fmtTime(sel.created_at)}</dd>
                    <dt>完成</dt><dd>{sel.finished_at ? fmtTime(sel.finished_at) : "—"}</dd>
                    {sel.created_at && sel.finished_at ? <><dt>耗时</dt><dd>{fmtDuration(sel.finished_at - sel.created_at)}</dd></> : null}
                    {sel.status === "running" && <><dt>进度</dt><dd>{sel.progress != null ? Math.round(sel.progress * 100) + "%" : `${sel.donePages}/${sel.totalPages}`}</dd></>}
                  </dl>
                  {sel.message && <div className="lg-note">{sel.message}</div>}
                  {sel.sourceUrl && <div className="lg-url">{sel.sourceUrl}</div>}
                  {sel.docId && (
                    <div className="lg-actions-row">
                      <button type="button" className="lg-link" onClick={() => { void window.api.libraryReveal(sel.docId); }}>在文件夹中显示</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- 系统运行日志 -------------------------------- */

const LEVELS: Record<string, { label: string; tone: string }> = {
  info: { label: "信息", tone: "is-ok" },
  warn: { label: "警告", tone: "is-warn" },
  error: { label: "错误", tone: "is-bad" }
};

const SYS_PAGE = 200;

function SystemLog({ logStatus, setLogStatus, setLogKey, onClose, active }: {
  logStatus: string;
  setLogStatus: (v: string) => void;
  setLogKey: (k: string) => void;
  onClose: () => void;
  active: boolean;
}): JSX.Element {
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ total: 0, error: 0, warn: 0, scopes: 0, days: [0, 0, 0, 0, 0, 0, 0] });
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(false);
  const [selIdx, setSelIdx] = useState(0);
  const seq = useRef(0);

  // 分页加载：只取当前过滤条件下的前 N 条；切级别 / 刷新都从第 0 条重新取
  const loadPage = useCallback((offset: number, append: boolean): void => {
    const ticket = ++seq.current;
    setLoading(true);
    void window.api.logsSystem({ level: logStatus as "all" | "info" | "warn" | "error", offset, limit: SYS_PAGE })
      .then((d) => {
        if (ticket !== seq.current) { return; }
        setEntries((cur) => (append ? [...cur, ...d.entries] : d.entries));
        setTotal(d.total);
        setSummary(d.stats);
        setFile(d.file);
        if (!append) { setSelIdx(0); }
      })
      .finally(() => { if (ticket === seq.current) { setLoading(false); } });
  }, [logStatus]);

  useEffect(() => { loadPage(0, false); }, [loadPage]);

  const sel = entries[Math.min(selIdx, Math.max(0, entries.length - 1))];
  const selLevel = sel ? (LEVELS[sel.level] || LEVELS.info) : LEVELS.info;
  const indexed = useMemo(() => entries.map((e, i) => ({ e, i })), [entries]);
  const grouped = useMemo(() => groupByDay(indexed, (x) => x.e.at), [indexed]);

  const stats = useMemo<Stat[]>(() => [
    { label: "记录", value: summary.total, unit: "条" },
    { label: "错误", value: summary.error, tone: summary.error ? "bad" : undefined },
    { label: "警告", value: summary.warn, tone: summary.warn ? "warn" : undefined },
    { label: "活跃模块", value: summary.scopes, unit: "个", tone: "accent" }
  ], [summary]);

  return (
    <section className="history" aria-label="日志" hidden={!active}>
      <div className="lg-page">
        <Header
          logKey="syslog"
          onKey={setLogKey}
          onClose={onClose}
          right={
            <>
              <button type="button" className="lg-action" onClick={() => { if (file) { void window.api.openPath(file); } }}>打开日志文件</button>
              <button type="button" className="lg-action" onClick={() => loadPage(0, false)}>刷新</button>
            </>
          }
        />
        <Overview stats={stats} dayCounts={summary.days} />
        <div className="lg-body">
          <section className="lg-list">
            <ListHead filters={FILTERS.syslog} status={logStatus} onStatus={setLogStatus} count={total} />
            <div className="lg-scroll">
              {entries.length === 0 ? <div className="lg-empty">{loading ? "正在读取日志…" : "没有匹配的运行记录"}</div> : (
                <>
                  <Timeline
                    groups={grouped}
                    render={({ e, i }) => {
                      const lv = LEVELS[e.level] || LEVELS.info;
                      return (
                        <Event
                          key={`${e.at}-${i}`}
                          tone={lv.tone}
                          title={e.message}
                          meta={<>{e.scope} · <span className={"lg-state " + lv.tone}>{lv.label}</span></>}
                          time={fmtClock(e.at)}
                          selected={i === selIdx}
                          onClick={() => setSelIdx(i)}
                        />
                      );
                    }}
                  />
                  {entries.length < total && (
                    <div className="lg-more">
                      <button type="button" className="lg-more-btn" disabled={loading} onClick={() => loadPage(entries.length, true)}>
                        {loading ? "加载中…" : `加载更早的记录（${entries.length} / ${total}）`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
          <aside className="lg-detail">
            {!sel ? <div className="lg-empty">选择左侧一条记录</div> : (
              <>
                <div className="lg-detail-head">
                  <h2>{sel.scope}</h2>
                  <p>
                    <span className={"lg-state " + selLevel.tone}>{selLevel.label}</span>
                    <span className="lg-dotsep"> · </span>
                    {fmtTime(sel.at)}
                  </p>
                </div>
                <div className="lg-detail-body">
                  <pre className="lg-code">{sel.message}</pre>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- AI 对话日志 -------------------------------- */

type Kind = "user" | "tool" | "assistant";
interface Step { kind: Kind; name?: string; text?: string; args?: string; result?: string; at?: number; ms?: number; usage?: string }

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

function AiLog({ setLogKey, onClose, active }: {
  setLogKey: (k: string) => void;
  onClose: () => void;
  active: boolean;
}): JSX.Element {
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [selConvId, setSelConvId] = useState("");
  const traceRef = useRef<HTMLDivElement>(null);

  const load = useCallback((): void => {
    void Promise.all([
      window.api.agentConversations({ scope: "library" }),
      window.api.agentConversations({ scope: "paper" })
    ]).then(([a, b]) => {
      // 旧版按论文开的对话仍保留在记录里，新对话统一是文库范围
      const list = [...a, ...b].sort((x, y) => y.updated_at - x.updated_at);
      setConvs(list);
    });
  }, []);
  useEffect(load, [load]);

  const cur = convs.find((c) => c.id === selConvId) || convs[0];

  useEffect(() => {
    if (!cur) { setConv(null); return; }
    let cancelled = false;
    void window.api.agentConversation(cur.id).then((c) => { if (!cancelled) { setConv(c); } });
    return () => { cancelled = true; };
  }, [cur?.id]);

  useEffect(() => { traceRef.current?.scrollTo({ top: 0 }); }, [cur?.id]);

  const steps = useMemo(() => (conv ? toSteps(conv) : []), [conv]);
  const stats = useMemo<Stat[]>(() => {
    const rounds = convs.reduce((a, c) => a + c.count, 0);
    const docs = new Set<string>();
    for (const c of convs) { for (const id of c.docIds || []) { docs.add(id); } }
    const today = startOfDay(Date.now());
    return [
      { label: "对话", value: convs.length, unit: "个" },
      { label: "轮次", value: rounds, unit: "轮" },
      { label: "覆盖文献", value: docs.size, unit: "篇", tone: "accent" },
      { label: "今日活跃", value: convs.filter((c) => startOfDay(c.updated_at * 1000) === today).length }
    ];
  }, [convs]);
  const times = useMemo(() => convs.map((c) => c.updated_at * 1000), [convs]);

  return (
    <section className="history" aria-label="日志" hidden={!active}>
      <div className="lg-page">
        <Header
          logKey="ailog"
          onKey={setLogKey}
          onClose={onClose}
          right={<button type="button" className="lg-action" onClick={load}>刷新</button>}
        />
        <Overview stats={stats} times={times} />
        <div className="lg-body lg-body-ai">
          <section className="lg-list">
            <div className="lg-list-head">
              <span className="lg-list-title">全部对话</span>
              <span className="lg-count">{convs.length} 个</span>
            </div>
            <div className="lg-convs">
              {convs.length === 0 ? <div className="lg-empty">暂无对话记录</div> : convs.map((c) => (
                <button key={c.id} type="button" className={"lg-conv" + (c.id === cur?.id ? " is-selected" : "")} onClick={() => setSelConvId(c.id)}>
                  <span className="lg-conv-title od-truncate">{c.title || "新对话"}</span>
                  <span className="lg-conv-meta">{c.count} 轮 · {fmtWhen(c.updated_at * 1000)}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="lg-detail">
            {!cur ? <div className="lg-empty">选择左侧一条对话</div> : (
              <>
                <div className="lg-trace-head">
                  <h2>{cur.title || "新对话"}</h2>
                  <p>{cur.count} 轮 · 更新于 {fmtTime(cur.updated_at * 1000)}</p>
                </div>
                <div className="lg-trace-body" ref={traceRef}>
                  {steps.length === 0 ? <div className="lg-empty">这条对话没有记录步骤</div> : steps.map((s, i) => {
                    if (s.kind === "tool") {
                      return (
                        <details key={i} className="trace-tool">
                          <summary>
                            <span className="trace-tool-name">{s.name}</span>
                            <span className="trace-tool-args od-truncate">{s.args || ""}</span>
                            <span className="trace-tool-time">{s.ms != null ? fmtDuration(s.ms) : ""}</span>
                            <Icon name="chev-down" small />
                          </summary>
                          <div className="trace-tool-body">
                            <div className="trace-label">参数</div>
                            <pre className="trace-code">{prettyArgs(s.args)}</pre>
                            <div className="trace-label">结果</div>
                            <pre className="trace-code">{s.result || "（无返回）"}</pre>
                          </div>
                        </details>
                      );
                    }
                    return (
                      <div key={i} className={"trace-msg" + (s.kind === "user" ? " is-user" : "")}>
                        <div className="trace-role">{s.kind === "user" ? "你" : "Arxiver"}</div>
                        <div className="trace-text">{s.text || "（空消息）"}</div>
                        {s.usage ? <div className="trace-usage">{s.usage}</div> : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

export default function LogsView({ logKey, setLogKey, logStatus, setLogStatus, onClose }: {
  logKey: string;
  setLogKey: (k: string) => void;
  logStatus: string;
  setLogStatus: (v: string) => void;
  onClose: () => void;
}): JSX.Element {
  // 三个视图常驻挂载，只切换显示：否则每次切分类都要重新拉数据，右侧会先闪一下"暂无记录"
  const switchKey = (k: string): void => { setLogKey(k); setLogStatus("all"); };
  return (
    <>
      <TranslationLog logStatus={logStatus} setLogStatus={setLogStatus} setLogKey={switchKey} onClose={onClose} active={logKey === "tlog"} />
      <AiLog setLogKey={switchKey} onClose={onClose} active={logKey === "ailog"} />
      <SystemLog logStatus={logStatus} setLogStatus={setLogStatus} setLogKey={switchKey} onClose={onClose} active={logKey === "syslog"} />
    </>
  );
}
