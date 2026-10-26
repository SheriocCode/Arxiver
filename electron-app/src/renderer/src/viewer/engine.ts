import { getPdfjs } from "../lib/pdf";
import { normalizeImage, readImageFile } from "../lib/images";
import type { BlockEvent, JobSummary, PdfAnnotation, PdfAnnotKind, PdfAnnotRect, PdfInkStroke, TransParams } from "../../../shared/types";
import { zoomImage } from "../lib/lightbox";

export type View = "source" | "target" | "compare";
export type Layout = "single" | "double";
export type Phase = "idle" | "loading" | "running" | "done" | "error";

export interface ViewerStatus {
  title: string;
  phase: Phase;
  hasSource: boolean;
  hasTranslation: boolean;
  running: boolean;
  message: string;
  error: string | null;
  cached: boolean;
  progress: number | null;
  donePages: number;
  totalPages: number;
  currentPage: number;
  pageDone: number;
  pageTotal: number;
  blockPage: number;
  blockIndex: number;
  blockTotal: number;
  logTail: string;
  view: View;
  layout: Layout;
  numPages: number;
  displayPage: number;
  scrollFraction: number;
  zoom: number;
  sourceUrl: string;
  docId: string;
  jobId: string | null;
  cacheKey: string | null;
  resultName: string;
  targetLang: string;
  pages: string;
}

export interface TranslationDoneInfo {
  docId: string;
  params: TransParams;
  cacheKey: string;
  resultName: string;
}

// 区域截图：除了图片本身，还带上页码 / 页面纵向位置 / 区域内的文字，
// 让模型即使在图里认不出小字，也能靠这些上下文定位到原文。
export interface RegionCapture {
  dataUrl: string;
  page: number;
  anchor: number;
  text: string;
}

// 文本层里按行聚合后的一行文字（client 坐标）：用于判断起手点是否在文字上
interface TextLine {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// 当前选区按页拆出来的高亮矩形（client 坐标）：画选区高亮和存标注共用
interface SelSegment {
  page: number;
  text: string;
  rects: { left: number; top: number; width: number; height: number }[];
}

const ANNOT_COLORS = ["yellow", "green", "blue", "pink"] as const;
const ANNOT_LABELS: Record<PdfAnnotKind, string> = {
  highlight: "高亮", underline: "下划线", strike: "删除线", note: "笔记", ink: "画笔"
};
const ANNOT_COLOR_LABELS: Record<string, string> = { yellow: "黄色", green: "绿色", blue: "蓝色", pink: "粉色" };
const SVG_NS = "http://www.w3.org/2000/svg";

function annotId(): string {
  return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function clamp01(n: number): number { return Math.min(1, Math.max(0, n)); }
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  if (!len) { return Math.hypot(px - x1, py - y1); }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 空白笔记 / 没填链接的标注：不留在页面和侧栏里（历史版本可能存过）
function isEmptyAnnot(a: PdfAnnotation): boolean {
  if (a.kind === "ink") { return !(a.strokes && a.strokes.length); }
  if (a.kind !== "note") { return false; }
  return !(a.note || "").trim() && !(a.images && a.images.length) && !(a.links && a.links.length);
}

// 译文里保留的公式 / 富文本占位符（{v0} / {{v0}} / {v*}）：不并进正文，单独渲染成带颜色的 chip
const BLOCK_PLACEHOLDER = /\{\{?\s*v\s*[\d*]+(?:\s*[\d*]+)*\s*\}?\}/gi;

// 引用定位用的文本归一化：忽略大小写、空白、标点与连字差异，
// 这样 AI 从抽取文本里抄来的片段也能在 PDF.js 的文本层里对上。
const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
function quoteChar(ch: string): string {
  const lig = LIGATURES[ch];
  if (lig) { return lig; }
  return /[0-9a-z\u4e00-\u9fff]/.test(ch) ? ch : "";
}
function quoteNorm(s: string): string {
  let out = "";
  for (const ch of String(s || "").toLowerCase()) { out += quoteChar(ch); }
  return out;
}

function fillBlockText(el: Element | null, text: string, empty: string, vars?: Record<string, string>): void {
  if (!el) { return; }
  const box = el as HTMLElement;
  const s = String(text || "").trim();
  box.textContent = "";
  box.classList.toggle("is-empty", !s);
  if (!s) { box.textContent = empty; return; }
  let last = 0;
  for (const m of s.matchAll(BLOCK_PLACEHOLDER)) {
    const i = m.index ?? 0;
    if (i > last) { box.appendChild(document.createTextNode(s.slice(last, i))); }
    const raw = m[0].replace(/\s+/g, "");
    const id = /\d+/.exec(raw)?.[0] || "";
    // 引擎抽到公式文本就显示真实内容，抽不出来（数学字体没有 ToUnicode）退回 {vN}
    const formula = id ? vars?.[id] : "";
    const chip = document.createElement("span");
    chip.className = formula ? "vph is-formula" : "vph";
    chip.textContent = formula || raw;
    chip.title = formula ? `公式 v${id}：${formula}` : "公式 / 格式占位符：PDF 里单独排版，这里只标出位置";
    box.appendChild(chip);
    last = i + m[0].length;
  }
  if (last < s.length) { box.appendChild(document.createTextNode(s.slice(last))); }
}

type SessionState = "running" | "done" | "error" | "cancelled";

// A translation job lives here, keyed by docId, and keeps polling independently of
// which document is currently displayed. The engine only mirrors the session of the
// active document; switching documents no longer interrupts a running translation.
interface DocSession {
  docId: string;
  jobId: string;
  params: Partial<TransParams>;
  state: SessionState;
  job: JobSummary | null;
  error: string | null;
  cacheKey: string | null;
  resultName: string;
  blocksByPage: Record<number, BlockEvent[]>;
  partial: Uint8Array | null;
  result: Uint8Array | null;
  lastPartialKey: string;
  lastBlocksKey: string;
}

interface OpenPayload { bytes: Uint8Array; name: string; sourceUrl?: string; docId?: string }

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function toU8(d: Uint8Array | ArrayBuffer): Uint8Array { return d instanceof Uint8Array ? d : new Uint8Array(d); }

export class ViewerEngine {
  private host: HTMLElement;
  private root: HTMLElement;
  private onStatus: (s: ViewerStatus) => void;

  private sourceBytes: Uint8Array | null = null;
  private rightBytes: Uint8Array | null = null;
  private sourceName = "";
  private sourceUrl = "";
  private docId = "";
  private sessions = new Map<string, DocSession>();
  private active: DocSession | null = null;
  private onDone: ((info: TranslationDoneInfo) => void) | null = null;

  private leftDoc: any = null;
  private rightDoc: any = null;

  private leftSlots: Record<number, HTMLCanvasElement> = {};
  private rightSlots: Record<number, HTMLCanvasElement | null> = {};
  private pageWrap: Record<number, HTMLElement> = {};
  private blockLayer: Record<number, HTMLElement> = {};
  private linkLayer: Record<number, HTMLElement> = {};
  private rightLayer: Record<number, HTMLElement> = {};
  private pageSize: Record<number, { w: number; h: number }> = {};
  private renderedW: Record<number, number> = {};
  private renderedWR: Record<number, number> = {};
  private blocksByPage: Record<number, BlockEvent[]> = {};
  private linksByPage: Record<number, { page: number; rect: number[]; anchor: number; url?: string }[]> = {};
  private annotLayer: Record<number, HTMLElement> = {};
  private annotations: PdfAnnotation[] = [];
  private annotVisible = true;
  // 点在高亮 / 下划线 / 删除线 / 笔记区域上（不是拖选文字）→ 打开编辑面板
  private annotDown: { x: number; y: number } | null = null;
  private annotClickTimer = 0;
  private annotHoverId: string | null = null;
  private annotHoverRaf = 0;
  // 标注变化（新增/编辑/删除/加载完成）时通知 React（侧栏列表、按钮状态）
  onAnnotations: ((list: PdfAnnotation[]) => void) | null = null;
  private annotTipEl: HTMLElement | null = null;
  private annotTipId = "";
  private annotTipOutside: ((e: MouseEvent) => void) | null = null;
  private annotTipKey: ((e: KeyboardEvent) => void) | null = null;
  // 正在读取 / 压缩图片：此时别把"看起来还空"的笔记当成空白取消掉
  private tipImageBusy = false;
  // 面板里的笔记直接编辑、自动保存（没有独立的"编辑 / 保存 / 取消"模式）
  private annotSaveTimer = 0;
  // 画笔模式（自由手写）
  private inkMode = false;
  private inkColor = "yellow";
  private inkWidth = 4;
  private inkLiveCancel: (() => void) | null = null;
  private lastInkPage = 0;

  private rows: HTMLElement[] = [];
  private rowFirstPage: number[] = [];
  private currentPageIndex = 0;

  private basePageW = 0;
  private zoom = 1;
  private view: View = "source";
  private layout: Layout = "single";
  private blockPrefs = { translating: true, viewing: true };
  private totalPages = 0;
  // scrollTop we set ourselves during a jump; the matching scroll event must not
  // overwrite the requested page (in double-page layout it is only the left page)
  private expectedScrollTop = -1;
  private buildGen = 0;

  private status: ViewerStatus;
  private blockTipEl: HTMLElement | null = null;
  private blockTipRect: HTMLElement | null = null;
  private blockTipKey: { page: number; index: number } | null = null;
  private blockTipOutside: ((e: MouseEvent) => void) | null = null;
  // 用户拖动过面板之后就不再跟随块框（否则一滚动就被拽回去）
  private blockTipMoved = false;
  // 区域截图（自动模式：文字上选文字、其它地方拖框截图）
  // Viewer 设置回调；为 null 时（AI 助手未启用）不启用区域截图
  onCapture: ((capture: RegionCapture) => void) | null = null;
  private regionEl: HTMLElement | null = null;
  private regionCancel: (() => void) | null = null;
  private renderInFlight = false;
  private renderTimer = 0;
  private selRaf = 0;
  private settling = false;
  private inkCtx: CanvasRenderingContext2D | null = null;
  private inkCache = new WeakMap<HTMLElement, { lead: number; width: number }>();
  private spanCache = new WeakMap<HTMLElement, HTMLElement[]>();
  private sizeCache = new WeakMap<HTMLElement, number>();
  private bodyCache = new WeakMap<HTMLElement, number>();
  private smallCache = new WeakMap<HTMLElement, boolean>();
  // AI 引用跳转后要高亮的原文片段（页码 + 片段），缩放/重绘时按它重新画
  private quotePage = 0;
  private quoteText = "";



  constructor(host: HTMLElement, onStatus: (s: ViewerStatus) => void, onDone?: (info: TranslationDoneInfo) => void) {
    this.host = host;
    this.onStatus = onStatus;
    this.onDone = onDone || null;
    this.root = document.createElement("div");
    this.root.className = "compare";
    this.root.hidden = true;
    host.appendChild(this.root);
    this.status = this.blank();
    this.root.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
    this.root.addEventListener("pointerdown", this.onPagePointerDown);
    this.root.addEventListener("pointerdown", this.onAnnotPointerDown);
    this.root.addEventListener("click", this.onAnnotClick);
    this.root.addEventListener("pointermove", this.onAnnotHover);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("mouseup", this.onSelectionSettle);
    document.addEventListener("pointerdown", this.onQuotePointerDown);
    let raf = 0;
    this.root.addEventListener("scroll", () => {
      if (raf) { return; }
      raf = requestAnimationFrame(() => { raf = 0; this.updateCurrentPage(); this.followBlockTip(); this.followAnnotTip(); this.scheduleRender(120); });
    });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
        this.followBlockTip();
        if (!this.leftDoc) { return; }
        const cw = this.root.clientWidth;
        if (cw <= 0) { return; }
        const w = this.computeFitWidth();
        if (Math.abs(w - this.basePageW) > 1) { this.basePageW = w; this.applyPageWidth(); this.scheduleRender(60); }
      }).observe(this.root);
    }
  }

  private blank(): ViewerStatus {
    return {
      title: "未命名", phase: "idle", hasSource: false, hasTranslation: false, running: false,
      message: "", error: null, cached: false, progress: null,
      donePages: 0, totalPages: 0, currentPage: 0, pageDone: 0, pageTotal: 0,
      blockPage: 0, blockIndex: 0, blockTotal: 0, logTail: "",
      view: this.view, layout: this.layout,
      numPages: 0, displayPage: 1, scrollFraction: 0, zoom: 1, sourceUrl: "", docId: "", jobId: null, cacheKey: null, resultName: "",
      targetLang: "", pages: ""
    };
  }

  private emit(patch: Partial<ViewerStatus> = {}): void {
    this.status = { ...this.status, ...patch };
    this.onStatus({ ...this.status });
  }

  private async ensureWidth(): Promise<void> {
    for (let i = 0; i < 12 && this.root.clientWidth === 0; i++) { await delay(16); }
  }

  private perRow(): number { return this.layout === "double" ? 2 : 1; }
  private colsPerPage(): number { return this.view === "compare" ? 2 : 1; }

  private computeFitWidth(): number {
    const available = this.root.clientWidth - 24;
    const cols = this.perRow() * this.colsPerPage();
    return Math.max(160, cols <= 1 ? available : (available - (cols - 1) * 12) / cols);
  }
  private pageWidth(): number { return Math.max(80, this.basePageW * this.zoom); }

  private applyPageWidth(): void {
    this.root.style.setProperty("--page-w", this.pageWidth() + "px");
    this.root.style.setProperty("--cols", String(this.perRow() * this.colsPerPage()));
    this.updateTextLayers();
    // 缩放/换宽度后，已经画好的选区高亮、引用高亮、标注都是按旧的显示尺寸画的，重画一次
    this.paintSelection();
    this.repaintQuote();
    this.renderAllAnnots();
  }

  private blankCanvas(): HTMLCanvasElement { const c = document.createElement("canvas"); c.className = "pdf-canvas"; return c; }

  private classForView(): void {
    this.root.classList.remove("mode-source", "mode-target", "mode-compare");
    this.root.classList.add("mode-" + this.view);
  }

  private async renderCell(canvas: HTMLCanvasElement, doc: any, page: number, width: number): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: (width / base.width) * dpr });
    const w = Math.max(1, Math.floor(viewport.width));
    const h = Math.max(1, Math.floor(viewport.height));
    const scratch = document.createElement("canvas");
    scratch.width = w; scratch.height = h;
    await p.render({ canvasContext: scratch.getContext("2d"), viewport }).promise;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(scratch, 0, 0);
    const wrap = canvas.parentElement;
    if (wrap) {
      const existing = wrap.querySelector<HTMLElement>(".text-layer");
      if (!existing || existing.dataset.refw !== String(this.basePageW)) {
        await this.renderTextLayer(wrap, p, base.width, this.basePageW);
      }
    }
  }

  private updateTextLayers(): void {
    const scale = String(this.zoom);
    this.root.querySelectorAll<HTMLElement>(".text-layer").forEach((layer) => { layer.style.transform = `scale(${scale})`; });
  }

  // ---- 选区高亮 / 智能选区 ----------------------------------------------------

  private textSpans(layer: HTMLElement): HTMLElement[] {
    const cache = this.spanCache.get(layer);
    if (cache) { return cache; }
    const out: HTMLElement[] = [];
    layer.querySelectorAll<HTMLElement>("span").forEach((s) => {
      // 只认真正有字的：跳过 pdf.js 的标记/换行元素，也跳过竖排的（arXiv 水印等）
      if (!s.textContent || !s.textContent.trim()) { return; }
      if (/rotate/i.test(s.style.transform || "")) { return; }
      out.push(s);
    });
    this.spanCache.set(layer, out);
    return out;
  }

  private fontSizeOf(el: HTMLElement): number {
    const cached = this.sizeCache.get(el);
    if (cached !== undefined) { return cached; }
    const size = parseFloat(window.getComputedStyle(el).fontSize) || 0;
    this.sizeCache.set(el, size);
    return size;
  }

  // 该页的"正文字号"：占字符最多的那个字号。脚注、图注、图表里的标签、页眉页脚页码都比它小。
  private bodySize(layer: HTMLElement): number {
    const cached = this.bodyCache.get(layer);
    if (cached !== undefined) { return cached; }
    const counts = new Map<number, number>();
    for (const s of this.textSpans(layer)) {
      const size = this.fontSizeOf(s);
      if (!size) { continue; }
      counts.set(size, (counts.get(size) || 0) + (s.textContent || "").length);
    }
    let body = 0; let best = -1;
    for (const [size, n] of counts) { if (n > best) { best = n; body = size; } }
    this.bodyCache.set(layer, body);
    return body;
  }

  // 这段文字是不是"小字"（脚注/图注/图表内标签/页码…）。子/上标虽然也小，但它和正文同处一行，
  // 所以要看它所在的竖直范围里有没有正文大小的文字——有就说明它属于正文行。
  private isSmallText(el: HTMLElement): boolean {
    const cached = this.smallCache.get(el);
    if (cached !== undefined) { return cached; }
    let small = false;
    const layer = el.closest(".text-layer") as HTMLElement | null;
    if (layer) {
      const body = this.bodySize(layer);
      const size = this.fontSizeOf(el);
      if (body > 0 && size > 0 && size < body * 0.92) {
        const b = el.getBoundingClientRect();
        const cy = b.top + b.height / 2;
        let sameLine = false;
        for (const other of this.textSpans(layer)) {
          if (other === el || this.fontSizeOf(other) < body * 0.92) { continue; }
          const ob = other.getBoundingClientRect();
          if (Math.abs(ob.top + ob.height / 2 - cy) < Math.max(b.height, ob.height) * 0.7) { sameLine = true; break; }
        }
        small = !sameLine;
      }
    }
    this.smallCache.set(el, small);
    return small;
  }

  private spanOf(node: Node | null): HTMLElement | null {
    if (!node) { return null; }
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const span = el ? (el.closest("span") as HTMLElement | null) : null;
    return span && this.root.contains(span) ? span : null;
  }

  // 阅读顺序（页 → 行）：用来把"拖过头"的那一端收回到起点那一类文字的边界
  private readingOrder(): HTMLElement[] {
    const out: HTMLElement[] = [];
    this.root.querySelectorAll<HTMLElement>(".page-wrap").forEach((wrap) => {
      const layer = wrap.querySelector<HTMLElement>(".text-layer");
      if (!layer) { return; }
      const spans = this.textSpans(layer).slice();
      spans.sort((a, b) => {
        const ab = a.getBoundingClientRect(); const bb = b.getBoundingClientRect();
        return Math.abs(ab.top - bb.top) > 3 ? ab.top - bb.top : ab.left - bb.left;
      });
      out.push(...spans);
    });
    return out;
  }

  // 松开鼠标时：如果拖到了"另一类"文字里（正文 ↔ 小字），把那一端收回到边界上，
  // 这样复制出来的就是用户真正要的那段（脚注/图注/页码不会被带走）。
  private onSelectionSettle = (): void => {
    if (this.settling) { return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { return; }
    const range = sel.getRangeAt(0);
    const a = this.spanOf(sel.anchorNode);
    const f = this.spanOf(sel.focusNode);
    if (!a || !f || a === f) { return; }
    const aSmall = this.isSmallText(a);
    if (this.isSmallText(f) === aSmall) { return; }
    const order = this.readingOrder();
    const ia = order.indexOf(a);
    const ifi = order.indexOf(f);
    if (ia < 0 || ifi < 0) { return; }
    let target: HTMLElement | null = null;
    if (ia < ifi) {
      for (let i = ifi - 1; i > ia; i--) { if (this.isSmallText(order[i]) === aSmall) { target = order[i]; break; } }
    } else {
      for (let i = ifi + 1; i < ia; i++) { if (this.isSmallText(order[i]) === aSmall) { target = order[i]; break; } }
    }
    if (!target || !target.firstChild) { return; }
    // 只信"阅读顺序"和"DOM 顺序"一致的情况，别把选区搞反
    const between = ia < ifi
      ? (a.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        && (target.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : (target.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        && (f.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (!between) { return; }
    const keep = range.cloneRange();
    this.settling = true;
    try {
      if (ia < ifi) { range.setEnd(target.firstChild, (target.textContent || "").length); }
      else { range.setStart(target.firstChild, 0); }
      sel.removeAllRanges();
      sel.addRange(range);
      // 万一收窄把选区弄空了，就还原（宁可多选，也不能什么都不剩）
      if (!sel.toString().trim()) { sel.removeAllRanges(); sel.addRange(keep); }
    } catch { /* 特殊情况就不改了 */ }
    this.settling = false;
    this.paintSelection();
  };

  // 选区高亮自己画（原生高亮见 styles.css 里置为透明的原因）：
  // 选区的每个矩形都按"最贴的那一行文字"的行框高度来画，所以高亮正好贴着字形、不会上下叠。
  private onSelectionChange = (): void => {
    if (this.selRaf) { return; }
    this.selRaf = requestAnimationFrame(() => { this.selRaf = 0; this.paintSelection(); });
  };

  // 当前选区按页拆成"贴行"的矩形：画选区高亮和保存标注都走这一份，保证两者位置一致。
  private selectionSegments(): SelSegment[] {
    if (this.root.hidden || this.root.clientWidth === 0) { return []; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) { return []; }
    const node = sel.anchorNode;
    const anchor = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    if (!anchor || !this.root.contains(anchor)) { return []; }
    // 起点落在哪一类文字里（正文 / 小字）：高亮只画同类，跨图/跨页时不会把脚注、图注、
    // 图表里的标签、页码一起点亮（用户要选它们时会从它们里面起手）。
    const anchorSpan = this.spanOf(sel.anchorNode);
    const anchorSmall = anchorSpan ? this.isSmallText(anchorSpan) : false;
    const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) { return []; }
    const text = sel.toString().replace(/\s+/g, " ").trim();
    let minY = Infinity; let maxY = -Infinity;
    for (const r of rects) { minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom); }
    const out: SelSegment[] = [];
    this.root.querySelectorAll<HTMLElement>(".page-wrap").forEach((wrap) => {
      const textLayer = wrap.querySelector<HTMLElement>(".text-layer");
      if (!textLayer) { return; }
      const wr = wrap.getBoundingClientRect();
      if (wr.width <= 0 || wr.height <= 0 || wr.bottom < minY || wr.top > maxY) { return; }
      const lines: { top: number; height: number; left: number; width: number; el: HTMLElement; small: boolean }[] = [];
      this.textSpans(textLayer).forEach((span) => {
        const b = span.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) { return; }
        lines.push({ top: b.top, height: b.height, left: b.left, width: b.width, el: span, small: this.isSmallText(span) });
      });
      if (!lines.length) { return; }
      const seen = new Set<string>();
      const segRects: SelSegment["rects"] = [];
      for (const r of rects) {
        if (r.right < wr.left || r.left > wr.right) { continue; }
        // 找"和这个矩形最贴的那一行"：
        //   ① 高度最接近（正常文字行 ≈ 1em；旋转的水印/容器整行框会差很多）
        //   ② 纵向重叠最多   ③ 横向重叠最多（同一行会被拆成多个 span，如 "1" + " " + "Introduction"，
        //   跨页/跨图选择时浏览器还可能多报一个"整行宽"的容器矩形，靠横向重叠才能落到真正被选中的那段）
        let line: typeof lines[number] | null = null;
        let bestScore = Infinity;
        for (const ln of lines) {
          if (ln.small !== anchorSmall) { continue; }
          const o = Math.min(r.bottom, ln.top + ln.height) - Math.max(r.top, ln.top);
          if (o <= 0) { continue; }
          const ox = Math.min(r.right, ln.left + ln.width) - Math.max(r.left, ln.left);
          if (ox <= 0) { continue; }
          // 高度差太多的不算
          if (ln.height < r.height * 0.45 || ln.height > r.height * 1.8) { continue; }
          const score = Math.abs(ln.height - r.height) - o * 1e-3 - ox * 1e-6;
          if (score < bestScore) { bestScore = score; line = ln; }
        }
        if (!line) { continue; }
        // 浏览器有时会给出"整行宽"的矩形（跨页 / 跨图时），而文字只占其中一段：
        // 用这一行自己的"有墨范围"（去掉首尾空白）收窄，别让高亮横跨整页。
        const ink = this.inkRatio(line.el);
        const inkWidth = line.width * ink.width;
        if (inkWidth < 1) { continue; }
        let left = r.left;
        let width = r.width;
        if (width > inkWidth + 1) { left = line.left + line.width * ink.lead; width = inkWidth; }
        // 同一行会给出多个矩形（原生多报一个"字体内容区"的矩形），按最终画出来的位置去重
        const key = Math.round(left) + ":" + Math.round(line.top) + ":" + Math.round(width);
        if (seen.has(key)) { continue; }
        seen.add(key);
        segRects.push({ left, top: line.top, width, height: line.height });
      }
      if (segRects.length) { out.push({ page: Number(wrap.dataset.page || 0), text, rects: segRects }); }
    });
    return out;
  }

  private paintSelection(): void {
    const selLayers = this.root.querySelectorAll<HTMLElement>(".sel-layer");
    for (const l of selLayers) { if (l.childElementCount) { l.innerHTML = ""; } }
    if (this.root.hidden || this.root.clientWidth === 0) { return; }
    for (const seg of this.selectionSegments()) {
      const wrap = this.pageWrap[seg.page];
      const selLayer = wrap?.querySelector<HTMLElement>(".sel-layer");
      if (!wrap || !selLayer) { continue; }
      const wr = wrap.getBoundingClientRect();
      for (const r of seg.rects) {
        const el = document.createElement("div");
        el.className = "sel-highlight";
        el.style.left = (r.left - wr.left) + "px";
        el.style.top = (r.top - wr.top) + "px";
        el.style.width = r.width + "px";
        el.style.height = r.height + "px";
        selLayer.appendChild(el);
      }
    }
  }

  // 一段文字里"真正有墨"的那部分（去掉首尾空白），用 canvas 按它自己的字体量出比例。
  // 结果与缩放无关（比例只跟字体/文本有关），所以按 span 缓存。
  private inkRatio(span: HTMLElement): { lead: number; width: number } {
    const cached = this.inkCache.get(span);
    if (cached) { return cached; }
    let ratio = { lead: 0, width: 1 };
    const text = span.textContent || "";
    if (text) {
      const cs = window.getComputedStyle(span);
      if (!this.inkCtx) { this.inkCtx = document.createElement("canvas").getContext("2d"); }
      const ctx = this.inkCtx;
      if (ctx) {
        ctx.font = cs.fontSize + " " + cs.fontFamily;
        const full = ctx.measureText(text).width;
        if (full > 0) {
          const lead = text.length - text.trimStart().length;
          const leadW = lead > 0 ? ctx.measureText(text.slice(0, lead)).width : 0;
          const trimmed = text.trim();
          const inkW = trimmed ? ctx.measureText(trimmed).width : 0;
          ratio = { lead: leadW / full, width: inkW / full };
        }
      }
    }
    this.inkCache.set(span, ratio);
    return ratio;
  }

  private clearSelection(): void {
    if (this.selRaf) { window.cancelAnimationFrame(this.selRaf); this.selRaf = 0; }
    this.root.querySelectorAll<HTMLElement>(".sel-layer").forEach((l) => { if (l.childElementCount) { l.innerHTML = ""; } });
  }

  // ---- 标注（高亮 / 笔记 / 标记文字 / 链接；图片作为笔记内容）------------------
  // 坐标按页面归一化（0～1）存盘，缩放、换宽度、双页/对照都不用重算。
  setAnnotVisible(v: boolean): void {
    if (!v) { this.finishAnnotTip(); }
    this.annotVisible = v;
    this.root.classList.toggle("annots-hidden", !v);
    this.renderAllAnnots();
  }

  private emitAnnotations(): void {
    this.onAnnotations?.([...this.annotations]);
  }

  // 给当前选区加一条标注。笔记只取第一页（一份笔记不应该散成好几条）。
  annotateSelection(kind: PdfAnnotKind, color = "yellow"): string | null {
    const segs = this.selectionSegments();
    if (!segs.length || !this.docId) { return null; }
    const now = Date.now();
    const made: PdfAnnotation[] = [];
    const list = kind === "note" ? segs.slice(0, 1) : segs;
    for (const seg of list) {
      const wrap = this.pageWrap[seg.page];
      if (!wrap) { continue; }
      const wr = wrap.getBoundingClientRect();
      if (!wr.width || !wr.height) { continue; }
      const rects: PdfAnnotRect[] = seg.rects.map((r) => ({
        x: clamp01((r.left - wr.left) / wr.width),
        y: clamp01((r.top - wr.top) / wr.height),
        w: clamp01(r.width / wr.width),
        h: clamp01(r.height / wr.height)
      })).filter((r) => r.w > 0.001 && r.h > 0.001);
      if (!rects.length) { continue; }
      made.push({
        id: annotId(), docId: this.docId, page: seg.page, kind, color, rects,
        text: seg.text.slice(0, 600), note: kind === "note" ? "" : undefined,
        createdAt: now, updatedAt: now
      });
    }
    if (!made.length) { return null; }
    this.annotations.push(...made);
    this.emitAnnotations();
    this.renderAllAnnots();
    for (const a of made) { void this.persistAnnot(a); }
    window.getSelection()?.removeAllRanges();
    this.clearSelection();
    this.toast("已添加" + ANNOT_LABELS[kind]);
    const first = made[0];
    if (kind === "note") {
      // 新建笔记直接把光标放到笔记框里
      window.setTimeout(() => this.openAnnotTip(first.id, undefined, { focus: true }), 30);
    }
    return first.id;
  }

  // 区域标注：把框选的矩形存成一条标注。高亮只描边框；笔记复用同一套编辑面板。
  annotateRegion(kind: "highlight" | "note", color: string, sel: { left: number; top: number; right: number; bottom: number }): string | null {
    if (!this.docId) { return null; }
    const wrap = document.elementsFromPoint((sel.left + sel.right) / 2, (sel.top + sel.bottom) / 2)
      .map((el) => el.closest(".page-wrap"))
      .find((el): el is HTMLElement => el instanceof HTMLElement) || null;
    const wr = wrap?.getBoundingClientRect();
    if (!wrap || !wr || !wr.width || !wr.height) { return null; }
    const left = Math.max(sel.left, wr.left), top = Math.max(sel.top, wr.top);
    const right = Math.min(sel.right, wr.right), bottom = Math.min(sel.bottom, wr.bottom);
    if (right - left < 4 || bottom - top < 4) { return null; }
    const now = Date.now();
    const a: PdfAnnotation = {
      id: annotId(), docId: this.docId, page: Number(wrap.dataset.page || 0), kind, color,
      rects: [{
        x: clamp01((left - wr.left) / wr.width),
        y: clamp01((top - wr.top) / wr.height),
        w: clamp01((right - left) / wr.width),
        h: clamp01((bottom - top) / wr.height)
      }],
      region: true,
      text: this.regionText(wrap, sel).slice(0, 600),
      note: kind === "note" ? "" : undefined,
      createdAt: now, updatedAt: now
    };
    this.annotations.push(a);
    this.emitAnnotations();
    this.renderAllAnnots();
    void this.persistAnnot(a);
    if (kind === "note") {
      window.setTimeout(() => this.openAnnotTip(a.id, undefined, { focus: true }), 30);
    } else {
      this.toast("已添加区域高亮");
    }
    return a.id;
  }

  // ---- 画笔模式 ----
  setInkMode(on: boolean): void {
    this.inkMode = on;
    this.root.classList.toggle("ink-mode", on);
    this.finishAnnotTip();
    this.cancelInkLive();
  }

  setInkColor(color: string): void {
    this.inkColor = (ANNOT_COLORS as readonly string[]).includes(color) ? color : "yellow";
  }

  setInkWidth(width: number): void {
    this.inkWidth = Math.max(1, Math.min(32, width));
  }

  undoInk(): void {
    const page = this.lastInkPage;
    const a = page
      ? [...this.annotations].reverse().find((x) => x.kind === "ink" && x.page === page)
      : null;
    if (!a || !a.strokes?.length) { this.toast("没有可撤销的画笔"); return; }
    a.strokes = a.strokes.slice(0, -1);
    if (!a.strokes.length) {
      this.removeAnnotation(a.id, "已撤销画笔");
      this.lastInkPage = 0;
      return;
    }
    a.rects = [this.inkBounds(a.strokes)];
    a.updatedAt = Date.now();
    this.emitAnnotations();
    this.renderAllAnnots();
    void this.persistAnnot(a);
  }

  clearInk(page = this.lastInkPage): void {
    const targets = page ? this.annotations.filter((a) => a.kind === "ink" && a.page === page) : [];
    if (!targets.length) { this.toast("本页没有画笔"); return; }
    for (const a of targets) { this.removeAnnotation(a.id, ""); }
    this.toast("已清除本页画笔");
    if (page === this.lastInkPage) { this.lastInkPage = 0; }
  }

  private inkBounds(strokes: PdfInkStroke[]): PdfAnnotRect {
    let minX = 1, minY = 1, maxX = 0, maxY = 0, maxW = 0;
    for (const s of strokes) {
      maxW = Math.max(maxW, s.width || 0);
      for (const p of s.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    if (maxX < minX || maxY < minY) { return { x: 0, y: 0, w: 0.01, h: 0.01 }; }
    const pad = Math.max(0.003, maxW / 2);
    return {
      x: clamp01(minX - pad), y: clamp01(minY - pad),
      w: clamp01(maxX - minX + pad * 2), h: clamp01(maxY - minY + pad * 2)
    };
  }

  private commitInkStroke(page: number, strokes: PdfInkStroke[]): void {
    if (!this.docId || !strokes.length) { return; }
    const now = Date.now();
    let a = [...this.annotations].reverse().find((x) => x.kind === "ink" && x.page === page) || null;
    const color = strokes[strokes.length - 1].color;
    if (!a) {
      a = {
        id: annotId(), docId: this.docId, page, kind: "ink", color,
        rects: [this.inkBounds(strokes)], strokes: [], createdAt: now, updatedAt: now
      };
      this.annotations.push(a);
    }
    a.strokes = [...(a.strokes || []), ...strokes];
    a.color = color;
    a.rects = [this.inkBounds(a.strokes)];
    a.updatedAt = now;
    this.lastInkPage = page;
    this.emitAnnotations();
    this.renderAllAnnots();
    void this.persistAnnot(a);
  }

  private cancelInkLive(): void {
    this.inkLiveCancel?.();
    this.inkLiveCancel = null;
  }

  private beginInkStroke(e: PointerEvent, wrap: HTMLElement): void {
    e.preventDefault();
    document.getSelection()?.removeAllRanges();
    this.cancelInkLive();
    const wr = wrap.getBoundingClientRect();
    if (!wr.width || !wr.height) { return; }
    const page = Number(wrap.dataset.page || 0);
    if (!page) { return; }
    const color = this.inkColor;
    const widthPx = this.inkWidth;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "annot-ink-live");
    svg.setAttribute("viewBox", `0 0 ${wr.width} ${wr.height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("data-color", color);
    const path = document.createElementNS(SVG_NS, "path");
    path.style.fill = "none";
    path.style.stroke = "var(--annot-color)";
    path.style.strokeWidth = `${widthPx}px`;
    path.style.strokeLinecap = "round";
    path.style.strokeLinejoin = "round";
    svg.appendChild(path);
    wrap.appendChild(svg);

    const points: { x: number; y: number }[] = [];
    const add = (ev: PointerEvent): void => {
      const x = clamp01((ev.clientX - wr.left) / wr.width);
      const y = clamp01((ev.clientY - wr.top) / wr.height);
      const last = points[points.length - 1];
      if (last && Math.abs(last.x - x) * wr.width + Math.abs(last.y - y) * wr.height < 0.8) { return; }
      points.push({ x, y });
      const d = points.map((p, i) => `${i ? "L" : "M"}${(p.x * wr.width).toFixed(2)} ${(p.y * wr.height).toFixed(2)}`).join(" ");
      path.setAttribute("d", d);
    };
    add(e);

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      svg.remove();
      this.inkLiveCancel = null;
    };
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) { return; }
      ev.preventDefault();
      add(ev);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) { return; }
      cleanup();
      if (!points.length) { return; }
      const stroke: PdfInkStroke = { color, width: widthPx / wr.width, points };
      this.commitInkStroke(page, [stroke]);
    };
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) { return; }
      cleanup();
    };
    this.inkLiveCancel = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  private renderAllAnnots(): void {
    this.root.classList.toggle("annots-hidden", !this.annotVisible);
    const pages = Object.keys(this.annotLayer).map((k) => parseInt(k, 10));
    for (const p of pages) { this.renderPageAnnots(p); }
  }

  private renderPageAnnots(page: number): void {
    const layer = this.annotLayer[page];
    if (!layer) { return; }
    this.clearLayer(layer);
    if (!this.annotVisible) { return; }
    const wrap = this.pageWrap[page];
    if (!wrap) { return; }
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) { return; }
    const items = this.annotations.filter((a) => a.page === page).sort((a, b) => a.createdAt - b.createdAt);
    for (const a of items) {
      const color = a.color || "yellow";
      for (const r of a.rects) {
        const el = document.createElement("div");
        el.className = "annot-rect";
        el.dataset.kind = a.kind;
        el.dataset.color = color;
        el.dataset.annot = a.id;
        if (a.region) { el.dataset.region = "1"; }
        el.style.left = r.x * w + "px";
        el.style.top = r.y * h + "px";
        el.style.width = r.w * w + "px";
        el.style.height = r.h * h + "px";
        layer.appendChild(el);
      }
      if (a.kind === "ink" && a.strokes?.length) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "annot-ink");
        svg.setAttribute("data-annot", a.id);
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("preserveAspectRatio", "none");
        for (const s of a.strokes) {
          if (!s.points.length) { continue; }
          // 每笔可能有不同颜色：用 <g> 挂 data-color，子元素通过 --annot-color 继承
          const g = document.createElementNS(SVG_NS, "g");
          g.setAttribute("data-color", s.color || color);
          const strokeW = Math.max(0.75, (s.width || 0) * w);
          if (s.points.length === 1) {
            const dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("cx", String(s.points[0].x * w));
            dot.setAttribute("cy", String(s.points[0].y * h));
            dot.setAttribute("r", String(strokeW / 2));
            dot.style.fill = "var(--annot-color)";
            g.appendChild(dot);
          } else {
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", s.points.map((p, i) => `${i ? "L" : "M"}${p.x * w} ${p.y * h}`).join(" "));
            path.style.fill = "none";
            path.style.stroke = "var(--annot-color)";
            path.style.strokeWidth = `${strokeW}px`;
            path.style.strokeLinecap = "round";
            path.style.strokeLinejoin = "round";
            g.appendChild(path);
          }
          svg.appendChild(g);
        }
        layer.appendChild(svg);
      }
      // 只有真的写了内容（文字 / 图片 / 链接）才显示"笔记"小标：空白草稿关掉就没了
      if ((a.note && a.note.trim()) || (a.images && a.images.length) || (a.links && a.links.length)) {
        const last = a.rects[a.rects.length - 1];
        if (!last) { continue; }
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = "annot-mark";
        mark.dataset.color = color;
        mark.dataset.annot = a.id;
        mark.title = a.note || (a.images?.length ? `${a.images.length} 张图片` : (a.links?.length ? `${a.links.length} 个链接` : "笔记"));
        mark.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-note"></use></svg>';
        mark.style.left = Math.max(0, Math.min(w - 16, (last.x + last.w) * w + 2)) + "px";
        mark.style.top = Math.max(0, Math.min(h - 16, last.y * h - 2)) + "px";
        mark.addEventListener("click", (ev) => { ev.stopPropagation(); if (this.inkMode) { return; } this.openAnnotTip(a.id, mark); });
        layer.appendChild(mark);
      }
    }
  }

  private async persistAnnot(a: PdfAnnotation): Promise<void> {
    if (!this.docId) { return; }
    try {
      const saved = await window.api.annotationsSave(this.docId, a);
      if (!saved) { return; }
      const i = this.annotations.findIndex((x) => x.id === a.id);
      if (i >= 0) { this.annotations[i] = saved; }
      this.emitAnnotations();
    } catch { /* 保存失败不打断阅读 */ }
  }

  removeAnnotation(id: string, message = "已删除标注"): void {
    const i = this.annotations.findIndex((a) => a.id === id);
    if (i < 0) { return; }
    this.annotations.splice(i, 1);
    if (this.annotTipId === id) { this.closeAnnotTip(); }
    this.renderAllAnnots();
    this.emitAnnotations();
    void window.api.annotationsRemove(this.docId, id);
    if (message) { this.toast(message); }
  }

  // 点在已有标注（高亮 / 下划线 / 删除线 / 笔记）的文字区域上：打开编辑面板补笔记。
  // 高亮本身不能吃 pointer-events（否则没法在标注上继续选字），所以用几何命中判断：
  // 只有"没拖动、没形成选区"的单击才算点击标注。
  private onAnnotPointerDown = (e: PointerEvent): void => {
    if (this.inkMode || e.button !== 0) { return; }
    this.annotDown = { x: e.clientX, y: e.clientY };
    if (this.annotClickTimer) { window.clearTimeout(this.annotClickTimer); this.annotClickTimer = 0; }
  };

  private onAnnotClick = (e: MouseEvent): void => {
    if (this.inkMode) { return; }
    const down = this.annotDown;
    this.annotDown = null;
    if (!down) { return; }
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) { return; }
    const target = e.target as Element | null;
    if (target && target.closest && target.closest(
      ".annot-mark, .block-rect, .link-rect, .block-tip, .annot-tip, .sel-tools"
    )) { return; }
    const hit = this.annotationAt(e.clientX, e.clientY);
    if (!hit) { return; }
    // 双击选词时第一次 click 也会到；等一小会儿，选区非空就不弹面板
    this.annotClickTimer = window.setTimeout(() => {
      this.annotClickTimer = 0;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) { return; }
      this.openAnnotTip(hit.id);
    }, 160);
  };

  // 鼠标移到已有标注上时描一圈，提示"这里可以点"
  private onAnnotHover = (e: PointerEvent): void => {
    if (this.inkMode) { return; }
    if (this.annotHoverRaf) { return; }
    const x = e.clientX, y = e.clientY;
    this.annotHoverRaf = requestAnimationFrame(() => {
      this.annotHoverRaf = 0;
      if (this.root.hidden) { return; }
      const hit = this.annotationAt(x, y);
      const id = hit ? hit.id : null;
      if (id === this.annotHoverId) { return; }
      this.annotHoverId = id;
      this.root.querySelectorAll<HTMLElement>(".annot-rect.is-hover").forEach((el) => el.classList.remove("is-hover"));
      if (!hit) { return; }
      const layer = this.annotLayer[hit.page];
      layer?.querySelectorAll<HTMLElement>(`.annot-rect[data-annot="${hit.id}"]`).forEach((el) => el.classList.add("is-hover"));
    });
  };

  private annotationAt(x: number, y: number): PdfAnnotation | null {
    if (!this.annotVisible) { return null; }
    for (const key of Object.keys(this.pageWrap)) {
      const wrap = this.pageWrap[Number(key)];
      if (!wrap) { continue; }
      const r = wrap.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { continue; }
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) { continue; }
      const nx = (x - r.left) / r.width;
      const ny = (y - r.top) / r.height;
      const items = this.annotations.filter((a) => a.page === Number(key));
      for (let i = items.length - 1; i >= 0; i--) {
        const a = items[i];
        const hit = a.kind === "ink"
          ? this.inkHit(a, nx, ny, wrap)
          : a.rects.some((rect) => nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h);
        if (hit) { return a; }
      }
    }
    return null;
  }

  private inkHit(a: PdfAnnotation, nx: number, ny: number, wrap: HTMLElement): boolean {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) { return false; }
    const x = nx * w, y = ny * h;
    for (const s of a.strokes || []) {
      const r = Math.max(1, (s.width || 0) * w / 2) + 4;
      const pts = s.points;
      if (!pts.length) { continue; }
      if (pts.length === 1) {
        if (Math.hypot(x - pts[0].x * w, y - pts[0].y * h) <= r) { return true; }
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i - 1].x * w, pts[i - 1].y * h, pts[i].x * w, pts[i].y * h) <= r) { return true; }
      }
    }
    return false;
  }

  // 从侧栏 / 笔记列表点过来：切回原文、定位到标注位置，并闪一下
  async focusAnnotation(id: string): Promise<void> {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) { return; }
    if (this.view === "target") {
      this.view = this.rightBytes ? "compare" : "source";
      if (this.view === "compare") { this.layout = "single"; }
      await this.build();
    }
    this.goToNumberedPage(a.page);
    const wrap = await this.ensurePageText(a.page);
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      const rootRect = this.root.getBoundingClientRect();
      const pageTop = r.top - rootRect.top + this.root.scrollTop;
      const first = a.rects[0];
      const target = pageTop + (first ? first.y * r.height : 0) - this.root.clientHeight * 0.3;
      const maxTop = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
      this.root.scrollTop = Math.max(0, Math.min(maxTop, target));
      this.expectedScrollTop = this.root.scrollTop;
    }
    this.renderAllAnnots();
    const layer = this.annotLayer[a.page];
    layer?.querySelectorAll<HTMLElement>(`[data-annot="${a.id}"]`).forEach((el) => {
      el.classList.add("is-focus");
      window.setTimeout(() => el.classList.remove("is-focus"), 1200);
    });
    // 左侧标注栏只负责定位，不展开编辑面板（要看 / 改就点页面上的标注）
    this.emit({ displayPage: a.page, scrollFraction: 0 });
  }

  private annotAnchor(a: PdfAnnotation): HTMLElement | null {
    const layer = this.annotLayer[a.page];
    return layer?.querySelector<HTMLElement>(`.annot-mark[data-annot="${a.id}"]`)
      || layer?.querySelector<HTMLElement>(`[data-annot="${a.id}"]`)
      || this.pageWrap[a.page]
      || null;
  }

  private ensureAnnotTip(): HTMLElement {
    if (this.annotTipEl) { return this.annotTipEl; }
    const el = document.createElement("div");
    el.className = "annot-tip";
    el.hidden = true;
    el.innerHTML =
      '<div class="annot-tip-head">' +
      '<span class="annot-tip-title"></span>' +
      '<button type="button" class="annot-tip-close" title="关闭"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"></use></svg></button>' +
      "</div>" +
      '<div class="annot-tip-toolbar">' +
      '<div class="annot-tip-colors"></div>' +
      '<div class="annot-tip-tools">' +
      '<button type="button" class="annot-tip-icon-btn annot-tip-link-btn" title="添加链接"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-link"></use></svg></button>' +
      '<button type="button" class="annot-tip-icon-btn annot-tip-image-add" title="插入图片"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-image"></use></svg></button>' +
      "</div>" +
      "</div>" +
      '<div class="annot-tip-link-editor" hidden>' +
      '<input class="annot-tip-url" type="text" spellcheck="false" placeholder="粘贴链接…" />' +
      '<button type="button" class="annot-tip-link-add-btn">添加</button>' +
      '<button type="button" class="annot-tip-link-cancel" title="取消"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"></use></svg></button>' +
      "</div>" +
      '<div class="annot-tip-images"></div>' +
      '<div class="annot-tip-link-list"></div>' +
      '<textarea class="annot-tip-text" rows="3" placeholder="点击这里写笔记…（可粘贴图片）"></textarea>' +
      '<input class="annot-tip-file" type="file" accept="image/*" hidden />' +
      '<div class="annot-tip-footer">' +
      '<button type="button" class="annot-tip-del">删除</button>' +
      "</div>";
    const colors = el.querySelector<HTMLElement>(".annot-tip-colors");
    for (const c of ANNOT_COLORS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "annot-tip-color";
      b.dataset.color = c;
      b.title = ANNOT_COLOR_LABELS[c];
      b.addEventListener("click", () => {
        const a = this.annotations.find((x) => x.id === this.annotTipId);
        if (!a) { return; }
        this.syncTipText(a);
        a.color = c;
        if (a.kind === "ink" && a.strokes?.length) {
          a.strokes = a.strokes.map((s) => ({ ...s, color: c }));
        }
        colors?.querySelectorAll<HTMLElement>(".annot-tip-color").forEach((x) => {
          x.classList.toggle("active", x.dataset.color === c);
        });
        this.renderAllAnnots();
        this.emitAnnotations();
        void this.persistAnnot(a);
      });
      colors?.appendChild(b);
    }
    const file = el.querySelector<HTMLInputElement>(".annot-tip-file");
    const text = el.querySelector<HTMLTextAreaElement>(".annot-tip-text");
    el.querySelector<HTMLElement>(".annot-tip-close")?.addEventListener("click", () => this.finishAnnotTip());
    el.querySelector<HTMLElement>(".annot-tip-link-btn")?.addEventListener("click", () => this.setTipLinkEditor(true));
    el.querySelector<HTMLElement>(".annot-tip-link-cancel")?.addEventListener("click", () => this.setTipLinkEditor(false, true));
    el.querySelector<HTMLElement>(".annot-tip-image-add")?.addEventListener("click", () => file?.click());
    file?.addEventListener("change", () => {
      const f = file.files?.[0] || null;
      file.value = "";
      if (f) { void this.addTipImage(f); }
    });
    // 笔记直接编辑，自动保存；粘贴图片 = 粘进当前笔记
    text?.addEventListener("input", () => this.scheduleAnnotNoteSave());
    el.addEventListener("paste", (ev) => {
      const a = this.annotations.find((x) => x.id === this.annotTipId);
      if (!a) { return; }
      const item = Array.from(ev.clipboardData?.items || [])
        .find((it) => it.kind === "file" && /^image\//i.test(it.type));
      const f = item?.getAsFile();
      if (!f) { return; }
      ev.preventDefault();
      void this.addTipImage(f);
    });
    el.querySelector<HTMLElement>(".annot-tip-link-add-btn")?.addEventListener("click", () => this.addTipLink());
    el.querySelector<HTMLInputElement>(".annot-tip-url")?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") { return; }
      ev.preventDefault();
      this.addTipLink();
    });
    el.querySelector<HTMLElement>(".annot-tip-del")?.addEventListener("click", () => {
      const id = this.annotTipId;
      this.closeAnnotTip();
      this.removeAnnotation(id);
    });
    (this.host.parentElement || document.body).appendChild(el);
    this.annotTipEl = el;
    this.annotTipOutside = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest && (t.closest(".annot-tip") || t.closest(".annot-mark") || t.closest(".img-lightbox"))) { return; }
      this.finishAnnotTip();
    };
    document.addEventListener("mousedown", this.annotTipOutside, true);
    this.annotTipKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") { return; }
      // 大图查看在更上层：Esc 先关灯箱，别把笔记面板一起关掉
      if (document.querySelector(".img-lightbox")) { return; }
      const linkEditor = this.annotTipEl?.querySelector<HTMLElement>(".annot-tip-link-editor");
      if (linkEditor && !linkEditor.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this.setTipLinkEditor(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.finishAnnotTip();
    };
    document.addEventListener("keydown", this.annotTipKey, true);
    return el;
  }

  private closeAnnotTip(): void {
    if (this.annotTipOutside) { document.removeEventListener("mousedown", this.annotTipOutside, true); this.annotTipOutside = null; }
    if (this.annotTipKey) { document.removeEventListener("keydown", this.annotTipKey, true); this.annotTipKey = null; }
    if (this.annotTipEl) { this.annotTipEl.remove(); this.annotTipEl = null; }
    if (this.annotSaveTimer) { window.clearTimeout(this.annotSaveTimer); this.annotSaveTimer = 0; }
    this.annotTipId = "";
  }

  private openAnnotTip(id: string, anchor?: Element | null, opts: { focus?: boolean } = {}): void {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) { return; }
    // 已经打开同一条（比如又点了它的标记）：不要重置输入状态
    if (this.annotTipId === id && Object.keys(opts).length === 0) { return; }
    // 切到另一条之前先保存当前笔记（空白草稿会在这里被清掉）
    if (this.annotTipId && this.annotTipId !== id) { this.finishAnnotTip(); }
    if (!this.annotations.some((x) => x.id === id)) { return; }
    const el = this.ensureAnnotTip();
    this.annotTipId = id;
    const body = (a.note || "").trim();
    const hasOther = !!(a.images && a.images.length) || !!(a.links && a.links.length);
    const title = el.querySelector<HTMLElement>(".annot-tip-title");
    if (title) {
      title.textContent = ANNOT_LABELS[a.kind] + ((body || hasOther) && a.kind !== "note" ? " · 笔记" : "");
    }
    const colors = el.querySelector<HTMLElement>(".annot-tip-colors");
    if (colors) {
      colors.querySelectorAll<HTMLElement>(".annot-tip-color").forEach((b) => {
        b.classList.toggle("active", b.dataset.color === (a.color || "yellow"));
      });
    }
    const text = el.querySelector<HTMLTextAreaElement>(".annot-tip-text");
    if (text) {
      text.value = a.note || "";
      text.placeholder = a.kind === "note" ? "点击这里写笔记…（可粘贴图片）" : "补充笔记…（可粘贴图片）";
    }
    const url = el.querySelector<HTMLInputElement>(".annot-tip-url");
    if (url) { url.value = ""; }
    this.renderTipImages(a);
    this.renderTipLinks(a);
    el.hidden = false;
    this.setTipLinkEditor(false);
    this.positionAnnotTip(el, (anchor as HTMLElement | undefined) || this.annotAnchor(a));
    if (opts.focus && text) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }

  private setTipLinkEditor(open: boolean, focusText = false): void {
    const box = this.annotTipEl?.querySelector<HTMLElement>(".annot-tip-link-editor");
    const input = this.annotTipEl?.querySelector<HTMLInputElement>(".annot-tip-url");
    if (!box) { return; }
    box.hidden = !open;
    if (input) {
      input.value = "";
      if (open) { input.focus(); }
    }
    if (!open && focusText) {
      this.annotTipEl?.querySelector<HTMLTextAreaElement>(".annot-tip-text")?.focus();
    }
    this.repositionAnnotTip();
  }

  private scheduleAnnotNoteSave(): void {
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    const text = this.annotTipEl?.querySelector<HTMLTextAreaElement>(".annot-tip-text");
    if (!a || !text) { return; }
    a.note = text.value;
    if (this.annotSaveTimer) { window.clearTimeout(this.annotSaveTimer); }
    this.annotSaveTimer = window.setTimeout(() => {
      this.annotSaveTimer = 0;
      const cur = this.annotations.find((x) => x.id === this.annotTipId);
      if (!cur) { return; }
      this.renderAllAnnots();
      this.emitAnnotations();
      void this.persistAnnot(cur);
    }, 400);
  }

  private flushAnnotNote(): void {
    if (this.annotSaveTimer) { window.clearTimeout(this.annotSaveTimer); this.annotSaveTimer = 0; }
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    const text = this.annotTipEl?.querySelector<HTMLTextAreaElement>(".annot-tip-text");
    if (a && text) { a.note = text.value.trim(); }
  }

  // 关闭 / 点外面 / Esc：保存笔记；空白笔记直接移除，不留下标记
  private finishAnnotTip(): void {
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    if (a) {
      this.flushAnnotNote();
      const pendingLink = this.annotTipEl?.querySelector<HTMLInputElement>(".annot-tip-url");
      if (pendingLink && pendingLink.value.trim()) { this.addTipLink(); }
      if (a.kind === "note" && !(a.note || "").trim() && !(a.images && a.images.length) && !(a.links && a.links.length) && !this.tipImageBusy) {
        this.removeAnnotation(a.id, "未填写内容的笔记已取消");
        return;
      }
      this.renderAllAnnots();
      this.emitAnnotations();
      void this.persistAnnot(a);
    }
    this.closeAnnotTip();
  }

  private renderTipImages(a: PdfAnnotation): void {
    const box = this.annotTipEl?.querySelector<HTMLElement>(".annot-tip-images");
    if (!box) { return; }
    const imgs = a.images || [];
    box.hidden = imgs.length === 0;
    box.innerHTML = "";
    imgs.forEach((src, idx) => {
      const fig = document.createElement("div");
      fig.className = "annot-tip-image";
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.title = "点击放大";
      img.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); zoomImage(src, "笔记图片"); });
      fig.appendChild(img);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "annot-tip-image-del";
      del.title = "移除图片";
      del.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"></use></svg>';
      del.addEventListener("click", () => {
        const cur = this.annotations.find((x) => x.id === a.id);
        if (!cur) { return; }
        this.syncTipText(cur);
        cur.images = (cur.images || []).filter((_, i) => i !== idx);
        if (!cur.images.length) { delete cur.images; }
        this.renderTipImages(cur);
        this.renderAllAnnots();
        this.emitAnnotations();
        this.repositionAnnotTip();
        void this.persistAnnot(cur);
      });
      fig.appendChild(del);
      box.appendChild(fig);
    });
  }

  private renderTipLinks(a: PdfAnnotation): void {
    const box = this.annotTipEl?.querySelector<HTMLElement>(".annot-tip-link-list");
    if (!box) { return; }
    const links = a.links || [];
    box.hidden = links.length === 0;
    box.innerHTML = "";
    links.forEach((url, idx) => {
      const row = document.createElement("div");
      row.className = "annot-tip-link-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "annot-tip-link";
      open.title = "打开链接";
      open.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-link"></use></svg><span></span>';
      const label = open.querySelector("span");
      if (label) { label.textContent = url; }
      open.addEventListener("click", (ev) => { ev.stopPropagation(); void window.api.openExternal(url); });
      row.appendChild(open);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "annot-tip-link-del";
      del.title = "移除链接";
      del.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"></use></svg>';
      del.addEventListener("click", () => {
        const cur = this.annotations.find((x) => x.id === a.id);
        if (!cur) { return; }
        this.syncTipText(cur);
        cur.links = (cur.links || []).filter((_, i) => i !== idx);
        if (!cur.links.length) { delete cur.links; }
        this.renderTipLinks(cur);
        this.emitAnnotations();
        this.repositionAnnotTip();
        void this.persistAnnot(cur);
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  private addTipLink(): void {
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    const input = this.annotTipEl?.querySelector<HTMLInputElement>(".annot-tip-url");
    if (!a || !input) { return; }
    let v = input.value.trim();
    if (!v) { return; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) { v = "https://" + v; }
    if (!/^(https?:|mailto:)/i.test(v)) {
      this.toast("请输入网页或邮件链接");
      return;
    }
    this.syncTipText(a);
    if (!(a.links || []).includes(v)) { a.links = [...(a.links || []), v]; }
    this.renderTipLinks(a);
    this.setTipLinkEditor(false, true);
    this.emitAnnotations();
    void this.persistAnnot(a);
  }

  private async addTipImage(file: File): Promise<void> {
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    if (!a) { return; }
    this.tipImageBusy = true;
    try {
      const raw = await readImageFile(file);
      const dataUrl = await normalizeImage(raw, 1400, 0.9);
      if (!dataUrl) { return; }
      if (!this.annotations.some((x) => x.id === a.id)) { return; }
      // 面板已经切到另一条标注：不要把这边的文字写进旧笔记
      const same = this.annotTipId === a.id;
      if (this.annotTipId && !same) { return; }
      if (same) { this.syncTipText(a); }
      a.images = [...(a.images || []), dataUrl];
      if (same) {
        this.renderTipImages(a);
        this.renderAllAnnots();
        this.emitAnnotations();
        this.repositionAnnotTip();
      }
      void this.persistAnnot(a);
    } catch {
      this.toast("图片读取失败");
    } finally {
      this.tipImageBusy = false;
      if (!this.annotTipId && a.kind === "note" && !(a.note || "").trim() && !(a.images && a.images.length) && !(a.links && a.links.length)) {
        this.removeAnnotation(a.id, "");
      }
    }
  }

  // 插图 / 移除图片前，先把文本框里的内容同步进标注，别把已写的字丢了
  private syncTipText(a: PdfAnnotation): void {
    const text = this.annotTipEl?.querySelector<HTMLTextAreaElement>(".annot-tip-text");
    if (text) { a.note = text.value.trim(); }
  }

  // 跟着标注走：滚动时面板不要停在原地
  private followAnnotTip(): void {
    if (!this.annotTipEl || this.annotTipEl.hidden || !this.annotTipId) { return; }
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    if (!a) { this.finishAnnotTip(); return; }
    const anchor = this.annotAnchor(a);
    if (!anchor) { return; }
    const r = anchor.getBoundingClientRect();
    const ar = this.root.getBoundingClientRect();
    if (r.bottom < ar.top - 8 || r.top > ar.bottom + 8) {
      this.finishAnnotTip();
      return;
    }
    this.positionAnnotTip(this.annotTipEl, anchor);
  }

  private repositionAnnotTip(): void {
    if (!this.annotTipEl || this.annotTipEl.hidden || !this.annotTipId) { return; }
    const a = this.annotations.find((x) => x.id === this.annotTipId);
    if (a) { this.positionAnnotTip(this.annotTipEl, this.annotAnchor(a)); }
  }

  private positionAnnotTip(el: HTMLElement, target: HTMLElement | null): void {
    const area = this.root.getBoundingClientRect();
    const r = target ? target.getBoundingClientRect() : area;
    const w = el.offsetWidth, h = el.offsetHeight;
    const GAP = 8, PAD = 8;
    let left = r.right + GAP;
    let top = r.top;
    if (left + w > area.right - PAD) {
      left = r.left - GAP - w;
      if (left < area.left + PAD) {
        left = Math.min(Math.max(area.left + PAD, r.left), Math.max(area.left + PAD, area.right - PAD - w));
        top = r.bottom + GAP;
        if (top + h > area.bottom - PAD) { top = r.top - GAP - h; }
      }
    }
    left = Math.min(Math.max(left, area.left + PAD), Math.max(area.left + PAD, area.right - PAD - w));
    top = Math.min(Math.max(top, area.top + PAD), Math.max(area.top + PAD, area.bottom - PAD - h));
    el.style.left = Math.round(left - area.left) + "px";
    el.style.top = Math.round(top - area.top) + "px";
  }

  private async renderTextLayer(wrap: HTMLElement, page: any, baseWidth: number, refWidth: number): Promise<void> {
    const pdfjs = await getPdfjs();
    if (typeof pdfjs.renderTextLayer !== "function") { return; }
    const viewport = page.getViewport({ scale: refWidth / baseWidth });
    let layer = wrap.querySelector<HTMLElement>(".text-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "text-layer";
      wrap.appendChild(layer);
    }
    this.spanCache.delete(layer);
    layer.dataset.refw = String(refWidth);
    layer.style.transformOrigin = "0 0";
    layer.style.transform = `scale(${this.zoom})`;
    layer.style.width = viewport.width + "px";
    layer.style.height = viewport.height + "px";
    layer.style.setProperty("--scale-factor", String(viewport.scale));
    layer.innerHTML = "";
    try {
      const textContent = await page.getTextContent();
      const task = pdfjs.renderTextLayer({ textContentSource: textContent, container: layer, viewport, textDivs: [] });
      await task.promise;
    } catch { /* ignore */ }
  }

  private resetDom(): void {
    if (this.leftDoc) { try { this.leftDoc.destroy(); } catch { /* */ } this.leftDoc = null; }
    if (this.rightDoc) { try { this.rightDoc.destroy(); } catch { /* */ } this.rightDoc = null; }
    this.hideBlockTip();
    this.finishAnnotTip();
    this.leftSlots = {}; this.rightSlots = {}; this.pageWrap = {}; this.blockLayer = {}; this.linkLayer = {}; this.rightLayer = {}; this.annotLayer = {};
    // blocksByPage belongs to the document, not to the DOM: keep it across rebuilds
    // (view/layout switches) so the block overlays can be re-rendered.
    this.pageSize = {}; this.renderedW = {}; this.renderedWR = {}; this.linksByPage = {};
    this.quotePage = 0; this.quoteText = "";
    this.rows = []; this.rowFirstPage = []; this.currentPageIndex = 0; this.totalPages = 0;
    this.root.innerHTML = "";
    this.root.hidden = true;
    this.root.style.removeProperty("--page-w");
    this.root.style.removeProperty("--cols");
  }

  private async build(): Promise<void> {
    const gen = ++this.buildGen;
    this.resetDom();
    if (!this.sourceBytes) { return; }
    this.root.hidden = false;
    this.classForView();
    await this.ensureWidth();
    this.basePageW = this.computeFitWidth();
    this.zoom = 1;
    this.applyPageWidth();
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data: this.sourceBytes.slice() }).promise;
    if (gen !== this.buildGen) { try { doc.destroy(); } catch { /* */ } return; }
    this.leftDoc = doc;
    const total = doc.numPages;
    this.totalPages = total;

    if (this.rightBytes) {
      try { this.rightDoc = await pdfjs.getDocument({ data: this.rightBytes.slice() }).promise; } catch { this.rightDoc = null; }
    }

    const perRow = this.perRow();
    const width = this.pageWidth();
    for (let start = 1; start <= total; start += perRow) {
      const row = document.createElement("div");
      row.className = "compare-row";
      for (let p = start; p < start + perRow && p <= total; p++) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        this.pageSize[p] = { w: base.width, h: base.height };
        // left (source)
        if (this.view !== "target") {
          const cell = document.createElement("div");
          cell.className = "compare-cell";
          const wrap = document.createElement("div");
          wrap.className = "page-wrap";
          wrap.dataset.page = String(p);
          const canvas = this.blankCanvas();
          canvas.width = Math.floor(base.width); canvas.height = Math.floor(base.height);
          wrap.appendChild(canvas);
          const selLayer = document.createElement("div");
          selLayer.className = "sel-layer";
          wrap.appendChild(selLayer);
          const citeLayer = document.createElement("div");
          citeLayer.className = "cite-layer";
          wrap.appendChild(citeLayer);
          const annotLayer = document.createElement("div");
          annotLayer.className = "annot-layer";
          wrap.appendChild(annotLayer);
          const layer = document.createElement("div");
          layer.className = "block-layer" + (this.showBlocks() ? "" : " hidden");
          wrap.appendChild(layer);
          const linkLayer = document.createElement("div");
          linkLayer.className = "link-layer";
          wrap.appendChild(linkLayer);
          cell.appendChild(wrap);
          row.appendChild(cell);
          this.leftSlots[p] = canvas; this.pageWrap[p] = wrap; this.blockLayer[p] = layer; this.linkLayer[p] = linkLayer;
          this.annotLayer[p] = annotLayer;
          await this.loadPageLinks(doc, page, p);
        }
        // right (translation)
        if (this.view !== "source") {
          const cell = document.createElement("div");
          cell.className = "compare-cell";
          const wrap = document.createElement("div");
          wrap.className = "page-wrap";
          wrap.dataset.page = String(p);
          const hasRight = this.rightDoc && p <= this.rightDoc.numPages;
          if (hasRight) {
            const canvas = this.blankCanvas();
            canvas.width = Math.floor(base.width); canvas.height = Math.floor(base.height);
            wrap.appendChild(canvas);
            this.rightSlots[p] = canvas;
          } else {
            const ph = document.createElement("div");
            ph.className = "page-placeholder";
            ph.style.aspectRatio = String(1 / (base.height / base.width));
            ph.textContent = "未翻译";
            wrap.appendChild(ph);
            this.rightSlots[p] = null;
          }
          const selLayer = document.createElement("div");
          selLayer.className = "sel-layer";
          wrap.appendChild(selLayer);
          const layer = document.createElement("div");
          layer.className = "block-layer hidden";
          wrap.appendChild(layer);
          cell.appendChild(wrap);
          row.appendChild(cell);
          this.rightLayer[p] = layer;
        }
      }
      this.root.appendChild(row);
      this.rows.push(row);
      this.rowFirstPage.push(start);
    }
    this.emit({ numPages: total, displayPage: 1, zoom: 1, view: this.view, layout: this.layout, hasSource: true });
    this.scheduleRender(0);
  }

  private renderVisible = async (): Promise<void> => {
    if (this.renderInFlight || this.root.hidden || !this.leftDoc) { return; }
    this.renderInFlight = true;
    try {
      const width = this.pageWidth();
      const perRow = this.perRow();
      const top = this.root.scrollTop;
      const bottom = top + this.root.clientHeight;
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        if (row.offsetTop + row.offsetHeight < top - 400) { continue; }
        if (row.offsetTop > bottom + 400) { break; }
        const first = this.rowFirstPage[i] || i + 1;
        for (let p = first; p < first + perRow && p <= this.totalPages; p++) {
          const left = this.leftSlots[p];
          if (left && this.renderedW[p] !== width) { await this.renderCell(left, this.leftDoc, p, width); this.renderedW[p] = width; }
          const right = this.rightSlots[p];
          if (right && this.rightDoc && this.renderedWR[p] !== width) { await this.renderCell(right, this.rightDoc, p, width); this.renderedWR[p] = width; }
        }
      }
      this.renderAllBlocks();
      this.renderAllAnnots();
    } catch { /* ignore */ } finally { this.renderInFlight = false; }
  };

  private scheduleRender(d: number): void { clearTimeout(this.renderTimer); this.renderTimer = window.setTimeout(() => void this.renderVisible(), d); }

  private updateCurrentPage(): void {
    if (!this.rows.length) { return; }
    if (this.expectedScrollTop >= 0) {
      if (Math.abs(this.root.scrollTop - this.expectedScrollTop) < 2) { return; }
      this.expectedScrollTop = -1;
    }
    const top = this.root.scrollTop + 4;
    let idx = 0;
    for (let i = 0; i < this.rows.length; i++) { idx = i; if (this.rows[i].offsetTop + this.rows[i].offsetHeight > top) { break; } }
    this.currentPageIndex = idx;
    const rowEl = this.rows[idx];
    const frac = rowEl && rowEl.offsetHeight ? Math.min(1, Math.max(0, (this.root.scrollTop - rowEl.offsetTop) / rowEl.offsetHeight)) : 0;
    const display = this.rowFirstPage[idx] || idx + 1;
    if (display !== this.status.displayPage || Math.abs(frac - this.status.scrollFraction) > 0.02) {
      this.emit({ displayPage: display, scrollFraction: frac });
    }
  }

  goToPage(row: number): void {
    if (!this.rows.length) { return; }
    const i = Math.max(0, Math.min(this.rows.length - 1, row));
    this.root.scrollTop = Math.max(0, this.rows[i].offsetTop - 12);
    this.expectedScrollTop = this.root.scrollTop;
    this.currentPageIndex = i;
    this.emit({ displayPage: this.rowFirstPage[i] || i + 1, scrollFraction: 0 });
  }

  goToDest(page: number, anchor: number): void {
    if (!this.rows.length || page < 1) { return; }
    const i = Math.max(0, Math.min(this.rows.length - 1, Math.floor((page - 1) / this.perRow())));
    const rowEl = this.rows[i];
    const frac = Math.max(0, Math.min(1, anchor || 0));
    this.root.scrollTop = Math.max(0, rowEl.offsetTop + rowEl.offsetHeight * frac);
    this.expectedScrollTop = this.root.scrollTop;
    this.currentPageIndex = i;
    // report the exact target page (in double-page layout rowFirstPage is only the left page)
    this.emit({ displayPage: page, scrollFraction: frac });
  }
  nextPage(): void { this.goToPage(this.currentPageIndex + 1); }
  prevPage(): void { this.goToPage(this.currentPageIndex - 1); }
  goToNumberedPage(n: number): void {
    if (!this.rows.length) { return; }
    const i = Math.max(0, Math.min(this.rows.length - 1, Math.floor((n - 1) / this.perRow())));
    this.root.scrollTop = Math.max(0, this.rows[i].offsetTop - 12);
    this.expectedScrollTop = this.root.scrollTop;
    this.currentPageIndex = i;
    this.emit({ displayPage: n, scrollFraction: 0 });
  }

  // ---- AI 引用：跳到某页后，按原文片段在文本层里定位并高亮 ----
  // 只给了页码时退化成原来的翻页；带片段时把命中的那几行画上高亮并滚到视野上方 1/3。
  async focusQuote(pageNum: number, quote?: string): Promise<void> {
    const page = this.totalPages ? Math.max(1, Math.min(this.totalPages, pageNum)) : pageNum;
    const q = String(quote || "").replace(/\s+/g, " ").trim();
    this.clearQuoteHighlight();
    this.quotePage = 0;
    this.quoteText = "";
    // 引用总是指向原文：当前只显示译文时切回对照/原文，否则文本层里根本没有英文可定位
    if (this.view === "target") {
      this.view = this.rightBytes ? "compare" : "source";
      if (this.view === "compare") { this.layout = "single"; }
      void this.build();
    }
    for (let i = 0; i < 120 && !this.pageWrap[page]; i++) { await delay(80); }
    this.goToNumberedPage(page);
    if (!q) { return; }
    this.quotePage = page;
    this.quoteText = q;
    const wrap = await this.ensurePageText(page);
    if (!wrap) { return; }
    const textLayer = wrap.querySelector<HTMLElement>(".text-layer");
    if (!textLayer) { return; }
    const range = this.findQuoteRange(textLayer, q);
    if (!range) { return; }
    const top = this.paintQuoteRects(wrap, range);
    // 命中行滚动到视口上方约 1/3 处，避免只停在这一页的开头
    const rootRect = this.root.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const pageTop = wrapRect.top - rootRect.top + this.root.scrollTop;
    const target = pageTop + top - this.root.clientHeight * 0.3;
    const maxTop = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
    this.root.scrollTop = Math.max(0, Math.min(maxTop, target));
    this.expectedScrollTop = this.root.scrollTop;
    this.emit({ displayPage: page, scrollFraction: 0 });
  }

  private clearQuoteHighlight(): void {
    this.root.querySelectorAll<HTMLElement>(".cite-layer").forEach((l) => { l.innerHTML = ""; });
  }

  // 点了引用高亮以外的地方（正文、工具栏、AI 面板…）就把高亮收掉；点在高亮本身上则保留
  private onQuotePointerDown = (e: PointerEvent): void => {
    if (!this.quotePage) { return; }
    const layer = this.pageWrap[this.quotePage]?.querySelector<HTMLElement>(".cite-layer");
    const inside = layer
      ? Array.from(layer.children).some((el) => {
        const r = el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      })
      : false;
    if (inside) { return; }
    this.clearQuoteHighlight();
    this.quotePage = 0;
    this.quoteText = "";
  };

  private repaintQuote(): void {
    this.clearQuoteHighlight();
    if (!this.quotePage || !this.quoteText) { return; }
    const wrap = this.pageWrap[this.quotePage];
    const layer = wrap?.querySelector<HTMLElement>(".text-layer");
    if (!wrap || !layer) { return; }
    const range = this.findQuoteRange(layer, this.quoteText);
    if (range) { this.paintQuoteRects(wrap, range); }
  }

  // 等这一页渲染出文本层（用户可能直接点了一个还没滚动到的引用）
  private async ensurePageText(page: number): Promise<HTMLElement | null> {
    for (let i = 0; i < 60; i++) {
      const wrap = this.pageWrap[page];
      if (!wrap) { await delay(80); continue; }
      let layer = wrap.querySelector<HTMLElement>(".text-layer");
      if (!layer && this.leftDoc) {
        const canvas = this.leftSlots[page];
        const width = this.pageWidth();
        try {
          if (canvas && this.renderedW[page] !== width) {
            await this.renderCell(canvas, this.leftDoc, page, width);
            this.renderedW[page] = width;
          } else {
            const p = await this.leftDoc.getPage(page);
            const base = p.getViewport({ scale: 1 });
            await this.renderTextLayer(wrap, p, base.width, this.basePageW);
          }
        } catch { /* 渲染失败就退回只翻页 */ }
        layer = wrap.querySelector<HTMLElement>(".text-layer");
      }
      if (layer && layer.textContent && layer.textContent.trim()) { return wrap; }
      await delay(80);
    }
    return this.pageWrap[page] || null;
  }

  // 把文本层按阅读顺序拼成一个归一化字符串，并记录每个字符对应的文本节点/偏移
  private quoteIndex(layer: HTMLElement): { text: string; chars: { node: Text; offset: number }[] } {
    const chars: { node: Text; offset: number }[] = [];
    let text = "";
    for (const span of this.textSpans(layer)) {
      // 只看叶子 span，避免 markedContent 之类的外层容器把文字算两遍
      if (span.querySelector("span")) { continue; }
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const t = node as Text;
        const s = t.data;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i].toLowerCase();
          const mapped = LIGATURES[ch] || quoteChar(ch);
          for (let k = 0; k < mapped.length; k++) {
            chars.push({ node: t, offset: i });
            text += mapped[k];
          }
        }
      }
    }
    return { text, chars };
  }

  private findQuoteRange(layer: HTMLElement, quote: string): Range | null {
    const needle = quoteNorm(quote);
    if (!needle) { return null; }
    const { text, chars } = this.quoteIndex(layer);
    if (!text) { return null; }
    // 模型给的片段可能前后多抄了几个字：先整段找，再逐步用前缀；仍找不到就换个起点试
    const lengths = [needle.length, 260, 200, 160, 130, 100, 80, 60, 45, 30, 20]
      .filter((n, i, a) => n > 0 && n <= needle.length && a.indexOf(n) === i);
    const starts = [0, 10, 20, 40, 70].filter((n) => n < needle.length - 20);
    for (const start of starts) {
      for (const len of lengths) {
        const part = needle.slice(start, start + len);
        if (part.length < 12) { continue; }
        const idx = text.indexOf(part);
        if (idx < 0) { continue; }
        const a = chars[idx];
        const b = chars[idx + part.length - 1];
        if (!a || !b) { continue; }
        try {
          const range = document.createRange();
          range.setStart(a.node, a.offset);
          range.setEnd(b.node, b.offset + 1);
          return range;
        } catch { return null; }
      }
    }
    return null;
  }

  private paintQuoteRects(wrap: HTMLElement, range: Range): number {
    const layer = wrap.querySelector<HTMLElement>(".cite-layer");
    const textLayer = wrap.querySelector<HTMLElement>(".text-layer");
    if (!layer || !textLayer) { return 0; }
    const wr = wrap.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) { return 0; }
    // 和选区高亮一样：原生 Range 矩形比行距高，按"最贴的那一行文字"的行框来画，避免糊成一大条
    const lines: { top: number; height: number; left: number; width: number; el: HTMLElement }[] = [];
    this.textSpans(textLayer).forEach((span) => {
      const b = span.getBoundingClientRect();
      if (b.width > 1 && b.height > 1) { lines.push({ top: b.top, height: b.height, left: b.left, width: b.width, el: span }); }
    });
    if (!lines.length) { return 0; }
    const seen = new Set<string>();
    let top = Infinity;
    for (const r of rects) {
      let line: typeof lines[number] | null = null;
      let bestScore = Infinity;
      for (const ln of lines) {
        const o = Math.min(r.bottom, ln.top + ln.height) - Math.max(r.top, ln.top);
        if (o <= 0) { continue; }
        const ox = Math.min(r.right, ln.left + ln.width) - Math.max(r.left, ln.left);
        if (ox <= 0) { continue; }
        if (ln.height < r.height * 0.45 || ln.height > r.height * 1.8) { continue; }
        const score = Math.abs(ln.height - r.height) - o * 1e-3 - ox * 1e-6;
        if (score < bestScore) { bestScore = score; line = ln; }
      }
      if (!line) { continue; }
      // 浏览器有时给出"整行宽"的矩形：用这一行自己的有墨范围收窄
      const ink = this.inkRatio(line.el);
      const inkWidth = line.width * ink.width;
      if (inkWidth < 1) { continue; }
      let left = r.left;
      let width = r.width;
      if (width > inkWidth + 1) { left = line.left + line.width * ink.lead; width = inkWidth; }
      const key = Math.round(left) + ":" + Math.round(line.top) + ":" + Math.round(width);
      if (seen.has(key)) { continue; }
      seen.add(key);
      const el = document.createElement("div");
      el.className = "cite-highlight";
      el.style.left = (left - wr.left) + "px";
      el.style.top = (line.top - wr.top) + "px";
      el.style.width = width + "px";
      el.style.height = line.height + "px";
      layer.appendChild(el);
      top = Math.min(top, line.top - wr.top);
    }
    return isFinite(top) ? top : 0;
  }

  private applyZoom(z: number): void {
    const sx = this.root.scrollWidth ? (this.root.scrollLeft + this.root.clientWidth / 2) / this.root.scrollWidth : 0.5;
    const sy = this.root.scrollHeight ? (this.root.scrollTop + this.root.clientHeight / 2) / this.root.scrollHeight : 0.5;
    this.zoom = Math.max(0.4, Math.min(6, z));
    this.applyPageWidth();
    this.renderAllBlocks();
    this.scheduleRender(80);
    this.root.scrollLeft = sx * this.root.scrollWidth - this.root.clientWidth / 2;
    this.root.scrollTop = sy * this.root.scrollHeight - this.root.clientHeight / 2;
    this.emit({ zoom: this.zoom });
  }
  zoomBy(f: number): void { this.applyZoom(this.zoom * f); }
  setZoom(z: number): void { this.applyZoom(z); }

  setView(v: View): void {
    if (v === this.view) { return; }
    this.view = v;
    if (v === "compare") { this.layout = "single"; }
    void this.build();
  }
  setLayout(l: Layout): void { if (l === this.layout) { return; } this.layout = l; void this.build(); }

  // Block overlays have two independent switches: one for the live translation
  // preview, one for viewing a finished translation. The active session decides
  // which applies.
  setBlockPrefs(p: { translating: boolean; viewing: boolean }): void {
    this.blockPrefs = p;
    this.hideBlockTip();
    this.renderAllBlocks();
  }
  private showBlocks(): boolean {
    return this.active?.state === "running" ? this.blockPrefs.translating : this.blockPrefs.viewing;
  }

  // ---- block overlays ----
  // The panel is pinned by clicking a block (not hovered): it stays put while you read,
  // follows the block while scrolling, and can be dragged by its header (then it stays
  // where you put it). Clicking the same block again, clicking elsewhere, or × dismisses it.
  // 译文在上、原文默认折叠：查看译文时用户主要看中文，需要对照再展开原文。
  hideBlockTip(): void {
    if (this.blockTipEl && !this.blockTipEl.hidden) { this.blockTipEl.hidden = true; }
    if (this.blockTipRect) { this.blockTipRect.classList.remove("is-active"); this.blockTipRect = null; }
    this.blockTipKey = null;
    this.blockTipMoved = false;
  }
  private ensureBlockTip(): HTMLElement {
    if (this.blockTipEl) { return this.blockTipEl; }
    const el = document.createElement("div");
    el.className = "block-tip";
    el.hidden = true;
    // Only the shell goes through innerHTML; the block text itself is rendered as nodes.
    el.innerHTML =
      '<div class="tip-head" title="按住标题栏可拖动面板">' +
      '<span class="tip-title">块框</span>' +
      '<button type="button" class="tip-close" title="关闭"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"></use></svg></button></div>' +
      '<div class="tip-dst"></div>' +
      '<details class="tip-src-box"><summary><span class="tip-src-label">原文</span><span class="tip-src-hint">展开</span></summary>' +
      '<div class="tip-src"></div></details>';
    el.querySelector<HTMLElement>(".tip-close")?.addEventListener("click", () => this.hideBlockTip());
    this.bindBlockTipDrag(el);
    const srcBox = el.querySelector<HTMLDetailsElement>(".tip-src-box");
    const srcHint = el.querySelector<HTMLElement>(".tip-src-hint");
    srcBox?.addEventListener("toggle", () => {
      if (srcHint) { srcHint.textContent = srcBox.open ? "收起" : "展开"; }
      // 展开后可能超出阅读区，重新夹一下位置（手动拖过的就不动）
      if (!this.blockTipMoved && this.blockTipRect) { this.positionBlockTip(this.blockTipRect); }
    });
    (this.host.parentElement || document.body).appendChild(el);
    this.blockTipEl = el;
    this.blockTipOutside = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest && (t.closest(".block-tip") || t.closest(".block-rect"))) { return; }
      this.hideBlockTip();
    };
    document.addEventListener("mousedown", this.blockTipOutside);
    return el;
  }
  // 标题栏拖动：坐标换算成 root 内偏移（面板是 absolute，offset parent 就是阅读区）
  private bindBlockTipDrag(el: HTMLElement): void {
    const head = el.querySelector<HTMLElement>(".tip-head");
    if (!head) { return; }
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) { return; }
      if ((e.target as Element | null)?.closest?.(".tip-close")) { return; }
      const rect = el.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      const area = this.root.getBoundingClientRect();
      let moved = false;
      head.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) { return; }
        moved = true;
        this.blockTipMoved = true;
        const w = el.offsetWidth, h = el.offsetHeight;
        const left = Math.min(Math.max(ev.clientX - offX - area.left, 8), Math.max(8, area.width - 8 - w));
        const top = Math.min(Math.max(ev.clientY - offY - area.top, 8), Math.max(8, area.height - 8 - h));
        el.style.left = Math.round(left) + "px";
        el.style.top = Math.round(top) + "px";
      };
      const end = (): void => {
        el.classList.remove("is-dragging");
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", end);
        head.removeEventListener("pointercancel", end);
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", end);
      head.addEventListener("pointercancel", end);
    });
  }
  // Anchors the panel next to its block: right of it if that fits, else left, else below
  // (or above when there is no room below), always clamped inside the reading area.
  private positionBlockTip(rectEl: HTMLElement, rr?: DOMRect, ar?: DOMRect): void {
    const el = this.blockTipEl;
    if (!el || el.hidden) { return; }
    const area = ar || this.root.getBoundingClientRect();
    const r = rr || rectEl.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const GAP = 8, PAD = 8;
    let left = r.right + GAP;
    let top = r.top;
    if (left + w > area.right - PAD) {
      left = r.left - GAP - w;
      if (left < area.left + PAD) {
        left = r.left;
        top = r.bottom + GAP;
        if (top + h > area.bottom - PAD) { top = r.top - GAP - h; }
      }
    }
    left = Math.min(Math.max(left, area.left + PAD), Math.max(area.left + PAD, area.right - PAD - w));
    top = Math.min(Math.max(top, area.top + PAD), Math.max(area.top + PAD, area.bottom - PAD - h));
    el.style.left = Math.round(left - area.left) + "px";
    el.style.top = Math.round(top - area.top) + "px";
  }
  // Keeps the pinned panel glued to its block while scrolling (the current rect element
  // is still valid until the next render pass swaps it out). 拖过之后就不再拽回去。
  private followBlockTip(): void {
    if (this.blockTipMoved) { return; }
    const el = this.blockTipRect;
    if (!this.blockTipKey || !el || !el.isConnected) { return; }
    const rr = el.getBoundingClientRect();
    const ar = this.root.getBoundingClientRect();
    if (rr.bottom < ar.top - 8 || rr.top > ar.bottom + 8) { this.hideBlockTip(); return; }
    this.positionBlockTip(el, rr, ar);
  }
  private toggleBlockTip(rectEl: HTMLElement, page: number, index: number, src: string, dst: string, vars?: Record<string, string>): void {
    const pinned = this.blockTipKey && this.blockTipKey.page === page && this.blockTipKey.index === index;
    if (this.blockTipEl && !this.blockTipEl.hidden && pinned) { this.hideBlockTip(); return; }
    const el = this.ensureBlockTip();
    fillBlockText(el.querySelector(".tip-dst"), dst, "(暂无译文)", vars);
    fillBlockText(el.querySelector(".tip-src"), src, "(空)", vars);
    // 有译文就把原文折起来；还没有译文时直接展开原文
    const srcBox = el.querySelector<HTMLDetailsElement>(".tip-src-box");
    if (srcBox) { srcBox.open = !dst.trim(); }
    const srcHint = el.querySelector<HTMLElement>(".tip-src-hint");
    if (srcHint) { srcHint.textContent = srcBox?.open ? "收起" : "展开"; }
    el.scrollTop = 0;
    el.hidden = false;
    if (this.blockTipRect && this.blockTipRect !== rectEl) { this.blockTipRect.classList.remove("is-active"); }
    this.blockTipRect = rectEl;
    this.blockTipKey = { page, index };
    rectEl.classList.add("is-active");
    // 拖动过就保持用户放的位置（同一轮打开内一直粘着），没拖过才贴到当前块旁边
    if (!this.blockTipMoved) { this.positionBlockTip(rectEl); }
  }
  private disposeBlockTip(): void {
    if (this.blockTipOutside) { document.removeEventListener("mousedown", this.blockTipOutside); this.blockTipOutside = null; }
    if (this.blockTipEl) { this.blockTipEl.remove(); this.blockTipEl = null; }
    this.blockTipRect = null;
    this.blockTipKey = null;
    this.blockTipMoved = false;
  }
  private clearLayer(l?: HTMLElement): void { if (l) { while (l.firstChild) { l.removeChild(l.firstChild); } } }
  private renderPageBlocks(page: number): void {
    const layerL = this.blockLayer[page];
    this.clearLayer(layerL);
    if (!layerL) { return; }
    const wrap = this.pageWrap[page];
    const size = this.pageSize[page];
    if (!wrap || !size || !size.w || !size.h) { return; }
    const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
    if (!cssW || !cssH) { return; }
    const sx = cssW / size.w, sy = cssH / size.h;
    const items = this.blocksByPage[page] || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const bb = item.bbox || [0, 0, 0, 0];
      const x0 = Math.max(0, bb[0]), y0 = Math.max(0, bb[1]), x1 = Math.min(size.w, bb[2]), y1 = Math.min(size.h, bb[3]);
      if (x1 <= x0 || y1 <= y0) { continue; }
      const rect = document.createElement("div");
      rect.className = "block-rect";
      rect.style.left = x0 * sx + "px"; rect.style.top = (size.h - y1) * sy + "px";
      rect.style.width = (x1 - x0) * sx + "px"; rect.style.height = (y1 - y0) * sy + "px";
      rect.addEventListener("click", () => { if (this.inkMode) { return; } this.toggleBlockTip(rect, page, i, item.src || "", item.dst || "", item.vars); });
      // rects are recreated on every render pass; re-mark and re-anchor the pinned one,
      // and drop the panel once its block has scrolled out of sight
      if (this.blockTipKey && this.blockTipKey.page === page && this.blockTipKey.index === i) {
        if (this.blockTipMoved) {
          // 手动拖过的面板不再跟随块框，只保持高亮
          rect.classList.add("is-active");
          this.blockTipRect = rect;
        } else {
          const rr = rect.getBoundingClientRect();
          const ar = this.root.getBoundingClientRect();
          if (rr.bottom < ar.top - 8 || rr.top > ar.bottom + 8) { this.hideBlockTip(); }
          else {
            rect.classList.add("is-active");
            this.blockTipRect = rect;
            this.positionBlockTip(rect, rr, ar);
          }
        }
      }
      layerL.appendChild(rect);
    }
    layerL.classList.toggle("hidden", !this.showBlocks());
  }
  private renderAllBlocks(): void {
    const keys = new Set<number>();
    Object.keys(this.blockLayer).forEach((k) => keys.add(parseInt(k, 10)));
    keys.forEach((p) => { this.renderPageBlocks(p); this.renderPageLinks(p); });
  }

  // ---- 区域截图（发给 AI 助手）----
  // 自动模式：按下时如果指针在文字上，就交给浏览器正常选词；否则视为要截图，
  // 直接拖框选中一块，松开后从该页渲染 canvas 裁出来（类似 WPS，不需要先点按钮）。
  // 按住 Alt 可以在文字上强制截图。
  private onPagePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) { return; }
    const target = e.target as Element | null;
    // 画笔模式：在页面上按下即开始手写（优先于选字 / 区域截图）
    if (this.inkMode) {
      if (!target || target.closest(".annot-mark, .annot-tip, .sel-tools, .region-menu")) { return; }
      const wrap = target.closest(".page-wrap") as HTMLElement | null;
      if (wrap && wrap.querySelector("canvas.pdf-canvas")) { this.beginInkStroke(e, wrap); }
      return;
    }
    if (!this.onCapture) { return; }
    // 上一次框选没收尾（指针在窗口外松开等）：先取消，再开始新的
    if (this.regionEl) { this.regionCancel?.(); }
    if (!target || !target.closest(".page-wrap")) { return; }
    // 块框 / 内部链接 / 标注有各自的点击行为
    if (target.closest(".block-rect, .link-rect, .block-tip, .annot-rect, .annot-mark, .annot-tip")) { return; }
    if (!e.altKey && this.isTextAt(e.clientX, e.clientY)) { return; }
    this.beginRegionDrag(e);
  };

  // 该点是否压着有内容的文字（pdf.js 的文本层整页都可选，只有 span 才是字）。
  // 按“行”判断：行内的词距/标点之间也算文字区域，行外用 2px 容差即可。
  // 不额外放大——放大会让“在文字旁边起手”变成选字，反而不符合原生选区的直觉。
  private isTextAt(x: number, y: number): boolean {
    const wrap = document.elementsFromPoint(x, y)
      .map((el) => el.closest(".page-wrap"))
      .find((el): el is HTMLElement => el instanceof HTMLElement);
    if (!wrap) { return false; }
    const layer = wrap.querySelector<HTMLElement>(".text-layer");
    if (!layer) { return false; }
    const PAD = 2;
    for (const ln of this.textLines(layer)) {
      if (x >= ln.left - PAD && x <= ln.right + PAD && y >= ln.top - PAD && y <= ln.bottom + PAD) { return true; }
    }
    return false;
  }

  // 把一页的文字 span 按“行”聚起来（用于判断起手点是否在文字上）
  private textLines(layer: HTMLElement): TextLine[] {
    const lines: TextLine[] = [];
    for (const span of this.textSpans(layer)) {
      const r = span.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { continue; }
      const cy = r.top + r.height / 2;
      let line = lines.find((ln) => cy >= ln.top - 2 && cy <= ln.bottom + 2);
      if (!line) {
        line = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        lines.push(line);
      } else {
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
      }
    }
    return lines;
  }

  private beginRegionDrag(e: PointerEvent): void {
    e.preventDefault();
    document.getSelection()?.removeAllRanges();
    const host = this.host.parentElement || this.root;
    const start = { x: e.clientX, y: e.clientY };
    let rect = { left: start.x, top: start.y, right: start.x, bottom: start.y };
    let overlay: HTMLElement | null = null;
    let box: HTMLElement | null = null;
    let menu: HTMLElement | null = null;
    let area: DOMRect | null = null;
    let phase: "drag" | "selected" = "drag";
    let handle = "";
    let base: { left: number; top: number; right: number; bottom: number } | null = null;
    let basePoint = { x: 0, y: 0 };
    let regionColor = "yellow";

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, true);
      overlay?.remove();
      overlay = null; box = null; menu = null;
      this.regionEl = null;
      this.regionCancel = null;
    };

    const normalize = (): { left: number; top: number; right: number; bottom: number } => ({
      left: Math.min(rect.left, rect.right), top: Math.min(rect.top, rect.bottom),
      right: Math.max(rect.left, rect.right), bottom: Math.max(rect.top, rect.bottom)
    });

    const render = (): void => {
      if (!box || !area) { return; }
      const r = normalize();
      box.style.left = r.left - area.left + "px";
      box.style.top = r.top - area.top + "px";
      box.style.width = Math.max(0, r.right - r.left) + "px";
      box.style.height = Math.max(0, r.bottom - r.top) + "px";
      if (menu) {
        menu.hidden = phase !== "selected";
        if (phase === "selected") {
          // 操作条贴在选区外侧：优先下方右对齐，放不下就翻到上方，再不行贴底
          const mw = menu.offsetWidth, mh = menu.offsetHeight;
          let top = r.bottom + 6;
          if (top + mh > area.bottom - 6) { top = r.top - mh - 6; }
          if (top < area.top + 6) { top = Math.min(area.bottom - mh - 6, r.bottom + 6); }
          const left = Math.min(Math.max(r.right - mw, area.left + 6), Math.max(area.left + 6, area.right - 6 - mw));
          menu.style.left = left - area.left + "px";
          menu.style.top = Math.max(area.top + 6, top) - area.top + "px";
        }
      }
    };

    const commit = (): void => {
      const captured = this.cropRegion(normalize());
      cleanup();
      if (!captured) { return; }
      this.onCapture?.(captured);
      this.toast("已添加到对话");
    };

    // 首次移动超过阈值才创建遮罩：单纯点一下图区不会闪一下
    const ensure = (): void => {
      if (overlay) { return; }
      area = host.getBoundingClientRect();
      overlay = document.createElement("div");
      overlay.className = "region-capture";
      const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
        .map((h) => `<span class="region-handle" data-h="${h}"></span>`).join("");
      const colorBtns = ANNOT_COLORS.map((c) =>
        `<button type="button" class="sel-tool sel-dot${c === regionColor ? " active" : ""}" data-color="${c}" title="标注颜色：${ANNOT_COLOR_LABELS[c]}"></button>`
      ).join("");
      overlay.innerHTML =
        `<div class="region-box">${handles}</div>` +
        '<div class="sel-tools region-menu" hidden>' +
        colorBtns +
        '<span class="sel-sep"></span>' +
        '<button type="button" class="sel-tool region-highlight" title="高亮区域边框"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-highlight"></use></svg></button>' +
        '<button type="button" class="sel-tool region-underline" disabled title="区域标注不支持下划线"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-underline"></use></svg></button>' +
        '<button type="button" class="sel-tool region-strike" disabled title="区域标注不支持删除线"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-strike"></use></svg></button>' +
        '<button type="button" class="sel-tool region-note" title="添加笔记（可写文字 / 插图片 / 加链接）"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-note"></use></svg></button>' +
        '<span class="sel-sep"></span>' +
        '<button type="button" class="sel-tool sel-tool-wide region-add" title="把选中区域发给 AI 助手"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-arxiver"></use></svg> 问</button>' +
        "</div>";
      host.appendChild(overlay);
      this.regionEl = overlay;
      box = overlay.querySelector<HTMLElement>(".region-box");
      menu = overlay.querySelector<HTMLElement>(".region-menu");
      menu?.querySelectorAll<HTMLElement>(".sel-dot").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          regionColor = btn.dataset.color || "yellow";
          menu?.querySelectorAll<HTMLElement>(".sel-dot").forEach((x) => x.classList.toggle("active", x === btn));
        });
      });
      const applyRegion = (kind: "highlight" | "note"): void => {
        this.annotateRegion(kind, regionColor, normalize());
        cleanup();
      };
      overlay.querySelector<HTMLElement>(".region-highlight")?.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation(); applyRegion("highlight");
      });
      overlay.querySelector<HTMLElement>(".region-note")?.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation(); applyRegion("note");
      });
      overlay.querySelector<HTMLElement>(".region-add")?.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation(); commit();
      });
      // 选中后：拖手柄改大小、拖框内移动、点空白取消
      overlay.addEventListener("pointerdown", (ev) => {
        if (phase !== "selected") { return; }
        const t = ev.target as Element | null;
        if (!t || t.closest(".region-menu")) { return; }
        ev.preventDefault();
        if (t.closest(".region-handle")) {
          handle = (t.closest(".region-handle") as HTMLElement).dataset.h || "";
        } else if (t.closest(".region-box")) {
          handle = "move";
        } else {
          cleanup();
          return;
        }
        base = normalize();
        basePoint = { x: ev.clientX, y: ev.clientY };
      });
    };

    const onMove = (ev: PointerEvent): void => {
      if (phase === "drag") {
        if (!overlay && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) <= 4) { return; }
        ensure();
        rect = { left: start.x, top: start.y, right: ev.clientX, bottom: ev.clientY };
        render();
        return;
      }
      if (!handle || !base) { return; }
      const dx = ev.clientX - basePoint.x, dy = ev.clientY - basePoint.y;
      if (handle === "move") {
        rect = { left: base.left + dx, top: base.top + dy, right: base.right + dx, bottom: base.bottom + dy };
      } else {
        let { left, top, right, bottom } = base;
        if (handle.includes("w")) { left += dx; }
        if (handle.includes("e")) { right += dx; }
        if (handle.includes("n")) { top += dy; }
        if (handle.includes("s")) { bottom += dy; }
        if (right - left < 8) { if (handle.includes("w")) { left = right - 8; } else { right = left + 8; } }
        if (bottom - top < 8) { if (handle.includes("n")) { top = bottom - 8; } else { bottom = top + 8; } }
        rect = { left, top, right, bottom };
      }
      render();
    };

    const onUp = (): void => {
      if (phase === "drag") {
        if (!overlay) { cleanup(); return; } // 只是点了一下：什么都不做
        phase = "selected";
        handle = "";
        render();
        return;
      }
      handle = "";
      base = null;
      render();
    };

    const onCancel = (): void => {
      if (phase === "drag") { cleanup(); return; }
      handle = "";
      base = null;
    };

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cleanup(); }
    };

    this.regionCancel = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);
  }

  // 截图入队后的小提示（不打断阅读，也不自动跳走）
  private toast(text: string): void {
    const host = this.host.parentElement || this.root;
    host.querySelectorAll(".region-toast").forEach((el) => el.remove());
    const el = document.createElement("div");
    el.className = "region-toast";
    el.textContent = text;
    host.appendChild(el);
    window.setTimeout(() => el.remove(), 1800);
  }

  private cropRegion(sel: { left: number; top: number; right: number; bottom: number }): RegionCapture | null {
    if (sel.right - sel.left < 6 || sel.bottom - sel.top < 6) { return null; }
    const wrap = document.elementsFromPoint((sel.left + sel.right) / 2, (sel.top + sel.bottom) / 2)
      .map((el) => el.closest(".page-wrap"))
      .find((el): el is HTMLElement => el instanceof HTMLElement) || null;
    const canvas = wrap?.querySelector<HTMLCanvasElement>("canvas.pdf-canvas") || null;
    if (!wrap || !canvas || !canvas.width || !canvas.height) { return null; }
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) { return null; }
    const left = Math.max(sel.left, cr.left), top = Math.max(sel.top, cr.top);
    const right = Math.min(sel.right, cr.right), bottom = Math.min(sel.bottom, cr.bottom);
    if (right - left < 4 || bottom - top < 4) { return null; }
    const kx = canvas.width / cr.width, ky = canvas.height / cr.height;
    const sx = Math.max(0, Math.floor((left - cr.left) * kx));
    const sy = Math.max(0, Math.floor((top - cr.top) * ky));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.round((right - left) * kx)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.round((bottom - top) * ky)));
    const out = document.createElement("canvas");
    out.width = sw; out.height = sh;
    const ctx = out.getContext("2d");
    if (!ctx) { return null; }
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    try {
      return {
        dataUrl: out.toDataURL("image/jpeg", 0.92),
        page: Number(wrap.dataset.page || 0),
        // 页面纵向位置（0 = 顶部）：模型据此知道选的是页面上半/中间/下半
        anchor: Math.min(1, Math.max(0, (top - cr.top) / cr.height)),
        text: this.regionText(wrap, sel)
      };
    } catch {
      return null;
    }
  }

  // 选区里的文字：截图里的公式/小字经常认不准，把文本层对应 span 的原文一起带上；
  // 若选区几乎没有文字（纯图），再补上与选区相交的段落（图注通常在单独的块里）。
  private regionText(wrap: HTMLElement, sel: { left: number; top: number; right: number; bottom: number }): string {
    const parts: string[] = [];
    const layer = wrap.querySelector<HTMLElement>(".text-layer");
    if (layer) {
      for (const span of Array.from(layer.querySelectorAll<HTMLElement>("span"))) {
        const t = (span.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) { continue; }
        const r = span.getBoundingClientRect();
        if (r.right < sel.left || r.left > sel.right || r.bottom < sel.top || r.top > sel.bottom) { continue; }
        parts.push(t);
        if (parts.join(" ").length > 900) { break; }
      }
    }
    let text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 24) {
      const page = Number(wrap.dataset.page || 0);
      const size = this.pageSize[page];
      const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
      if (page && size && cssW && cssH) {
        const wr = wrap.getBoundingClientRect();
        const sx = cssW / size.w, sy = cssH / size.h;
        const near: string[] = [];
        for (const b of this.blocksByPage[page] || []) {
          const bb = b.bbox || [];
          if (bb.length < 4) { continue; }
          const bl = wr.left + bb[0] * sx, br = wr.left + bb[2] * sx;
          const bt = wr.top + (size.h - bb[3]) * sy, bb2 = wr.top + (size.h - bb[1]) * sy;
          if (br < sel.left || bl > sel.right || bb2 < sel.top || bt > sel.bottom) { continue; }
          const s = String(b.dst || b.src || "").replace(/\s+/g, " ").trim();
          if (s) { near.push(s); }
          if (near.join(" ").length > 600) { break; }
        }
        text = [text, ...near].filter(Boolean).join(" ");
      }
    }
    return text.slice(0, 600);
  }

  private async loadPageLinks(doc: any, pageProxy: any, page: number): Promise<void> {
    let annots: any[] = [];
    try { annots = await pageProxy.getAnnotations(); } catch { return; }
    const entries: { page: number; rect: number[]; anchor: number; url?: string }[] = [];
    for (const a of annots) {
      if (a.subtype !== "Link" || !Array.isArray(a.rect)) { continue; }
      // PDF 自带的外链：直接交给系统浏览器打开
      const raw = String(a.url || a.unsafeUrl || "").trim();
      if (/^(https?:|mailto:)/i.test(raw)) { entries.push({ page: 0, rect: a.rect, anchor: 0, url: raw }); continue; }
      if (!a.dest) { continue; }
      const resolved = await this.resolveDest(doc, a.dest);
      if (resolved) { entries.push({ page: resolved.page, rect: a.rect, anchor: resolved.anchor }); }
    }
    this.linksByPage[page] = entries;
  }

  private async resolveDest(doc: any, dest: any): Promise<{ page: number; anchor: number } | null> {
    try {
      let d = dest;
      if (typeof d === "string") { d = await doc.getDestination(d); }
      if (!Array.isArray(d) || !d.length) { return null; }
      const idx = await doc.getPageIndex(d[0]);
      const page = idx + 1;
      let anchor = 0;
      const coord = typeof d[3] === "number" ? d[3] : (typeof d[2] === "number" ? d[2] : null);
      if (coord !== null) {
        const tp = await doc.getPage(page);
        const h = tp.getViewport({ scale: 1 }).height;
        if (h > 0) { anchor = Math.max(0, Math.min(1, (h - coord) / h)); }
      }
      return { page, anchor };
    } catch { return null; }
  }

  private renderPageLinks(page: number): void {
    const layer = this.linkLayer[page];
    this.clearLayer(layer);
    if (!layer) { return; }
    const wrap = this.pageWrap[page];
    const size = this.pageSize[page];
    if (!wrap || !size || !size.w || !size.h) { return; }
    const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
    if (!cssW || !cssH) { return; }
    const sx = cssW / size.w, sy = cssH / size.h;
    for (const item of this.linksByPage[page] || []) {
      const bb = item.rect || [];
      if (bb.length < 4) { continue; }
      const x0 = Math.max(0, bb[0]), y0 = Math.max(0, bb[1]), x1 = Math.min(size.w, bb[2]), y1 = Math.min(size.h, bb[3]);
      if (x1 <= x0 || y1 <= y0) { continue; }
      const rect = document.createElement("div");
      rect.className = "link-rect";
      rect.dataset.page = String(item.page);
      rect.dataset.anchor = String(item.anchor || 0);
      rect.style.left = x0 * sx + "px"; rect.style.top = (size.h - y1) * sy + "px";
      rect.style.width = (x1 - x0) * sx + "px"; rect.style.height = (y1 - y0) * sy + "px";
      if (item.url) {
        rect.title = item.url;
        rect.addEventListener("click", (ev) => { ev.stopPropagation(); if (this.inkMode) { return; } void window.api.openExternal(item.url!); });
      } else {
        rect.addEventListener("click", (ev) => { ev.stopPropagation(); this.goToDest(item.page, item.anchor); });
      }
      layer.appendChild(rect);
    }
  }

  async renderCitation(page: number, canvas: HTMLCanvasElement, targetWidth: number): Promise<void> {
    if (!this.leftDoc || page < 1) { return; }
    try {
      const p = await this.leftDoc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      let xmin = 0, xmax = base.width;
      const tc = await p.getTextContent();
      let lo = Infinity, hi = -Infinity;
      for (const item of tc.items || []) {
        const str = (item as any).str;
        if (!str || !str.trim()) { continue; }
        const x = item.transform[4];
        lo = Math.min(lo, x);
        hi = Math.max(hi, x + item.width);
      }
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        const pad = 10;
        xmin = Math.max(0, lo - pad);
        xmax = Math.min(base.width, hi + pad);
      }
      const bandW = xmax - xmin;
      const dpr = window.devicePixelRatio || 1;
      const scale = (targetWidth / bandW) * dpr;
      const viewport = p.getViewport({ scale });
      const scratch = document.createElement("canvas");
      scratch.width = Math.max(1, Math.floor(viewport.width));
      scratch.height = Math.max(1, Math.floor(viewport.height));
      await p.render({ canvasContext: scratch.getContext("2d"), viewport }).promise;
      const sx = Math.floor(xmin * scale);
      const sw = Math.max(1, Math.floor(bandW * scale));
      canvas.width = sw;
      canvas.height = scratch.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(scratch, sx, 0, sw, scratch.height, 0, 0, sw, scratch.height);
    } catch { /* ignore */ }
  }

  // ---- public entry points ----
  // Mirrors the active document's session into the viewer (status bar, blocks, preview).
  private emitFromActive(): void {
    const s = this.active;
    if (!s) {
      this.emit({ phase: "idle", running: false, message: "", error: null, progress: null, hasTranslation: !!this.rightBytes });
      return;
    }
    const j = s.job;
    const base: Partial<ViewerStatus> = {
      view: this.view, layout: this.layout,
      progress: s.state === "done" ? 100 : (j?.progress ?? null),
      message: j?.message || (s.state === "running" ? "翻译中…" : ""),
      donePages: j?.done_pages || 0, totalPages: j?.total_pages || 0,
      currentPage: j?.current_page || 0, pageDone: j?.page_done || 0, pageTotal: j?.page_total || 0,
      blockPage: j?.block_page || 0, blockIndex: j?.block_index || 0, blockTotal: j?.block_total || 0,
      logTail: j?.log_tail || "", cached: j?.cached || false,
      cacheKey: s.cacheKey, jobId: s.jobId, resultName: s.resultName,
      hasTranslation: !!(s.result || s.partial),
      targetLang: (s.params.target_lang as string) || "", pages: (s.params.pages as string) || ""
    };
    if (s.state === "running") { this.emit({ ...base, phase: "running", running: true, error: null }); return; }
    if (s.state === "done") { this.emit({ ...base, phase: "done", running: false, error: null }); return; }
    this.emit({ ...base, phase: "error", running: false, error: s.error || "翻译失败" });
  }

  // Points the engine at a document's session (if any) before rebuilding its DOM.
  private prepareSessionView(docId: string): void {
    const s = this.sessions.get(docId) || null;
    this.active = s;
    this.rightBytes = s ? (s.result || s.partial) : null;
    this.blocksByPage = s ? s.blocksByPage : {};
    // Always open a document as 原文 + 单页; 对照 / 译文 / 双页 are opt-in (toolbar or
    // starting a translation), so having a translation never hijacks the first paint.
    this.view = "source";
    this.layout = "single";
  }

  async openSource(payload: OpenPayload, opts: { auto?: boolean; params?: Partial<TransParams> } = {}): Promise<void> {
    this.sourceBytes = toU8(payload.bytes);
    this.sourceName = payload.name || "paper.pdf";
    this.sourceUrl = payload.sourceUrl || "";
    this.docId = payload.docId || "";
    this.prepareSessionView(this.docId);
    this.annotations = [];
    if (this.docId) {
      try {
        const list = await window.api.annotationsList(this.docId);
        this.annotations = list.filter((a) => !isEmptyAnnot(a));
        // 顺手清掉旧版本留下的空白笔记 / 空链接
        for (const a of list) {
          if (isEmptyAnnot(a)) { void window.api.annotationsRemove(this.docId, a.id); }
        }
      } catch {
        this.annotations = [];
      }
    }
    this.emitAnnotations();
    const s = this.active;
    this.emit({
      title: this.sourceName, hasSource: true, hasTranslation: !!(s && (s.result || s.partial)),
      sourceUrl: this.sourceUrl, docId: this.docId, phase: "loading", running: false, error: null, message: "",
      view: this.view, layout: this.layout, jobId: s?.jobId ?? null, cacheKey: s?.cacheKey ?? null,
      progress: null, donePages: 0, totalPages: 0, currentPage: 0, pageDone: 0, pageTotal: 0,
      blockPage: 0, blockIndex: 0, blockTotal: 0, logTail: "", cached: false, resultName: "", targetLang: "", pages: ""
    });
    await this.build();
    this.emitFromActive();
    if (opts.auto) { void this.start(opts.params || {}); }
  }

  async loadTranslation(bytes: Uint8Array): Promise<void> {
    if (this.active && this.active.state === "running") { return; }
    this.rightBytes = toU8(bytes);
    await this.build();
    this.emit({ hasTranslation: true, view: this.view, layout: this.layout, phase: "done" });
  }

  async outline(onGenerating?: () => void): Promise<{ items: { title: string; page: number; level: number; anchor: number }[]; generated: boolean }> {
    const out: { title: string; page: number; level: number; anchor: number }[] = [];
    if (!this.leftDoc) { return { items: out, generated: false }; }
    let raw: any[] | null = null;
    try { raw = await this.leftDoc.getOutline(); } catch { raw = null; }
    const walk = async (items: any[], level: number): Promise<void> => {
      for (const item of items) {
        let page = 0, anchor = 0;
        try {
          let dest = item.dest;
          if (typeof dest === "string") { dest = await this.leftDoc.getDestination(dest); }
          if (Array.isArray(dest) && dest.length) {
            const idx = await this.leftDoc.getPageIndex(dest[0]);
            page = idx + 1;
            const coord = typeof dest[3] === "number" ? dest[3] : (typeof dest[2] === "number" ? dest[2] : null);
            if (coord !== null) {
              const tp = await this.leftDoc.getPage(page);
              const h = tp.getViewport({ scale: 1 }).height;
              if (h > 0) { anchor = Math.max(0, Math.min(1, (h - coord) / h)); }
            }
          }
        } catch { page = 0; }
        out.push({ title: item.title || "(无标题)", page, level, anchor });
        if (Array.isArray(item.items) && item.items.length) { await walk(item.items, level + 1); }
      }
    };
    if (raw) { await walk(raw, 0); }
    // No embedded bookmarks: fall back to a generated outline (engine-side heuristic).
    if (!out.length && this.docId) {
      onGenerating?.();
      try {
        const res = await window.api.docOutline(this.docId);
        for (const it of res.items || []) {
          out.push({
            title: it.title, page: it.page, level: Math.max(0, (it.level || 1) - 1),
            anchor: typeof it.anchor === "number" ? it.anchor : 0
          });
        }
        return { items: out, generated: res.source === "heuristic" && out.length > 0 };
      } catch { /* ignore */ }
    }
    return { items: out, generated: false };
  }

  async renderThumbnail(page: number, canvas: HTMLCanvasElement): Promise<void> {
    if (!this.leftDoc) { return; }
    try {
      const p = await this.leftDoc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: 260 / base.width });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    } catch { /* ignore */ }
  }

  async loadBlocks(docId: string, cacheKey: string): Promise<void> {
    if (!docId || !cacheKey) { return; }
    if (this.active && this.active.state === "running") { return; }
    try {
      const blocks = await window.api.readBlocks(docId, cacheKey);
      const byPage: Record<number, BlockEvent[]> = {};
      for (const item of blocks) { (byPage[item.page] ||= []).push(item); }
      this.blocksByPage = byPage;
      this.renderAllBlocks();
    } catch { /* ignore */ }
  }

  async start(params: Partial<TransParams>): Promise<void> {
    if (!this.sourceBytes) { return; }
    const docId = this.docId;
    const bytes = this.sourceBytes;
    const name = this.sourceName;
    const sourceUrl = this.sourceUrl;
    const existing = this.sessions.get(docId);
    if (existing && existing.state === "running") { return; }
    const session: DocSession = {
      docId, jobId: "", params, state: "running", job: null, error: null, cacheKey: null,
      resultName: "", blocksByPage: {}, partial: null, result: null, lastPartialKey: "", lastBlocksKey: ""
    };
    this.sessions.set(docId, session);
    if (this.docId === docId) {
      this.active = session;
      this.rightBytes = null;
      this.blocksByPage = {};
      this.view = "compare";
      this.layout = "single";
      this.emit({ phase: "running", running: true, error: null, progress: null, message: "正在准备…", hasTranslation: false, view: "compare", layout: "single" });
    }
    try {
      if (this.docId === docId) { await this.build(); }
      const job = await window.api.startJob({ docId, sourceBytes: bytes, name, sourceUrl, params });
      session.jobId = job.id;
      session.params = job.params || params;
      session.job = job;
      session.cacheKey = job.cache_key;
      session.resultName = job.result_name || "";
      if (this.active === session) { this.emitFromActive(); }
      void this.runSession(session);
    } catch (err) {
      session.state = "error";
      session.error = err instanceof Error ? err.message : String(err);
      if (this.active === session) { this.emitFromActive(); }
    }
  }

  // Runs independently of the displayed document: it keeps polling, storing progress,
  // blocks and preview bytes on the session, and only paints when the session is active.
  private async runSession(s: DocSession): Promise<void> {
    while (true) {
      await delay(700);
      if (this.sessions.get(s.docId) !== s) { return; }
      const job = await window.api.getJob(s.jobId);
      if (!job) { s.state = "error"; s.error = "任务不存在"; break; }
      s.job = job;
      if (job.cache_key) { s.cacheKey = job.cache_key; }
      if (job.result_name) { s.resultName = job.result_name; }
      if (job.block_total) {
        const bkey = job.block_page + ":" + job.block_index + ":" + job.block_total;
        if (bkey !== s.lastBlocksKey) { s.lastBlocksKey = bkey; void this.pullBlocks(s); }
      }
      if ((job.done_pages || 0) > 0 && job.status === "running") { await this.pullPartial(s, job); }
      if (job.status === "done") { await this.pullResult(s); s.state = "done"; break; }
      if (job.status === "error") { s.state = "error"; s.error = job.error || "翻译失败"; break; }
      if (job.status === "cancelled") { s.state = "cancelled"; s.error = "翻译已取消"; break; }
      if (this.active === s) { this.emitFromActive(); }
    }
    if (this.active === s) { this.renderAllBlocks(); this.emitFromActive(); }
    if (s.state === "done" && s.cacheKey) {
      this.onDone?.({ docId: s.docId, params: s.job?.params || (s.params as TransParams), cacheKey: s.cacheKey, resultName: s.resultName || "translated.pdf" });
    }
  }

  private async pullBlocks(s: DocSession): Promise<void> {
    try {
      const blocks = await window.api.getBlocks(s.jobId);
      const byPage: Record<number, BlockEvent[]> = {};
      for (const item of blocks) { (byPage[item.page] ||= []).push(item); }
      s.blocksByPage = byPage;
      if (this.active === s) { this.blocksByPage = byPage; this.renderAllBlocks(); }
    } catch { /* ignore */ }
  }

  private async pullPartial(s: DocSession, job: JobSummary): Promise<void> {
    const key = job.done_pages + ":" + (job.total_pages || 0);
    if (s.lastPartialKey === key) { return; }
    s.lastPartialKey = key;
    try {
      const data = await window.api.getPartial(s.jobId, "mono");
      if (!data || data.length === 0) { return; }
      s.partial = new Uint8Array(data);
      if (this.active === s) { this.rightBytes = s.partial; await this.reloadRight(); }
    } catch { /* ignore */ }
  }

  private async pullResult(s: DocSession): Promise<void> {
    try {
      const data = await window.api.getResult(s.jobId, "mono");
      if (data && data.length) {
        s.result = new Uint8Array(data);
        s.partial = null;
        if (this.active === s) { this.rightBytes = s.result; await this.reloadRight(); }
      }
    } catch { /* ignore */ }
  }

  private async reloadRight(): Promise<void> {
    if (!this.rightBytes) { return; }
    const pdfjs = await getPdfjs();
    if (this.rightDoc) { try { this.rightDoc.destroy(); } catch { /* */ } }
    this.rightDoc = null;
    this.renderedWR = {};
    // replace right placeholders with canvases where pages now exist
    try { this.rightDoc = await pdfjs.getDocument({ data: this.rightBytes.slice() }).promise; } catch { return; }
    const total = this.rightDoc.numPages;
    for (let p = 1; p <= total; p++) {
      if (this.rightSlots[p] !== undefined && this.rightSlots[p] === null) {
        const size = this.pageSize[p];
        const canvas = this.blankCanvas();
        if (size) { canvas.width = Math.floor(size.w); canvas.height = Math.floor(size.h); }
        const wrap = this.rightLayer[p]?.parentElement;
        const ph = wrap?.querySelector(".page-placeholder");
        if (ph && wrap) { wrap.replaceChild(canvas, ph); }
        this.rightSlots[p] = canvas;
      }
    }
    this.scheduleRender(0);
  }

  cancel(): void {
    const s = this.active;
    if (s && s.state === "running") { void window.api.cancelJob(s.jobId); }
  }

  async save(variant: string): Promise<void> {
    const id = this.active?.jobId;
    if (id) { await window.api.saveResult(id, variant); }
  }

  reset(): void {
    for (const s of this.sessions.values()) {
      if (s.state === "running" && s.jobId) { void window.api.cancelJob(s.jobId); }
    }
    this.sessions.clear();
    this.active = null;
    this.sourceBytes = null; this.rightBytes = null; this.sourceName = ""; this.sourceUrl = ""; this.docId = "";
    this.blocksByPage = {};
    this.annotations = [];
    this.emitAnnotations();
    this.disposeBlockTip();
    this.closeAnnotTip();
    this.resetDom();
    this.emit(this.blank());
  }

  // 卸载（关闭标签页）时调用：除了 reset，还要摘掉 document 上的选区监听
  dispose(): void {
    // 卸载前把没保存的笔记落盘；此时不再回调 React（组件正在卸载）
    this.onAnnotations = null;
    this.finishAnnotTip();
    this.clearSelection();
    this.closeAnnotTip();
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("mouseup", this.onSelectionSettle);
    document.removeEventListener("pointerdown", this.onQuotePointerDown);
    this.root.removeEventListener("pointerdown", this.onPagePointerDown);
    this.root.removeEventListener("pointerdown", this.onAnnotPointerDown);
    this.root.removeEventListener("click", this.onAnnotClick);
    this.root.removeEventListener("pointermove", this.onAnnotHover);
    if (this.annotHoverRaf) { window.cancelAnimationFrame(this.annotHoverRaf); this.annotHoverRaf = 0; }
    if (this.annotClickTimer) { window.clearTimeout(this.annotClickTimer); this.annotClickTimer = 0; }
    this.onAnnotations = null;
    this.regionCancel?.();
    if (this.regionEl) { this.regionEl.remove(); this.regionEl = null; }
    this.cancelInkLive();
    this.reset();
  }

  get hasTranslation(): boolean { return !!this.rightBytes; }
}
