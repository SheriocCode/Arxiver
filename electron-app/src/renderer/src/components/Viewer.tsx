import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX } from "react";
import type { AppConfig, PdfAnnotation, PdfAnnotKind, TransParams, TranslationRef } from "../../../shared/types";
import { ViewerEngine, type ViewerStatus, type TranslationDoneInfo, type RegionCapture } from "../viewer/engine";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";
import { PAGE_THEMES, type PageTheme } from "../state/settings";

export interface ViewerHandle {
  goToPage(page: number, quote?: string): void;
}

async function loadKey(engine: ViewerEngine, docId: string, key: string): Promise<void> {
  const tb = await window.api.readTranslation(docId, key, "mono");
  if (!tb || !tb.length) { return; }
  await engine.loadTranslation(new Uint8Array(tb));
  await engine.loadBlocks(docId, key);
}

const ANNOT_COLORS: [string, string][] = [
  ["yellow", "黄色"],
  ["green", "绿色"],
  ["blue", "蓝色"],
  ["pink", "粉色"]
];
const ANNOT_KIND_LABEL: Record<PdfAnnotKind, string> = {
  highlight: "高亮", underline: "下划线", strike: "删除线", note: "笔记", ink: "画笔"
};
const ANNOT_KIND_ICON: Record<PdfAnnotKind, string> = {
  highlight: "highlight", underline: "underline", strike: "strike", note: "note", ink: "pencil"
};
const INK_WIDTHS = [2, 4, 8] as const;

// 侧栏一行的标题：类型 + 计数，具体内容（原文 / 笔记 / 图片 / 链接）分行显示
function annotHeading(a: PdfAnnotation): string {
  if (a.kind === "ink") {
    const n = a.strokes?.length || 0;
    return `画笔${n ? ` · ${n} 笔` : ""}${a.note?.trim() ? " · 笔记" : ""}`;
  }
  const base = ANNOT_KIND_LABEL[a.kind] + (a.region ? "（区域）" : "");
  return a.kind !== "note" && a.note?.trim() ? base + " · 笔记" : base;
}

// 链接在侧栏里去掉协议和末尾斜杠，太长的部分交给 CSS 省略
function linkLabel(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}

// 缩略图缓存是白底 JPEG；读回来后画进 canvas，再由页面主题做着色
function drawThumbImage(canvas: HTMLCanvasElement, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(false); return; }
      ctx.drawImage(img, 0, 0);
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function thumbJpeg(canvas: HTMLCanvasElement): string | null {
  if (!canvas.width || !canvas.height) { return null; }
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) { return null; }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  const url = out.toDataURL("image/jpeg", 0.85);
  out.width = 0; out.height = 0;
  return url;
}

interface Props {
  docId: string;
  visible: boolean;
  config: AppConfig | null;
  translations: TranslationRef[];
  activeKey: string;
  showBlocksTranslating: boolean;
  showBlocksTranslation: boolean;
  pageTheme: PageTheme;
  onPageThemeChange: (theme: PageTheme) => void;
  onToggleBlocks: (which: "translating" | "viewing") => void;
  onSelectTranslation: (key: string) => void;
  onAskSelection?: (text: string, page: number) => void;
  onCaptureImage?: (capture: RegionCapture) => void;
  onOpenModels?: () => void;
  captureEnabled?: boolean;
  onTranslationDone?: (info: TranslationDoneInfo) => void;
}

const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(
  { docId, visible, config, translations, activeKey, showBlocksTranslating, showBlocksTranslation, pageTheme, onPageThemeChange, onToggleBlocks, onSelectTranslation, onAskSelection, onCaptureImage, onOpenModels, captureEnabled = true, onTranslationDone }, ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onTranslationDone);
  doneRef.current = onTranslationDone;
  const sourceLoadedRef = useRef(false);
  const keyRef = useRef(activeKey);
  keyRef.current = activeKey;
  const pendingPageRef = useRef<{ page: number; quote?: string } | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const engineRef = useRef<ViewerEngine | null>(null);
  const captureRef = useRef(onCaptureImage);
  captureRef.current = onCaptureImage;
  const menuRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [annotVisible, setAnnotVisible] = useState(true);
  const [annotColor, setAnnotColor] = useState("yellow");
  const [inkOn, setInkOn] = useState(false);
  const [inkColor, setInkColor] = useState("yellow");
  const [inkWidth, setInkWidth] = useState<number>(4);
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [variant, setVariant] = useState("dual");
  const [pages, setPages] = useState("");
  // 页码输入框的草稿：回车 / 失焦才跳转，避免输入 "22" 的过程中先跳到第 2 页
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  // Esc 取消时 blur 会立刻触发 onBlur，用这个标记别把取消当成提交
  const pageCancelRef = useRef(false);
  const [panel, setPanel] = useState<"toc" | "thumbs" | "annots" | null>(null);
  const [outline, setOutline] = useState<{ title: string; page: number; level: number; anchor: number }[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [outlineGenerated, setOutlineGenerated] = useState(false);
  const thumbRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const thumbBodyRef = useRef<HTMLDivElement>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [themePos, setThemePos] = useState<{ left: number; top: number } | null>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const [selPop, setSelPop] = useState<{ x: number; y: number; text: string; page: number } | null>(null);
  const selPopRef = useRef<{ x: number; y: number; text: string; page: number } | null>(null);
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
  selPopRef.current = selPop;

  useEffect(() => { citationShown.current = !!citation; }, [citation]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCitation(null), 220);
  }, []);
  const cancelHide = useCallback(() => { window.clearTimeout(hideTimer.current); }, []);

  useEffect(() => {
    if (!hostRef.current) { return; }
    const engine = new ViewerEngine(
      hostRef.current,
      (s) => { statusRef.current = s; setStatus(s); },
      (info) => doneRef.current?.(info)
    );
    engine.onAnnotations = (list) => setAnnotations(list);
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 区域截图是自动触发的（文字上选词、其它地方拖框），只有 AI 助手启用时才接管
  useEffect(() => {
    if (!engineRef.current) { return; }
    engineRef.current.onCapture = captureEnabled
      ? (capture) => captureRef.current?.(capture)
      : null;
  }, [captureEnabled]);

  useEffect(() => { setPageDraft(null); }, [status?.displayPage]);

  // Load this document's source once, on mount.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !docId) { return; }
    let cancelled = false;
    void (async () => {
      const data = await window.api.libraryOpen(docId);
      if (cancelled) { return; }
      if (!data.bytes) { alert("源文件缺失"); return; }
      await engine.openSource({ bytes: new Uint8Array(data.bytes), name: data.name, sourceUrl: data.sourceUrl, docId });
      if (cancelled) { return; }
      sourceLoadedRef.current = true;
      if (keyRef.current) { await loadKey(engine, docId, keyRef.current); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Apply the selected translation whenever it changes (menu pick / completion).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !docId || !sourceLoadedRef.current || !activeKey) { return; }
    const s = statusRef.current;
    if (s?.cacheKey === activeKey && (s.phase === "done" || s.running)) { return; }
    void loadKey(engine, docId, activeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, activeKey]);

  // Push block-overlay preferences to the engine (translating vs. viewing).
  useEffect(() => {
    engineRef.current?.setBlockPrefs({ translating: showBlocksTranslating, viewing: showBlocksTranslation });
  }, [showBlocksTranslating, showBlocksTranslation]);

  // The pinned 块框 panel lives in this viewer's DOM, but drop it when the tab is hidden.
  useEffect(() => {
    if (!visible) { engineRef.current?.hideBlockTip(); }
  }, [visible]);

  // A jump requested before the document finished loading is applied once ready.
  useEffect(() => {
    const p = pendingPageRef.current;
    if (p && (status?.numPages || 0) > 0) {
      pendingPageRef.current = null;
      void engineRef.current?.focusQuote(p.page, p.quote).catch(() => undefined);
    }
  }, [status?.numPages]);

  useEffect(() => {
    function onMove(e: MouseEvent): void {
      if (!visibleRef.current) { return; }
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
      if (!visibleRef.current) { return; }
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(".citation-pop")) { return; }
      scheduleHide();
    }
    document.addEventListener("mousemove", onMove);
    // 同样用 pointerdown：框选截图时 mousedown 可能被 pointerdown.preventDefault() 抑制
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [scheduleHide]);

  // 选区按钮的位置：贴在选区最后一行的右下角（相对 viewer-stage）。
  // 每次都按"当前选区"重算，所以滚动、缩放时都能跟着走。
  const computeSelPop = useCallback((): { x: number; y: number; text: string; page: number } | null => {
    if (!visibleRef.current) { return null; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) { return null; }
    const node = sel.anchorNode;
    const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    if (!el || !el.closest || !el.closest(".text-layer")) { return null; }
    const stage = stageRef.current;
    if (!stage) { return null; }
    const range = sel.getRangeAt(0);
    // 只认"一行文字"大小的矩形：跨页/跨图时浏览器会多报整页大小的容器矩形，别拿它定位
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1 && r.height < 60);
    const last = rects[rects.length - 1];
    if (!last) { return null; }
    const sr = stage.getBoundingClientRect();
    // 选区工具条比原来的单按钮宽：右端贴选区末行，左端至少要留出整条工具条的宽度
    const barW = 352;
    return {
      x: Math.min(Math.max(barW, last.right - sr.left), Math.max(barW, sr.width - 4)),
      y: Math.min(Math.max(4, last.bottom - sr.top + 4), Math.max(4, sr.height - 34)),
      text: sel.toString().trim(),
      page: statusRef.current?.displayPage || 1
    };
  }, []);

  const annotateSelection = useCallback((kind: PdfAnnotKind, color = annotColor) => {
    engineRef.current?.annotateSelection(kind, color);
    setSelPop(null);
    window.getSelection()?.removeAllRanges();
  }, [annotColor]);



  useEffect(() => {
    function onUp(): void {
      setSelPop(computeSelPop());
    }
    function onDown(e: MouseEvent): void {
      if (!visibleRef.current) { return; }
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(".sel-tools")) { return; }
      setSelPop(null);
    }
    document.addEventListener("mouseup", onUp);
    // 用 pointerdown（而不是 mousedown）：开始区域框选时 pointerdown 会 preventDefault，
    // 兼容的 mousedown/mouseup 可能被抑制 → 旧选区按钮会残留。pointerdown 一定先到。
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("mouseup", onUp); document.removeEventListener("pointerdown", onDown, true); };
  }, [computeSelPop]);

  // 滚动时让按钮跟着选区走（滚动发生在舞台内部的 .compare 上，事件不冒泡，所以用捕获阶段听）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) { return; }
    let raf = 0;
    const onScroll = (): void => {
      if (raf) { return; }
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!selPopRef.current) { return; }
        const next = computeSelPop();
        const cur = selPopRef.current;
        if (!next) { setSelPop(null); return; }
        if (next.x === cur.x && next.y === cur.y && next.text === cur.text) { return; }
        setSelPop(next);
      });
    };
    stage.addEventListener("scroll", onScroll, true);
    return () => { if (raf) { window.cancelAnimationFrame(raf); } stage.removeEventListener("scroll", onScroll, true); };
  }, [computeSelPop]);

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
    setOutlineLoading(true);
    setOutlineGenerating(false);
    setOutlineGenerated(false);
    (async () => {
      const res = await engineRef.current?.outline(() => { if (!cancelled) { setOutlineGenerating(true); } });
      if (cancelled) { return; }
      setOutline(res?.items || []);
      setOutlineGenerated(!!res?.generated);
      setOutlineGenerating(false);
      setOutlineLoading(false);
    })();
    return () => { cancelled = true; };
  }, [panel, status?.numPages]);

  // 缩略图只渲染滚动到可见区域的那些：一次开 15 页文档时不再把 PDF worker 占满
  // （原来会把整本文档的缩略图一次性排队渲染，和正文渲染抢 worker，跳页要等很久）。
  useEffect(() => {
    if (panel !== "thumbs") { return; }
    const total = status?.numPages || 0;
    if (!total) { return; }
    let cancelled = false;
    let timer = 0;
    const queue: number[] = [];
    let running = false;
    const pump = async (): Promise<void> => {
      if (running) { return; }
      running = true;
      while (queue.length && !cancelled) {
        const p = queue.shift()!;
        const canvas = thumbRefs.current[p - 1];
        if (!canvas || canvas.dataset.rendered === "1") { continue; }
        try {
          // 先读磁盘缓存；没有再用 PDF 渲染一次并写回
          const cached = await window.api.viewerThumb(docId, p);
          if (cancelled) { return; }
          if (cached && await drawThumbImage(canvas, cached)) {
            canvas.dataset.rendered = "1";
            continue;
          }
          const ok = await engineRef.current?.renderThumbnail(p, canvas);
          if (cancelled) { return; }
          if (!ok) { continue; }
          canvas.dataset.rendered = "1";
          const jpeg = thumbJpeg(canvas);
          if (jpeg) { void window.api.viewerThumbSave(docId, p, jpeg).catch(() => undefined); }
        } catch { /* ignore */ }
      }
      running = false;
    };
    const obs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) { continue; }
        const p = Number((en.target as HTMLElement).dataset.page || 0);
        if (!p) { continue; }
        const canvas = thumbRefs.current[p - 1];
        if (!canvas || canvas.dataset.rendered === "1" || queue.includes(p)) { continue; }
        queue.push(p);
      }
      // 稍微延后：先让正文（尤其是跳页时）拿到 PDF worker
      clearTimeout(timer);
      timer = window.setTimeout(() => void pump(), 150);
    }, { root: thumbBodyRef.current, rootMargin: "300px 0px" });
    for (const c of thumbRefs.current) { if (c) { obs.observe(c); } }
    return () => { cancelled = true; clearTimeout(timer); obs.disconnect(); };
  }, [panel, status?.numPages, docId]);

  useImperativeHandle(ref, () => ({
    goToPage: (page: number, quote?: string) => {
      const engine = engineRef.current;
      if (engine && (statusRef.current?.numPages || 0) > 0) { void engine.focusQuote(page, quote).catch(() => undefined); }
      else { pendingPageRef.current = { page, quote }; }
    }
  }), []);

  const s = status;
  const hasSource = !!s?.hasSource;
  const hasTranslation = !!s?.hasTranslation;
  const running = !!s?.running;
  const numPages = s?.numPages || 0;
  const curTocPage = s?.displayPage ?? -1;
  const curTocFrac = s?.scrollFraction ?? 0;
  // active = the entry closest before the viewport, by (page, anchor); outline order
  // does not match anchor order within a page, so we cannot rely on the last match.
  // tolerance stays tiny so a heading is not "passed" by a heading just below it
  const ANCHOR_EPS = 0.005;
  let tocActive = -1;
  let bestPage = -Infinity;
  let bestAnchor = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const e = outline[i];
    if (!e.page || e.page > curTocPage) { continue; }
    if (e.page < curTocPage || e.anchor <= curTocFrac + ANCHOR_EPS) {
      if (e.page > bestPage || (e.page === bestPage && e.anchor > bestAnchor)) {
        tocActive = i; bestPage = e.page; bestAnchor = e.anchor;
      }
    }
  }
  // 进度条按"页"算：引擎自报的 tqdm 百分比只在单页内走动，页数才是整体进度
  const pct = s?.phase === "done"
    ? 100
    : (s && s.totalPages > 0 ? Math.min(100, Math.round(((s.donePages || 0) / s.totalPages) * 100)) : (s?.progress || 0));
  const showOverlay = !!s && s.phase === "error";
  const canView = (v: string): boolean => v === "source" || hasTranslation || running;
  // The toolbar toggle drives the switch that applies right now: the live preview while
  // translating, the finished translation otherwise. Without any translation there is
  // nothing to overlay, so the button stays disabled.
  const canShowBlocks = hasTranslation || running;
  const blocksOn = canShowBlocks && (running ? showBlocksTranslating : showBlocksTranslation);
  const annotSorted = [...annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);

  function toggleAnnots(): void {
    const next = !annotVisible;
    setAnnotVisible(next);
    engineRef.current?.setAnnotVisible(next);
    if (!next && inkOn) {
      setInkOn(false);
      engineRef.current?.setInkMode(false);
    }
  }

  function toggleInk(): void {
    const next = !inkOn;
    setInkOn(next);
    engineRef.current?.setInkMode(next);
    if (next) {
      setSelPop(null);
      setThemeOpen(false);
      setMenuOpen(false);
      if (!annotVisible) { setAnnotVisible(true); engineRef.current?.setAnnotVisible(true); }
    }
  }

  function closeInk(): void {
    setInkOn(false);
    engineRef.current?.setInkMode(false);
  }

  // 页码输入：只在回车 / 失焦时提交，空值、Esc 或越界就回到当前页
  function commitPage(): void {
    const raw = pageCancelRef.current ? "" : (pageDraft || "").trim();
    pageCancelRef.current = false;
    setPageDraft(null);
    const n = parseInt(raw, 10);
    if (isNaN(n)) { return; }
    const page = Math.min(Math.max(1, n), numPages || 1);
    if (page !== (s?.displayPage ?? 1)) { engineRef.current?.goToNumberedPage(page); }
  }

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
    <div className="workspace" data-page-theme={pageTheme} hidden={!hasSource || !visible}>
      <header className="toolbar">
        <div className="controls">
          <div className="tb-group">
            <button type="button" className={"panel-btn" + (panel ? " active" : "")} title="目录 / 缩略图" aria-pressed={!!panel} onClick={() => setPanel(panel ? null : "toc")}><Icon name="panel-left" small /></button>

            <div className="theme-menu" ref={themeRef}>
              <button type="button" className="theme-btn" title="页面背景" onClick={toggleTheme}>
                <span className="swatch" style={{ background: PAGE_THEMES.find((t) => t[0] === pageTheme)?.[2] }} />
              </button>
              {themeOpen && (
                <div className="menu-pop theme-pop" style={{ left: themePos?.left, top: themePos?.top }}>
                  {PAGE_THEMES.map(([id, label, color]) => (
                    <button key={id} type="button" className={"theme-item" + (pageTheme === id ? " active" : "")} onClick={() => { onPageThemeChange(id); setThemeOpen(false); }}>
                      <span className="swatch" style={{ background: color }} />
                      <span className="theme-label">{label}</span>
                      {pageTheme === id && <Icon name="check" small />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 块框：直接在阅读界面切换（对应 设置 → 外观 里的两个开关） */}
            <button
              type="button"
              className={"panel-btn" + (blocksOn ? " active" : "")}
              aria-pressed={blocksOn}
              disabled={!canShowBlocks}
              title={!canShowBlocks ? "暂无译文，没有可显示的块框" : (running ? "翻译时显示块框" : "查看译文时显示块框") + "（点击块框查看原文 / 译文）"}
              onClick={() => onToggleBlocks(running ? "translating" : "viewing")}
            >
              <Icon name="layers" small />
            </button>

            <button
              type="button"
              className={"panel-btn" + (annotVisible ? " active" : "")}
              aria-pressed={annotVisible}
              title={annotVisible ? "隐藏标注" : "显示标注"}
              onClick={toggleAnnots}
            >
              <Icon name="highlight" small />
            </button>
            <button
              type="button"
              className={"panel-btn" + (inkOn ? " active" : "")}
              aria-pressed={inkOn}
              title={inkOn ? "退出画笔" : "画笔：在 PDF 上自由绘制"}
              onClick={toggleInk}
            >
              <Icon name="pencil" small />
            </button>
          </div>

          <span className="tb-sep" />

          <div className="translate-menu" ref={menuRef}>
            {hasTranslation || running ? (
              /* 有译文（或正在翻译）时：视图切换就是主控件，箭头直接开译文菜单，不再单独放一个"翻译"按钮 */
              <div className={"segmented" + (hasTranslation ? " view-seg" : "")} role="group" aria-label="视图">
                {(["source", "compare", "target"] as const).map((v) => (
                  <button key={v} type="button" className={s?.view === v ? "active" : ""} aria-pressed={s?.view === v} disabled={!canView(v)} onClick={() => engineRef.current?.setView(v)}>
                    {v === "source" ? "原文" : v === "compare" ? "对照" : "译文"}
                  </button>
                ))}
                {hasTranslation && (
                  <button
                    type="button"
                    className="view-more"
                    title="译文文件与翻译选项"
                    aria-label="译文文件与翻译选项"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={toggleMenu}
                  >
                    <Icon name="chev-down" small />
                  </button>
                )}
              </div>
            ) : (
              <div className="split">
                <button className="split-main" onClick={start}>翻译</button>
                <button className="split-caret" title="翻译选项" aria-label="翻译选项" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}>
                  <Icon name="chev-down" small />
                </button>
              </div>
            )}
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
                </div>

                {hasTranslation && (
                  <>
                    <button type="button" className="menu-item" disabled={running} onClick={() => { setMenuOpen(false); void engineRef.current?.save(variant); }}>
                      <Icon name="file" small />
                      <span className="menu-item-name">导出译文文件…</span>
                    </button>
                    <button type="button" className="primary menu-action" disabled={running} onClick={start}>重新翻译</button>
                  </>
                )}
              </div>
            )}
          </div>

          <span className="tb-sep" />

          <div className="segmented" role="group" aria-label="版面">
            <button type="button" className={s?.layout === "single" ? "active" : ""} aria-pressed={s?.layout === "single"} title="单页" onClick={() => engineRef.current?.setLayout("single")}>单页</button>
            <button type="button" className={s?.layout === "double" ? "active" : ""} aria-pressed={s?.layout === "double"} title="双页" onClick={() => engineRef.current?.setLayout("double")}>双页</button>
          </div>

          <span className="tb-spacer" />

          {numPages > 0 && (
            <div className="navgroup" role="group" aria-label="页码">
              <button type="button" title="上一页" aria-label="上一页" disabled={(s?.displayPage ?? 1) <= 1} onClick={() => engineRef.current?.prevPage()}><Icon name="chev-left" small /></button>
              <input
                type="text"
                inputMode="numeric"
                aria-label="当前页"
                title="输入页码后回车跳转"
                value={pageDraft ?? String(s?.displayPage ?? 1)}
                style={{ width: `calc(${Math.max(2, String(numPages).length)}ch + 8px)` }}
                onFocus={(e) => { e.currentTarget.select(); setPageDraft(String(s?.displayPage ?? 1)); }}
                onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); }
                  else if (e.key === "Escape") { e.stopPropagation(); pageCancelRef.current = true; setPageDraft(null); e.currentTarget.blur(); }
                }}
                onBlur={commitPage}
              />
              <span className="nav-total">/ {numPages}</span>
              <button type="button" title="下一页" aria-label="下一页" disabled={(s?.displayPage ?? 1) >= numPages} onClick={() => engineRef.current?.nextPage()}><Icon name="chev-right" small /></button>
            </div>
          )}
          {numPages > 0 && (
            <div className="navgroup" role="group" aria-label="缩放">
              <button type="button" title="缩小" aria-label="缩小" onClick={() => engineRef.current?.zoomBy(1 / 1.15)}><Icon name="zoom-out" small /></button>
              <button type="button" className="zoom-level" title="重置为 100%" onClick={() => engineRef.current?.setZoom(1)}>{Math.round((s?.zoom || 1) * 100)}%</button>
              <button type="button" title="放大" aria-label="放大" onClick={() => engineRef.current?.zoomBy(1.15)}><Icon name="zoom-in" small /></button>
            </div>
          )}

          {running && <button type="button" className="danger" onClick={() => engineRef.current?.cancel()}>取消</button>}
        </div>
      </header>

      {running && (
        <div className="run-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="run-bar-fill" style={{ width: pct + "%" }} />
          <div className="run-bar-line" style={{ width: pct + "%" }} />
          <div className="run-bar-text">
            <span className="spinner" />
            <span className="run-bar-phase">{s?.message || "翻译中"}</span>
            <span className="run-bar-pct">{Math.round(pct)}%</span>
            {(s?.totalPages || 0) > 0 && <span>已完成 {s?.donePages || 0}/{s?.totalPages} 页</span>}
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
              <button type="button" className={panel === "annots" ? "active" : ""} onClick={() => setPanel("annots")}>标注</button>
            </div>
            <div className="outline-body" ref={thumbBodyRef}>
              {panel === "annots" ? (
                annotSorted.length === 0
                  ? <div className="outline-empty">选中正文文字可添加高亮或笔记；用工具栏的画笔可在页面上自由绘制；点击页面上的标注可改颜色、写笔记、插图或加链接。</div>
                  : (
                    <div className="annot-list">
                      {annotSorted.map((a) => {
                        const note = (a.note || "").trim();
                        const quote = (a.text || "").trim();
                        const images = a.images || [];
                        const links = a.links || [];
                        const empty = a.kind === "note" && !note && !quote && !images.length && !links.length;
                        return (
                          <div key={a.id} className="annot-row" data-color={a.color || "yellow"}>
                            <button type="button" className="annot-row-main" title="点击定位；在页面上点击该标注可查看 / 编辑" onClick={() => void engineRef.current?.focusAnnotation(a.id)}>
                              <span className="annot-row-head">
                                <span className="annot-dot" data-color={a.color || "yellow"} />
                                <Icon name={ANNOT_KIND_ICON[a.kind]} small />
                                <span className="annot-row-kind">{annotHeading(a)}</span>
                                <span className="annot-row-page">第 {a.page} 页</span>
                              </span>
                              {quote && <span className="annot-quote">{quote}</span>}
                              {note && <span className="annot-note">{note}</span>}
                              {empty && <span className="annot-empty">空笔记</span>}
                              {(images.length > 0 || links.length > 0) && (
                                <span className="annot-media">
                                  {images.map((src, i) => (
                                    <img key={i} className="annot-thumb" src={src} alt="" loading="lazy" title={`图片 ${i + 1}`} />
                                  ))}
                                  {links.map((url, i) => (
                                    <span key={i} className="annot-link" title={url}>
                                      <Icon name="link" small />
                                      <span className="annot-link-label">{linkLabel(url)}</span>
                                    </span>
                                  ))}
                                </span>
                              )}
                            </button>
                            <button type="button" className="annot-row-del" title="删除标注" onClick={() => engineRef.current?.removeAnnotation(a.id)}>
                              <Icon name="trash" small />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
              ) : panel === "toc"
                ? (outlineLoading
                  ? <div className="outline-empty">{outlineGenerating ? "原pdf无目录，正在生成目录…" : "正在读取目录…"}</div>
                  : outline.length === 0
                    ? <div className="outline-empty">无目录</div>
                    : (
                      <>
                        {outlineGenerated && <div className="outline-note">原 PDF 无书签，目录为自动生成</div>}
                        {outline.map((it, i) => (
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
                        ))}
                      </>
                    ))
                : Array.from({ length: s?.numPages || 0 }, (_, i) => i + 1).map((p) => (
                  <button key={p} type="button" className={"thumb" + (p === (s?.displayPage ?? -1) ? " active" : "")} onClick={() => engineRef.current?.goToNumberedPage(p)}>
                    <span className="thumb-page"><canvas data-page={p} ref={(el) => { thumbRefs.current[p - 1] = el; }} /></span>
                    <span className="thumb-no">{p}</span>
                  </button>
                ))}
            </div>
          </aside>
        )}
        <div className="viewer-stage" ref={stageRef}>
          <div ref={hostRef} />
          {selPop && (
            <div
              className="sel-tools"
              style={{ left: selPop.x, top: selPop.y }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {ANNOT_COLORS.map(([color, label]) => (
                <button
                  key={color}
                  type="button"
                  className={"sel-tool sel-dot" + (annotColor === color ? " active" : "")}
                  data-color={color}
                  title={"标注颜色：" + label}
                  onClick={() => setAnnotColor(color)}
                />
              ))}
              <span className="sel-sep" />
              <button type="button" className="sel-tool" title="高亮（当前颜色）" onClick={() => annotateSelection("highlight")}>
                <Icon name="highlight" small />
              </button>
              <button type="button" className="sel-tool" title="下划线（当前颜色）" onClick={() => annotateSelection("underline")}>
                <Icon name="underline" small />
              </button>
              <button type="button" className="sel-tool" title="删除线（当前颜色）" onClick={() => annotateSelection("strike")}>
                <Icon name="strike" small />
              </button>
              <button type="button" className="sel-tool" title="添加笔记（可写文字 / 插图片 / 加链接）" onClick={() => annotateSelection("note")}>
                <Icon name="note" small />
              </button>
              <span className="sel-sep" />
              <button
                type="button"
                className="sel-tool sel-tool-wide"
                title="把选中的文字发给 AI 助手"
                onClick={() => { onAskSelection?.(selPop.text, selPop.page); setSelPop(null); window.getSelection()?.removeAllRanges(); }}
              >
                <Icon name="arxiver" small /> 问
              </button>
            </div>
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
          {inkOn && (
            <div className="ink-bar" role="toolbar" aria-label="画笔工具">
              <span className="ink-bar-label"><Icon name="pencil" small />画笔</span>
              <span className="ink-sep" />
              <span className="ink-dots">
                {ANNOT_COLORS.map(([color, label]) => (
                  <button
                    key={color}
                    type="button"
                    className={"ink-dot" + (inkColor === color ? " active" : "")}
                    data-color={color}
                    title={`画笔颜色：${label}`}
                    onClick={() => { setInkColor(color); engineRef.current?.setInkColor(color); }}
                  />
                ))}
              </span>
              <span className="ink-sep" />
              <span className="ink-sizes">
                {INK_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={"ink-size" + (inkWidth === w ? " active" : "")}
                    title={`笔触 ${w}px`}
                    onClick={() => { setInkWidth(w); engineRef.current?.setInkWidth(w); }}
                  >
                    <span className="ink-size-dot" style={{ width: w + 2, height: w + 2 }} />
                  </button>
                ))}
              </span>
              <span className="ink-sep" />
              <button type="button" className="icon-btn ink-bar-btn" title="撤销最后一笔" onClick={() => engineRef.current?.undoInk()}><Icon name="undo" small /></button>
              <button type="button" className="icon-btn ink-bar-btn" title="清除本页画笔" onClick={() => engineRef.current?.clearInk(s?.displayPage)}><Icon name="trash" small /></button>
              <button type="button" className="icon-btn ink-bar-btn" title="退出画笔" onClick={closeInk}><Icon name="x" small /></button>
            </div>
          )}
        </div>
        {showOverlay && (
          <div className="status-panel">
            <div className="status-title">翻译失败</div>
            <pre className="error">{s?.error}</pre>
            {onOpenModels && /模型/.test(s?.error || "") && (
              <button className="btn btn-primary" onClick={onOpenModels}>去下载模型</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default Viewer;
