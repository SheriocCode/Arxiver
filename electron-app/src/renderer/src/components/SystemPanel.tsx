import { useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import type { AppProcessInfo } from "../../../shared/types";
import { Icon } from "./Icons";
import { useRuntimeMonitor, type RuntimeGroup as Group, type RuntimeMetric as Metric, type RuntimeSort as SortKey } from "../state/runtimeMonitor";

const GROUPS: { id: Group; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "window", label: "窗口" },
  { id: "gpu", label: "GPU" },
  { id: "service", label: "服务" }
];

const METRICS: { id: Metric; label: string; hint: string }[] = [
  { id: "work", label: "工作集", hint: "对应任务管理器「详细信息 → 工作集(内存)」列，两边数值应一致" },
  { id: "commit", label: "提交大小", hint: "对应任务管理器「详细信息 → 提交大小」列（含已提交但未驻留的页，通常大于工作集）" }
];

const JOB_STATUS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  error: "失败",
  cancelled: "已取消"
};

function groupOf(p: AppProcessInfo): Exclude<Group, "all"> {
  if (p.type === "Browser" || p.type === "Tab") { return "window"; }
  if (p.type === "GPU") { return "gpu"; }
  return "service";
}

function fmtUptime(sec: number): string {
  if (sec < 60) { return sec + " 秒"; }
  const m = Math.floor(sec / 60);
  if (m < 60) { return m + " 分钟"; }
  return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
}

function fmtMB(n: number): string {
  return n >= 1024 ? (n / 1024).toFixed(2) + " GB" : n + " MB";
}

// 自绘趋势图：网格 + 面积 + 折线（不引第三方图表库）
function Trend({ data, height = 56, color = "var(--accent)", labels, unit }: {
  data: number[];
  height?: number;
  color?: string;
  labels?: boolean;
  unit?: string;
}): JSX.Element {
  const w = 300;
  if (data.length < 2) {
    return <div className="sys-trend-empty" style={{ height }}>正在采样…</div>;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = Math.max(1e-6, max - min);
  const x = (i: number): number => (i / (data.length - 1)) * w;
  const y = (v: number): number => height - 4 - ((v - min) / span) * (height - 10);
  const line = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${w},${height}`;
  return (
    <div className="sys-trend">
      <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} className="sys-grid" x1="0" x2={w} y1={height * r} y2={height * r} />
        ))}
        <polygon className="sys-area" points={area} style={{ fill: color }} />
        <polyline className="sys-line" points={line} style={{ stroke: color }} />
      </svg>
      {labels ? (
        <div className="sys-trend-labels">
          <span>最高 {unit ? `${max.toFixed(1)}${unit}` : max}</span>
          <span>最低 {unit ? `${min.toFixed(1)}${unit}` : min}</span>
        </div>
      ) : null}
    </div>
  );
}

// 带圈问号 + 悬浮解释（复用「新建文献」那套 .help / .help-pop）
function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <span className="help" aria-hidden="true">?<span className="help-pop">{children}</span></span>;
}

function Card({ title, hint, right, children }: { title: string; hint?: ReactNode; right?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <section className="sys-card">
      <div className="sys-card-head">
        <h3>{title}</h3>
        {hint ? <Hint>{hint}</Hint> : null}
        <span className="od-fill" />
        {right}
      </div>
      {children}
    </section>
  );
}

export default function SystemPanel({ onClose }: { onClose: () => void }): JSX.Element {
  // 采样与历史放在模块级监视器里：离开本面板后再回来，曲线是接着画的
  const { metrics: m, hist, metric, group, sort, paused, setMetric, setGroup, setSort, setPaused } = useRuntimeMonitor();
  const [saved, setSaved] = useState("");

  const memOf = useCallback((p: AppProcessInfo): number => (metric === "commit" ? p.commitMB : p.rssMB), [metric]);

  const procs = m ? m.procs : [];
  const snap = hist[metric];
  const totalMem = procs.reduce((n, p) => n + memOf(p), 0);

  const counts = useMemo(() => {
    const c: Record<string, { n: number; mb: number }> = { all: { n: 0, mb: 0 } };
    for (const p of procs) {
      const g = groupOf(p);
      c.all.n++; c.all.mb += memOf(p);
      c[g] = c[g] || { n: 0, mb: 0 };
      c[g].n++; c[g].mb += memOf(p);
    }
    return c;
  }, [procs, memOf]);

  const rows = useMemo(() => {
    const list = group === "all" ? procs.slice() : procs.filter((p) => groupOf(p) === group);
    list.sort((a, b) => {
      if (sort === "kind") { return a.kind.localeCompare(b.kind, "zh"); }
      if (sort === "pid") { return a.pid - b.pid; }
      if (sort === "cpu") { return b.cpuPercent - a.cpuPercent; }
      return memOf(b) - memOf(a);
    });
    return list;
  }, [procs, group, sort, memOf]);

  const maxMem = Math.max(1, ...procs.map((p) => memOf(p)));
  const cpuNow = procs.reduce((n, p) => n + p.cpuPercent, 0);
  const metricHint = METRICS.find((x) => x.id === metric)?.hint || "";

  const saveReport = (): void => {
    void window.api.saveDiagnostics().then((file) => { setSaved(file ? "已保存：" + file : ""); setTimeout(() => setSaved(""), 4000); });
  };
  const head = (key: SortKey, label: string): JSX.Element => (
    <button className={"sys-th" + (sort === key ? " is-active" : "")} onClick={() => setSort(key)}>
      {label}{sort === key ? <Icon name="chev-down" small /> : null}
    </button>
  );

  return (
    <section className="history" aria-label="运行状态">
      <div className="hist-head">
        <div className="hist-heading">
          <h2>运行状态</h2>
          {m ? <span className="hist-badge">{m.version}{m.dev ? " · 开发版" : ""}</span> : null}
        </div>
        <div className="hist-head-right">
          {saved ? <span className="sys-saved">{saved}</span> : null}
          <div className="sys-filter">
            {METRICS.map((x) => (
              <button key={x.id} title={x.hint} className={metric === x.id ? "is-active" : ""} onClick={() => setMetric(x.id)}>{x.label}</button>
            ))}
          </div>
          <button className="btn btn-ghost" onClick={() => setPaused(!paused)}>
            <Icon name={paused ? "arrow-up" : "x"} small /> {paused ? "继续" : "暂停"}
          </button>
          <button className="btn btn-ghost" onClick={saveReport}><Icon name="file" small /> 导出诊断报告</button>
          <button className="btn btn-ghost" onClick={() => { if (m) { void window.api.openPath(m.logFile); } }}><Icon name="terminal" small /> 日志文件</button>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" small /></button>
        </div>
      </div>

      <div className="sys-body">
        <Card
          title="概览"
          hint={
            <>
              <b>内存口径</b>：任务管理器「进程」页默认那列是「活动的专用工作集」，Chromium 不提供这个数，
              所以数值看着不一样。要看数字请在任务管理器切到「详细信息」→ 右键表头 → <b>选择列</b>，
              勾上「<b>工作集(内存)</b>」（对应这里的「工作集」）或「<b>提交大小</b>」（对应「提交大小」）。<br />
              <b>趋势</b>：每 2 秒采样一次，保留最近约 3 分钟；离开本页后仍在后台采样（只是更稀疏）。
            </>
          }
          right={<span className={"sys-live" + (paused ? " is-paused" : "")}>{paused ? "已暂停" : "实时 · 每 2 秒"}</span>}
        >
          <>
            <div className="sys-kv">
              <div><span>已运行</span><b>{m ? fmtUptime(m.uptimeSec) : "—"}</b></div>
              <div><span>进程数</span><b>{procs.length}</b></div>
              <div><span>合计内存（{metric === "commit" ? "提交" : "工作集"}）</span><b>{fmtMB(totalMem)}</b></div>
              <div><span>合计 CPU</span><b>{cpuNow.toFixed(1)}%</b></div>
            </div>
            <div className="sys-charts">
              <div className="sys-chart">
                <div className="sys-chart-head"><span>内存 · {metric === "commit" ? "提交" : "工作集"}</span><b>{totalMem} MB</b></div>
                <Trend data={snap.total} labels unit=" MB" />
              </div>
              <div className="sys-chart">
                <div className="sys-chart-head"><span>CPU</span><b>{cpuNow.toFixed(1)}%</b></div>
                <Trend data={snap.cpu} labels unit="%" color="var(--star)" />
              </div>
            </div>
          </>
        </Card>

        <Card
          title="进程"
          hint={
            <>
              Windows 任务管理器只按 exe 的「描述」显示进程名，Chromium 的渲染 / GPU / 网络等子进程在它那里
              全都叫「<b>Arxiver</b>」（只有 Chrome / Edge 这类被系统特殊识别的浏览器才显示「GPU 进程 / 工具进程」），
              用上表的 <b>PID</b> 就能逐行对上。<br />
              想同时看命令行：任务管理器「详细信息」→ 右键表头 → 选择列 → 勾上「命令行」，能看到 <code>--type=…</code>。<br />
              翻译时会另外出现引擎进程（<code>llama-server.exe</code> / <code>python.exe</code>），名字不同、在下面的卡片里单列。
            </>
          }
          right={
            <div className="sys-filter">
              {GROUPS.map((g) => (
                <button key={g.id} className={group === g.id ? "is-active" : ""} onClick={() => setGroup(g.id)}>
                  {g.label}
                  <em>{counts[g.id]?.n || 0}</em>
                </button>
              ))}
            </div>
          }
        >
          <>
            <div className="sys-row sys-row-head">
              {head("kind", "名称")}
              <span className="sys-th-plain">类型</span>
              {head("pid", "PID")}
              {head("rss", "内存（" + (metric === "commit" ? "提交" : "工作集") + "）")}
              {head("cpu", "CPU")}
              <span className="sys-th-plain">趋势</span>
            </div>
            {rows.map((p) => (
              <div className="sys-row" key={p.pid} title={`峰值 ${p.peakMB} MB · 工作集 ${p.rssMB} MB · 提交 ${p.commitMB} MB`}>
                <span className="sys-name">{p.kind}{p.isMain ? "（主）" : ""}</span>
                <span className="sys-type" title={p.serviceName || p.type}>{p.type}{p.serviceName ? ` · ${p.serviceName.split(".").pop()}` : ""}</span>
                <span className="sys-pid">{p.pid}</span>
                <span className="sys-mem">
                  <i><b style={{ width: Math.max(2, (memOf(p) / maxMem) * 100) + "%" }} /></i>
                  {memOf(p)} MB
                </span>
                <span className="sys-cpu">{p.cpuPercent.toFixed(1)}%</span>
                <span className="sys-spark"><Trend data={snap.per[p.pid] || []} height={18} /></span>
              </div>
            ))}
            {!rows.length ? <div className="sys-empty">没有匹配的进程</div> : null}
          </>
        </Card>
        <Card
          title="翻译引擎与任务"
          hint={
            <>
              这些是主进程的子进程（Python 引擎 / llama-server），Electron 的进程表里看不到，所以单独列在这里；
              内存取自系统计数，与任务管理器「工作集(内存)」同口径，不计入上方合计。<br />
              多开文献标签不会新增进程——所有文书都渲染在同一个界面进程里；翻译任务排队跑同一个 Python 引擎。
              本地模型服务首次翻译后会常驻（约 1.4 GB），只在退出应用时释放。
            </>
          }
          right={<span className="sys-live">不计入上方合计</span>}
        >
          <>
            <div className="sys-row sys-row-head">
              <span className="sys-th-plain">进程</span>
              <span className="sys-th-plain">程序</span>
              <span className="sys-th-plain">PID</span>
              <span className="sys-th-plain">内存（工作集）</span>
              <span className="sys-th-plain">说明</span>
            </div>
            {(m?.children || []).map((c) => (
              <div className="sys-row" key={c.pid}>
                <span className="sys-name">{c.kind}</span>
                <span className="sys-type">{c.name}</span>
                <span className="sys-pid">{c.pid}</span>
                <span className="sys-mem">{c.memMB == null ? "—" : c.memMB + " MB"}</span>
                <span className="sys-type">{c.detail || "—"}</span>
              </div>
            ))}
            {!(m?.children || []).length ? (
              <div className="sys-empty">暂无引擎进程（翻译时会启动 Python 引擎；本地翻译还会启动 llama-server 模型服务）</div>
            ) : null}
            <div className="sys-jobs">
              {(m?.jobs || []).length ? (m?.jobs || []).map((j) => (
                <div className="sys-job" key={j.id}>
                  <span className={"sys-dot is-" + j.status} />
                  <span className="sys-job-name">{j.name}</span>
                  <span className="sys-job-status">{(JOB_STATUS[j.status] || j.status) + (j.pages ? ` · ${j.donePages}/${j.pages} 页` : "")}</span>
                  <span className="sys-job-note od-truncate">{j.message}</span>
                </div>
              )) : <div className="sys-empty">没有翻译任务</div>}
            </div>
          </>
        </Card>
      </div>
    </section>
  );
}
