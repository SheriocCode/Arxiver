import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX } from "react";
import type { AppConfig, TransParams, TranslationRef } from "../../../shared/types";
import { ViewerEngine, type ViewerStatus } from "../viewer/engine";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";

export interface ViewerHandle {
  openSource(payload: { bytes: Uint8Array; name: string; sourceUrl?: string; docId?: string }, auto?: boolean): Promise<void>;
  loadTranslation(bytes: Uint8Array, docId?: string, cacheKey?: string): Promise<void>;
  goToPage(page: number): void;
  reset(): void;
}

type PageTheme = "original" | "green" | "beige" | "dark";

const THEMES: [PageTheme, string, string][] = [
  ["original", "原始", "#ffffff"],
  ["green", "护眼", "#cce8cf"],
  ["beige", "米黄", "#f3ead3"],
  ["dark", "暗色", "#1a1a1a"]
];

interface Props {
  config: AppConfig | null;
  onStatus: (status: ViewerStatus) => void;
  onClose: () => void;
  translations: TranslationRef[];
  activeKey: string;
  onSelectTranslation: (key: string) => void;
  onAskSelection?: (text: string, page: number) => void;
}

const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(
  { config, onStatus, onClose, translations, activeKey, onSelectTranslation, onAskSelection }, ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [variant, setVariant] = useState("dual");
  const [pages, setPages] = useState("");
  const [panel, setPanel] = useState<"toc" | "thumbs" | null>(null);
  const [outline, setOutline] = useState<{ title: string; page: number; level: number; anchor: number }[]>([]);
  const thumbRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [theme, setTheme] = useState<PageTheme>("original");
  const [themeOpen, setThemeOpen] = useState(false);
  const [themePos, setThemePos] = useState<{ left: number; top: number } | null>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const [selPop, setSelPop] = useState<{ x: number; y: number; text: string; page: number } | null>(null);
  const statusRef = useRef<ViewerStatus | null>(null);
  const [citation, setCitation] = useState<{ page: number; x: number; y: number; anchor: number } | null>(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  const hoverLink = useRef<Element | null>(null);
  const pending = useRef<{ page: number; x: number; y: number; anchor: number } | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const citationShown = useRef(false);
  const citationCanvasRef = useRef<HTMLCanvasElement>(null);
  const citationBodyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => { citationShown.current = !!citation; }, [citation]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCitation(null), 220);
  }, []);
  const cancelHide = useCallback(() => { window.clearTimeout(hideTimer.current); }, []);

  useEffect(() => {
    if (!hostRef.current) { return; }
    const engine = new ViewerEngine(hostRef.current, (s) => { statusRef.current = s; setStatus(s); onStatus(s); });
    engineRef.current = engine;
    return () => { engine.reset(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
      const link = el && el.closest ? el.closest(".link-rect") : null;
      const pop = el && el.closest ? el.closest(".citation-pop") : null;
      const last = lastPoint.current;
      const moved = !last || Math.abs(e.clientX - last.x) > 2 || Math.abs(e.clientY - last.y) > 2;
      if (link) {
        lastPoint.current = { x: e.clientX, y: e.clientY };
        window.clearTimeout(hideTimer.current);
        const page = parseInt((link as HTMLElement).dataset.page || "0", 10);
        const anchor = parseFloat((link as HTMLElement).dataset.anchor || "0");
        if (!page) { return; }
        pending.current = { page, x: e.clientX, y: e.clientY, anchor: isNaN(anchor) ? 0 : anchor };
        if (!citationShown.current && link !== hoverLink.current) {
          hoverLink.current = link;
          window.clearTimeout(showTimer.current);
          showTimer.current = window.setTimeout(() => setCitation(pending.current), 1000);
        }
      } else if (pop) {
        lastPoint.current = { x: e.clientX, y: e.clientY };
        hoverLink.current = null;
        window.clearTimeout(showTimer.current);
        window.clearTimeout(hideTimer.current);
      } else {
        if (!moved) { return; }
        lastPoint.current = { x: e.clientX, y: e.clientY };
        hoverLink.current = null;
        window.clearTimeout(showTimer.current);
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setCitation(null), 220);
      }
    }
    function onDown(e: MouseEvent): void {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(".citation-pop")) { return; }
      scheduleHide();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mousedown", onDown);
    };
  }, [scheduleHide]);

  useEffect(() => {
    function onUp(): void {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { setSelPop(null); return; }
      const node = sel.anchorNode;
      const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
      if (!el || !el.closest || !el.closest(".text-layer")) { setSelPop(null); return; }
      const stage = stageRef.current;
      if (!stage) { return; }
      const sr = stage.getBoundingClientRect();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setSelPop({ x: rect.left - sr.left + rect.width / 2, y: rect.top - sr.top, text: sel.toString().trim(), page: statusRef.current?.displayPage || 1 });
    }
    function onDown(e: MouseEvent): void {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(".sel-ask")) { return; }
      setSelPop(null);
    }
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mouseup", onUp); document.removeEventListener("mousedown", onDown); };
  }, []);

  useEffect(() => {
    const canvas = citationCanvasRef.current;
    const body = citationBodyRef.current;
    if (!citation || !canvas || !body) { return; }
    let cancelled = false;
    void (async () => {
      await engineRef.current?.renderCitation(citation.page, canvas, Math.max(200, body.clientWidth));
      if (cancelled || !citationBodyRef.current) { return; }
      const b = citationBodyRef.current;
      b.scrollTop = Math.max(0, citation.anchor * canvas.scrollHeight - b.clientHeight / 2);
      const covered = document.elementFromPoint(citation.x, citation.y) as Element | null;
      if (covered && covered.closest && covered.closest(".citation-pop")) { window.clearTimeout(hideTimer.current); }
    })();
    return () => { cancelled = true; };
  }, [citation]);

  useEffect(() => {
    if (!config) { return; }
    setSourceLang(config.source_lang || "en");
    setTargetLang(config.target_lang || "zh-CN");
    setVariant(config.output_variant || "dual");
  }, [config]);

  useEffect(() => {
    if (!menuOpen) { return; }
    function onDown(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenuOpen(false); }
    }
    function close(): void { setMenuOpen(false); }
    function onScroll(e: Event): void {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) { return; }
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!themeOpen) { return; }
    function onDown(e: MouseEvent): void {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) { setThemeOpen(false); }
    }
    function close(): void { setThemeOpen(false); }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
    };
  }, [themeOpen]);

  useEffect(() => {
    if (panel !== "toc") { return; }
    let cancelled = false;
    (async () => {
      const items = await engineRef.current?.outline();
      if (!cancelled) { setOutline(items || []); }
    })();
    return () => { cancelled = true; };
  }, [panel, status?.numPages]);

  useEffect(() => {
    if (panel !== "thumbs") { return; }
    let cancelled = false;
    (async () => {
      const total = status?.numPages || 0;
      for (let p = 1; p <= total; p++) {
        if (cancelled) { return; }
        const canvas = thumbRefs.current[p - 1];
        if (canvas) { await engineRef.current?.renderThumbnail(p, canvas); }
      }
    })();
    return () => { cancelled = true; };
  }, [panel, status?.numPages]);

  useImperativeHandle(ref, () => ({
    openSource: (payload, auto) => engineRef.current?.openSource(payload, { auto }) ?? Promise.resolve(),
    loadTranslation: async (bytes, docId, cacheKey) => {
      const engine = engineRef.current;
      if (!engine) { return; }
      await engine.loadTranslation(bytes);
      if (docId && cacheKey) { await engine.loadBlocks(docId, cacheKey); }
    },
    goToPage: (page: number) => engineRef.current?.goToNumberedPage(page),
    reset: () => engineRef.current?.reset()
  }), []);

  const s = status;
  const hasSource = !!s?.hasSource;
  const hasTranslation = !!s?.hasTranslation;
  const running = !!s?.running;
  const numPages = s?.numPages || 0;
  const isCompare = s?.view === "compare";
  const curTocPage = s?.displayPage ?? -1;
  const curTocFrac = s?.scrollFraction ?? 0;
  let tocActive = -1;
  for (let i = 0; i < outline.length; i++) {
    const e = outline[i];
    if (!e.page) { continue; }
    if (e.page < curTocPage || (e.page === curTocPage && e.anchor <= curTocFrac + 0.03)) { tocActive = i; }
    else if (e.page > curTocPage) { break; }
  }
  const pct = s?.phase === "done" ? 100 : (s?.progress || 0);
  const showOverlay = !!s && s.phase === "error";
  const canView = (v: string): boolean => v === "source" || hasTranslation || running;

  function start(): void {
    setMenuOpen(false);
    engineRef.current?.start({ source_lang: sourceLang, target_lang: targetLang, output_variant: variant, pages } as Partial<TransParams>);
  }

  function toggleMenu(): void {
    if (!menuOpen && menuRef.current) {
      const r = menuRef.current.getBoundingClientRect();
      const width = 260;
      setMenuPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 6 });
    }
    setMenuOpen((o) => !o);
  }

  function onMainClick(): void {
    if (hasTranslation) { toggleMenu(); } else { start(); }
  }

  function toggleTheme(): void {
    if (!themeOpen && themeRef.current) {
      const r = themeRef.current.getBoundingClientRect();
      setThemePos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 180)), top: r.bottom + 6 });
    }
    setThemeOpen((o) => !o);
  }

  let citationStyle: { left: number; top: number } | undefined;
  if (citation && stageRef.current) {
    const st = stageRef.current.getBoundingClientRect();
    const pw = st.width * 0.7, ph = st.height * 0.6;
    const cx = citation.x - st.left, cy = citation.y - st.top;
    let left = cx < st.width / 2 ? cx + 18 : cx - pw - 18;
    left = Math.max(8, Math.min(left, Math.max(8, st.width - pw - 8)));
    let top = cy - ph / 2;
    top = Math.max(8, Math.min(top, Math.max(8, st.height - ph - 8)));
    citationStyle = { left, top };
  }

  return (
    <div className="workspace" data-page-theme={theme} hidden={!hasSource}>
      <header className="toolbar">
        <div className="controls">
          <button type="button" className={"panel-btn" + (panel ? " active" : "")} title="目录 / 缩略图" onClick={() => setPanel(panel ? null : "toc")}><Icon name="panel-left" small /></button>

          <div className="theme-menu" ref={themeRef}>
            <button type="button" className="theme-btn" title="页面背景" onClick={toggleTheme}>
              <span className="swatch" style={{ background: THEMES.find((t) => t[0] === theme)?.[2] }} />
            </button>
            {themeOpen && (
              <div className="menu-pop theme-pop" style={{ left: themePos?.left, top: themePos?.top }}>
                {THEMES.map(([id, label, color]) => (
                  <button key={id} type="button" className={"theme-item" + (theme === id ? " active" : "")} onClick={() => { setTheme(id); setThemeOpen(false); }}>
                    <span className="swatch" style={{ background: color }} />
                    <span className="theme-label">{label}</span>
                    {theme === id && <Icon name="check" small />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="translate-menu" ref={menuRef}>
            <div className="split">
              <button className="primary split-main" disabled={running} onClick={onMainClick}>{hasTranslation ? "已翻译" : "翻译"}</button>
              <button className="primary split-caret" title="翻译选项" onClick={toggleMenu}>
                <Icon name="chev-down" small />
              </button>
            </div>
            {menuOpen && (
              <div className="menu-pop" style={{ left: menuPos?.left, top: menuPos?.top }}>
                {translations.length > 0 && (
                  <div className="menu-section">
                    <div className="menu-label">译文文件</div>
                    <div className="menu-list">
                      {translations.map((t) => (
                        <button key={t.cacheKey} type="button" className={"menu-item" + (t.cacheKey === activeKey ? " active" : "")} onClick={() => { onSelectTranslation(t.cacheKey); setMenuOpen(false); }}>
                          <Icon name="file" small />
                          <span className="menu-item-name">{t.target_lang}{t.pages ? ` · 第 ${t.pages} 页` : " · 全文"}</span>
                          {t.cacheKey === activeKey && <Icon name="check" small />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="menu-section">
                  <div className="menu-label">翻译设置</div>
                  <label className="menu-row"><span>源语言</span>
                    <select value={sourceLang} disabled={running} onChange={(e) => setSourceLang(e.target.value)}>
                      {LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </label>
                  <label className="menu-row"><span>目标语言</span>
                    <select value={targetLang} disabled={running} onChange={(e) => setTargetLang(e.target.value)}>
                      {LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                    </select>
                  </label>
                  <label className="menu-row"><span>导出格式</span>
                    <select value={variant} disabled={running} onChange={(e) => setVariant(e.target.value)}>
                      <option value="dual">双语对照</option>
                      <option value="mono">仅译文</option>
                    </select>
                  </label>
                  <label className="menu-row"><span>页数</span>
                    <input type="text" value={pages} disabled={running} placeholder="全部（如 1-3,5）" onChange={(e) => setPages(e.target.value)} />
                  </label>
                  <label className="menu-check">
                    <input type="checkbox" checked={!!s?.blocksOn} disabled={!isCompare} onChange={() => engineRef.current?.toggleBlocks()} />
                    <span>显示块框（对照视图）</span>
                  </label>
                </div>

                {hasTranslation && (
                  <button type="button" className="primary menu-action" disabled={running} onClick={start}>重新翻译</button>
                )}
              </div>
            )}
          </div>

          <div className="segmented">
            {(["source", "compare", "target"] as const).map((v) => (
              <button key={v} type="button" className={s?.view === v ? "active" : ""} disabled={!canView(v)} onClick={() => engineRef.current?.setView(v)}>
                {v === "source" ? "原文" : v === "compare" ? "对照" : "译文"}
              </button>
            ))}
          </div>

          <div className="segmented">
            <button type="button" className={s?.layout === "single" ? "active" : ""} title="单页" onClick={() => engineRef.current?.setLayout("single")}>单页</button>
            <button type="button" className={s?.layout === "double" ? "active" : ""} onClick={() => engineRef.current?.setLayout("double")}>双页</button>
          </div>

          {numPages > 0 && (
            <div className="navgroup">
              <button type="button" title="上一页" onClick={() => engineRef.current?.prevPage()}><Icon name="chev-left" small /></button>
              <input type="text" value={s?.displayPage ?? 1} onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) { engineRef.current?.goToNumberedPage(n); } }} />
              <span className="nav-muted">/ {numPages}</span>
              <button type="button" title="下一页" onClick={() => engineRef.current?.nextPage()}><Icon name="chev-right" small /></button>
            </div>
          )}
          {numPages > 0 && (
            <div className="navgroup">
              <button type="button" title="缩小" onClick={() => engineRef.current?.zoomBy(1 / 1.15)}><Icon name="zoom-out" small /></button>
              <span className="nav-muted" onClick={() => engineRef.current?.setZoom(1)} style={{ cursor: "pointer" }}>{Math.round((s?.zoom || 1) * 100)}%</span>
              <button type="button" title="放大" onClick={() => engineRef.current?.zoomBy(1.15)}><Icon name="zoom-in" small /></button>
            </div>
          )}

          {hasTranslation && <button type="button" className="primary" onClick={() => engineRef.current?.save(variant)}>保存</button>}
          {running && <button type="button" className="danger" onClick={() => engineRef.current?.cancel()}>取消</button>}
          <button type="button" className="primary" onClick={onClose}>关闭</button>
        </div>
      </header>

      {running && (
        <div className="run-bar">
          <div className="run-bar-fill" style={{ width: pct + "%" }} />
          <div className="run-bar-text">
            <span className="run-bar-phase">翻译中</span>
            <span>已完成 {s?.donePages || 0}/{s?.totalPages || "?"} 页</span>
            {(s?.blockTotal || 0) > 0 && <span>第 {s?.blockPage || s?.currentPage || "-"} 页 · 块 {s?.blockIndex || 0}/{s?.blockTotal}</span>}
          </div>
        </div>
      )}

      <div className="workspace-body">
        {panel && (
          <aside className="outline-panel">
            <div className="outline-tabs">
              <button type="button" className={panel === "toc" ? "active" : ""} onClick={() => setPanel("toc")}>目录</button>
              <button type="button" className={panel === "thumbs" ? "active" : ""} onClick={() => setPanel("thumbs")}>缩略图</button>
            </div>
            <div className="outline-body">
              {panel === "toc"
                ? (outline.length === 0
                  ? <div className="outline-empty">无目录</div>
                  : outline.map((it, i) => (
                    <button
                      key={i}
                      type="button"
                      className={"toc-item" + (i === tocActive ? " active" : "")}
                      style={{ paddingLeft: 12 + it.level * 14 }}
                      disabled={!it.page}
                      title={it.title}
                      onClick={() => { if (it.page) { engineRef.current?.goToDest(it.page, it.anchor); } }}
                    >
                      {it.title}
                    </button>
                  )))
                : Array.from({ length: s?.numPages || 0 }, (_, i) => i + 1).map((p) => (
                  <button key={p} type="button" className={"thumb" + (p === (s?.displayPage ?? -1) ? " active" : "")} onClick={() => engineRef.current?.goToNumberedPage(p)}>
                    <canvas ref={(el) => { thumbRefs.current[p - 1] = el; }} />
                    <span className="thumb-no">{p}</span>
                  </button>
                ))}
            </div>
          </aside>
        )}
        <div className="viewer-stage" ref={stageRef}>
          <div ref={hostRef} />
          {selPop && (
            <button
              type="button"
              className="sel-ask"
              style={{ left: selPop.x, top: selPop.y }}
              onClick={() => { onAskSelection?.(selPop.text, selPop.page); setSelPop(null); window.getSelection()?.removeAllRanges(); }}
            >
              <Icon name="arxiver" small /> 问 Arxiver
            </button>
          )}
          {citation && (
            <div
              className="citation-pop"
              style={citationStyle}
              onMouseEnter={cancelHide}
              onMouseLeave={scheduleHide}
            >
              <div className="citation-head">第 {citation.page} 页</div>
              <div className="citation-body" ref={citationBodyRef}><canvas ref={citationCanvasRef} /></div>
            </div>
          )}
        </div>
        {showOverlay && (
          <div className="status-panel">
            <div className="status-title">翻译失败</div>
            <pre className="error">{s?.error}</pre>
          </div>
        )}
      </div>
    </div>
  );
});

export default Viewer;
