import { getPdfjs } from "../lib/pdf";
import type { BlockEvent, JobSummary, TransParams } from "../../../shared/types";

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

// 译文里保留的公式 / 富文本占位符（{v0} / {{v0}} / {v*}）：不并进正文，单独渲染成带颜色的 chip
const BLOCK_PLACEHOLDER = /\{\{?\s*v\s*[\d*]+(?:\s*[\d*]+)*\s*\}?\}/gi;

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
  private linksByPage: Record<number, { page: number; rect: number[]; anchor: number }[]> = {};

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
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("mouseup", this.onSelectionSettle);
    let raf = 0;
    this.root.addEventListener("scroll", () => {
      if (raf) { return; }
      raf = requestAnimationFrame(() => { raf = 0; this.updateCurrentPage(); this.followBlockTip(); this.scheduleRender(120); });
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
    // 缩放/换宽度后，已经画好的高亮是按旧的显示尺寸画的，重画一次
    this.paintSelection();
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

  private paintSelection(): void {
    const selLayers = this.root.querySelectorAll<HTMLElement>(".sel-layer");
    for (const l of selLayers) { if (l.childElementCount) { l.innerHTML = ""; } }
    if (this.root.hidden || this.root.clientWidth === 0) { return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) { return; }
    const node = sel.anchorNode;
    const anchor = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    if (!anchor || !this.root.contains(anchor)) { return; }
    // 起点落在哪一类文字里（正文 / 小字）：高亮只画同类，跨图/跨页时不会把脚注、图注、
    // 图表里的标签、页码一起点亮（用户要选它们时会从它们里面起手）。
    const anchorSpan = this.spanOf(sel.anchorNode);
    const anchorSmall = anchorSpan ? this.isSmallText(anchorSpan) : false;
    const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) { return; }
    let minY = Infinity; let maxY = -Infinity;
    for (const r of rects) { minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom); }
    this.root.querySelectorAll<HTMLElement>(".page-wrap").forEach((wrap) => {
      const selLayer = wrap.querySelector<HTMLElement>(".sel-layer");
      const textLayer = wrap.querySelector<HTMLElement>(".text-layer");
      if (!selLayer || !textLayer) { return; }
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
        const el = document.createElement("div");
        el.className = "sel-highlight";
        el.style.left = (left - wr.left) + "px";
        el.style.top = (line.top - wr.top) + "px";
        el.style.width = width + "px";
        el.style.height = line.height + "px";
        selLayer.appendChild(el);
      }
    });
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
    this.leftSlots = {}; this.rightSlots = {}; this.pageWrap = {}; this.blockLayer = {}; this.linkLayer = {}; this.rightLayer = {};
    // blocksByPage belongs to the document, not to the DOM: keep it across rebuilds
    // (view/layout switches) so the block overlays can be re-rendered.
    this.pageSize = {}; this.renderedW = {}; this.renderedWR = {}; this.linksByPage = {};
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
          const canvas = this.blankCanvas();
          canvas.width = Math.floor(base.width); canvas.height = Math.floor(base.height);
          wrap.appendChild(canvas);
          const selLayer = document.createElement("div");
          selLayer.className = "sel-layer";
          wrap.appendChild(selLayer);
          const layer = document.createElement("div");
          layer.className = "block-layer" + (this.showBlocks() ? "" : " hidden");
          wrap.appendChild(layer);
          const linkLayer = document.createElement("div");
          linkLayer.className = "link-layer";
          wrap.appendChild(linkLayer);
          cell.appendChild(wrap);
          row.appendChild(cell);
          this.leftSlots[p] = canvas; this.pageWrap[p] = wrap; this.blockLayer[p] = layer; this.linkLayer[p] = linkLayer;
          await this.loadPageLinks(doc, page, p);
        }
        // right (translation)
        if (this.view !== "source") {
          const cell = document.createElement("div");
          cell.className = "compare-cell";
          const wrap = document.createElement("div");
          wrap.className = "page-wrap";
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
      rect.addEventListener("click", () => this.toggleBlockTip(rect, page, i, item.src || "", item.dst || "", item.vars));
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

  private async loadPageLinks(doc: any, pageProxy: any, page: number): Promise<void> {
    let annots: any[] = [];
    try { annots = await pageProxy.getAnnotations(); } catch { return; }
    const entries: { page: number; rect: number[]; anchor: number }[] = [];
    for (const a of annots) {
      if (a.subtype !== "Link" || !a.dest) { continue; }
      const resolved = await this.resolveDest(doc, a.dest);
      if (resolved && Array.isArray(a.rect)) { entries.push({ page: resolved.page, rect: a.rect, anchor: resolved.anchor }); }
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
      rect.addEventListener("click", (ev) => { ev.stopPropagation(); this.goToDest(item.page, item.anchor); });
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
    this.disposeBlockTip();
    this.resetDom();
    this.emit(this.blank());
  }

  // 卸载（关闭标签页）时调用：除了 reset，还要摘掉 document 上的选区监听
  dispose(): void {
    this.clearSelection();
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("mouseup", this.onSelectionSettle);
    this.reset();
  }

  get hasTranslation(): boolean { return !!this.rightBytes; }
}
