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
  private layout: Layout = "double";
  private blockPrefs = { translating: true, viewing: true };
  private totalPages = 0;
  private buildGen = 0;

  private status: ViewerStatus;
  private blockTipEl: HTMLElement | null = null;
  private blockTipTimer = 0;
  private renderInFlight = false;
  private renderTimer = 0;



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
    let raf = 0;
    this.root.addEventListener("scroll", () => {
      if (raf) { return; }
      raf = requestAnimationFrame(() => { raf = 0; this.updateCurrentPage(); this.scheduleRender(120); });
    });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
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
    this.leftSlots = {}; this.rightSlots = {}; this.pageWrap = {}; this.blockLayer = {}; this.linkLayer = {}; this.rightLayer = {};
    this.pageSize = {}; this.renderedW = {}; this.renderedWR = {}; this.blocksByPage = {}; this.linksByPage = {};
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
    this.currentPageIndex = i;
    this.emit({ displayPage: this.rowFirstPage[i] || i + 1 });
  }

  goToDest(page: number, anchor: number): void {
    if (!this.rows.length || page < 1) { return; }
    const row = Math.floor((page - 1) / this.perRow());
    const i = Math.max(0, Math.min(this.rows.length - 1, row));
    const rowEl = this.rows[i];
    const offset = rowEl.offsetHeight * Math.max(0, Math.min(1, anchor || 0));
    this.root.scrollTop = Math.max(0, rowEl.offsetTop + offset);
    this.currentPageIndex = i;
    this.emit({ displayPage: this.rowFirstPage[i] || page });
  }
  nextPage(): void { this.goToPage(this.currentPageIndex + 1); }
  prevPage(): void { this.goToPage(this.currentPageIndex - 1); }
  goToNumberedPage(n: number): void { this.goToPage(Math.floor((n - 1) / this.perRow())); }

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
    this.renderAllBlocks();
  }
  private showBlocks(): boolean {
    return this.active?.state === "running" ? this.blockPrefs.translating : this.blockPrefs.viewing;
  }

  // ---- block overlays ----
  private hideBlockTip(): void { if (this.blockTipEl) { this.blockTipEl.hidden = true; } }
  private scheduleHideBlockTip(): void { clearTimeout(this.blockTipTimer); this.blockTipTimer = window.setTimeout(() => this.hideBlockTip(), 250); }
  private showBlockTip(ev: MouseEvent, src: string, dst: string): void {
    clearTimeout(this.blockTipTimer);
    if (!this.blockTipEl) {
      this.blockTipEl = document.createElement("div");
      this.blockTipEl.className = "block-tip";
      this.blockTipEl.hidden = true;
      this.blockTipEl.addEventListener("mouseenter", () => clearTimeout(this.blockTipTimer));
      this.blockTipEl.addEventListener("mouseleave", () => this.scheduleHideBlockTip());
      document.body.appendChild(this.blockTipEl);
    }
    this.blockTipEl.innerHTML = "";
    const a = document.createElement("div"); a.className = "tip-src"; a.textContent = src || "(空)";
    const b = document.createElement("div"); b.className = "tip-dst"; b.textContent = dst || "(空)";
    this.blockTipEl.appendChild(a); this.blockTipEl.appendChild(b);
    this.blockTipEl.hidden = false;
    const left = Math.max(6, Math.min(window.innerWidth - 372, ev.clientX + 12));
    const top = Math.max(48, Math.min(window.innerHeight - 120, ev.clientY + 12));
    this.blockTipEl.style.left = left + "px"; this.blockTipEl.style.top = top + "px";
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
    for (const item of this.blocksByPage[page] || []) {
      const bb = item.bbox || [0, 0, 0, 0];
      const x0 = Math.max(0, bb[0]), y0 = Math.max(0, bb[1]), x1 = Math.min(size.w, bb[2]), y1 = Math.min(size.h, bb[3]);
      if (x1 <= x0 || y1 <= y0) { continue; }
      const rect = document.createElement("div");
      rect.className = "block-rect";
      rect.style.left = x0 * sx + "px"; rect.style.top = (size.h - y1) * sy + "px";
      rect.style.width = (x1 - x0) * sx + "px"; rect.style.height = (y1 - y0) * sy + "px";
      const src = item.src || "", dst = item.dst || "";
      rect.addEventListener("mouseenter", (ev) => this.showBlockTip(ev, src, dst));
      rect.addEventListener("mousemove", (ev) => this.showBlockTip(ev, src, dst));
      rect.addEventListener("mouseleave", () => this.scheduleHideBlockTip());
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
    if (s && (s.state === "running" || s.result || s.partial)) {
      this.view = "compare";
      this.layout = "single";
    } else {
      this.view = "source";
    }
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
    if (this.view !== "compare") { this.view = "compare"; this.layout = "single"; }
    await this.build();
    this.emit({ hasTranslation: true, view: this.view, layout: this.layout, phase: "done" });
  }

  async outline(): Promise<{ title: string; page: number; level: number; anchor: number }[]> {
    const out: { title: string; page: number; level: number; anchor: number }[] = [];
    if (!this.leftDoc) { return out; }
    let raw: any[] | null = null;
    try { raw = await this.leftDoc.getOutline(); } catch { raw = null; }
    if (!raw) { return out; }
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
    await walk(raw, 0);
    return out;
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
    this.resetDom();
    this.emit(this.blank());
  }

  get hasTranslation(): boolean { return !!this.rightBytes; }
}
