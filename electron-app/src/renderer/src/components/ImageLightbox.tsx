import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type JSX, type PointerEvent as ReactPointerEvent
} from "react";
import { Icon } from "./Icons";
import { subscribeZoomImage, type ZoomImage } from "../lib/lightbox";

interface Natural { w: number; h: number }
interface Point { x: number; y: number }
interface Stroke { color: string; width: number; points: Point[] }

// 用现有标注色令牌作为画笔颜色；canvas 需要真实色值，绘制时再从 CSS 变量读。
const BRUSH_COLORS: { token: string; label: string }[] = [
  { token: "--annot-yellow", label: "黄色" },
  { token: "--annot-green", label: "绿色" },
  { token: "--annot-blue", label: "蓝色" },
  { token: "--annot-pink", label: "粉色" },
  { token: "--text", label: "白色" }
];

function cssColor(token: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v || "#fff";
}

function clampZoom(z: number): number {
  return Math.min(12, Math.max(0.2, z));
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const first = s.points[0];
  if (!first) { return; }
  if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, Math.max(0.5, s.width / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < s.points.length; i++) { ctx.lineTo(s.points[i].x, s.points[i].y); }
  ctx.stroke();
}

// 全屏图片查看：滚轮缩放、拖拽平移、旋转 / 翻转、画笔标注。
export default function ImageLightbox(): JSX.Element | null {
  const [img, setImg] = useState<ZoomImage | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState(BRUSH_COLORS[0].token);
  const [brush, setBrush] = useState(6);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [panning, setPanning] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<{ id: number; stroke: Stroke } | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; button: number; moved: boolean; backdrop: boolean } | null>(null);

  // 事件处理器里读最新值，避免闭包拿到旧的缩放 / 平移
  const naturalRef = useRef<Natural | null>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const baseScaleRef = useRef(1);
  const rotationRef = useRef(rotation);
  const flipXRef = useRef(flipX);
  const flipYRef = useRef(flipY);
  naturalRef.current = natural;
  zoomRef.current = zoom;
  panRef.current = pan;
  rotationRef.current = rotation;
  flipXRef.current = flipX;
  flipYRef.current = flipY;

  const rotated = Math.abs(rotation % 180) === 90;
  const fitW = rotated ? natural?.h || 0 : natural?.w || 0;
  const fitH = rotated ? natural?.w || 0 : natural?.h || 0;
  const baseScale = natural && size.w > 0 && size.h > 0 && fitW > 0 && fitH > 0
    ? Math.min(1, Math.max(80, size.w - 48) / fitW, Math.max(80, size.h - 120) / fitH)
    : 1;
  baseScaleRef.current = baseScale;
  const scale = baseScale * zoom;

  const close = useCallback(() => {
    setImg(null);
    setStrokes([]);
    strokesRef.current = [];
    currentRef.current = null;
    dragRef.current = null;
  }, []);

  useEffect(() => subscribeZoomImage((next) => {
    // 打开新图片前先把视图和标注状态清空，避免 onLoad 与“重置 effect”互相抢
    setNatural(null);
    setFailed(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setFlipX(false);
    setFlipY(false);
    setDrawing(false);
    setPanning(false);
    setStrokes([]);
    strokesRef.current = [];
    currentRef.current = null;
    dragRef.current = null;
    setImg(next);
  }), []);

  // 量视口，用于“适应窗口”的初始比例
  useLayoutEffect(() => {
    if (!img) { return; }
    const el = viewportRef.current;
    if (!el) { return; }
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img]);

  function resetView(): void {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setFlipX(false);
    setFlipY(false);
  }

  // 以某个屏幕点为锚点缩放：先按比例修正平移，光标下的图像位置保持不变
  function zoomAt(next: number, clientX?: number, clientY?: number): void {
    const vp = viewportRef.current;
    const z1 = clampZoom(next);
    if (!vp) { setZoom(z1); return; }
    const r = vp.getBoundingClientRect();
    const s0 = baseScaleRef.current * zoomRef.current;
    const s1 = baseScaleRef.current * z1;
    if (!s0 || !s1) { setZoom(z1); return; }
    const ax = (clientX ?? (r.left + r.width / 2)) - r.left - r.width / 2;
    const ay = (clientY ?? (r.top + r.height / 2)) - r.top - r.height / 2;
    const p = panRef.current;
    const k = s1 / s0;
    setPan({ x: ax - k * (ax - p.x), y: ay - k * (ay - p.y) });
    setZoom(z1);
  }

  // 滚轮缩放：用原生监听才能 preventDefault（React 的 wheel 监听可能被当作 passive）
  useEffect(() => {
    if (!img) { return; }
    const el = viewportRef.current;
    if (!el) { return; }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img]);

  useEffect(() => {
    if (!img) { return; }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) { return; }
      if (e.key === "0") { e.preventDefault(); resetView(); }
      else if (e.key === "r" || e.key === "R") { e.preventDefault(); setRotation((v) => (v + 90) % 360); setPan({ x: 0, y: 0 }); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(zoomRef.current * 1.25); }
      else if (e.key === "-") { e.preventDefault(); zoomAt(zoomRef.current / 1.25); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, close]);

  // 屏幕坐标 → 原图像素坐标（考虑缩放、平移、旋转、翻转）
  function localPoint(clientX: number, clientY: number): Point | null {
    const vp = viewportRef.current;
    const n = naturalRef.current;
    if (!vp || !n) { return null; }
    const r = vp.getBoundingClientRect();
    const s = baseScaleRef.current * zoomRef.current;
    if (!s) { return null; }
    const p = panRef.current;
    let dx = (clientX - r.left - r.width / 2 - p.x) / s;
    let dy = (clientY - r.top - r.height / 2 - p.y) / s;
    const rad = rotationRef.current * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    const fx = flipXRef.current ? -1 : 1;
    const fy = flipYRef.current ? -1 : 1;
    return { x: rx * fx + n.w / 2, y: ry * fy + n.h / 2 };
  }

  // 平移挂在整块视口上：左键（画笔模式下用右键）从图片或旁边空白起手都能拖；
  // 只有“左键、没拖动、在空白处按下”才关闭。
  function onViewportPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 && e.button !== 2) { return; }
    if (drawing && e.button !== 2) { return; }
    e.preventDefault();
    dragRef.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button,
      moved: false, backdrop: e.target === e.currentTarget
    };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onViewportPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) { return; }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 2) { d.moved = true; }
    if (d.moved) { setPan((p) => ({ x: p.x + dx, y: p.y + dy })); }
    d.x = e.clientX;
    d.y = e.clientY;
  }

  function onViewportPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) { return; }
    dragRef.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) { e.currentTarget.releasePointerCapture(e.pointerId); }
    if (d.button === 0 && !d.moved && d.backdrop) { close(); }
  }

  function onViewportPointerCancel(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) { return; }
    dragRef.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) { e.currentTarget.releasePointerCapture(e.pointerId); }
  }

  function onCanvasPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!drawing || e.button !== 0) { return; }
    const p = localPoint(e.clientX, e.clientY);
    const ctx = canvasRef.current?.getContext("2d");
    if (!p || !ctx) { return; }
    e.preventDefault();
    e.stopPropagation();
    const stroke: Stroke = {
      color: cssColor(color),
      width: Math.max(1, brush / Math.max(0.0001, baseScaleRef.current * zoomRef.current)),
      points: [p]
    };
    currentRef.current = { id: e.pointerId, stroke };
    e.currentTarget.setPointerCapture(e.pointerId);
    drawStroke(ctx, stroke);
  }

  function onCanvasPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const cur = currentRef.current;
    if (!cur || cur.id !== e.pointerId) { return; }
    const p = localPoint(e.clientX, e.clientY);
    const ctx = canvasRef.current?.getContext("2d");
    if (!p || !ctx) { return; }
    const last = cur.stroke.points[cur.stroke.points.length - 1] || p;
    ctx.strokeStyle = cur.stroke.color;
    ctx.lineWidth = cur.stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    cur.stroke.points.push(p);
  }

  function onCanvasPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const cur = currentRef.current;
    if (!cur || cur.id !== e.pointerId) { return; }
    currentRef.current = null;
    strokesRef.current = [...strokesRef.current, cur.stroke];
    setStrokes(strokesRef.current);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) { e.currentTarget.releasePointerCapture(e.pointerId); }
  }

  function redraw(): void {
    const ctx = canvasRef.current?.getContext("2d");
    const n = naturalRef.current;
    if (!ctx || !n) { return; }
    ctx.clearRect(0, 0, n.w, n.h);
    for (const s of strokesRef.current) { drawStroke(ctx, s); }
  }

  function undo(): void {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokes(strokesRef.current);
    redraw();
  }

  function clearStrokes(): void {
    strokesRef.current = [];
    setStrokes([]);
    const ctx = canvasRef.current?.getContext("2d");
    const n = naturalRef.current;
    if (ctx && n) { ctx.clearRect(0, 0, n.w, n.h); }
  }

  function rotate(delta: number): void {
    setRotation((v) => (v + delta + 360) % 360);
    setPan({ x: 0, y: 0 });
  }

  if (!img) { return null; }

  const transform = natural
    ? `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${rotation}deg) scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})`
    : undefined;

  return (
    <div className="img-lightbox" onContextMenu={(e) => e.preventDefault()}>
      <div className="img-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn" title="缩小（滚轮）" onClick={() => zoomAt(zoomRef.current / 1.25)}><Icon name="zoom-out" small /></button>
        <span className="img-zoom-val">{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-btn" title="放大（滚轮）" onClick={() => zoomAt(zoomRef.current * 1.25)}><Icon name="zoom-in" small /></button>
        <button type="button" className="icon-btn" title="适应窗口（0）" onClick={resetView}><Icon name="expand" small /></button>
        <span className="img-toolbar-sep" />
        <button type="button" className="icon-btn" title="向左旋转" onClick={() => rotate(-90)}><Icon name="rotate-left" small /></button>
        <button type="button" className="icon-btn" title="向右旋转（R）" onClick={() => rotate(90)}><Icon name="rotate-right" small /></button>
        <button type="button" className="icon-btn" title="水平翻转" aria-pressed={flipX} onClick={() => setFlipX((v) => !v)}><Icon name="flip-h" small /></button>
        <button type="button" className="icon-btn" title="垂直翻转" aria-pressed={flipY} onClick={() => setFlipY((v) => !v)}><Icon name="flip-v" small /></button>
        <span className="img-toolbar-sep" />
        <button type="button" className="icon-btn" title={drawing ? "结束画笔" : "画笔标注"} aria-pressed={drawing} onClick={() => setDrawing((v) => !v)}><Icon name="pencil" small /></button>
        {drawing && (
          <>
            {BRUSH_COLORS.map((c) => (
              <button
                key={c.token}
                type="button"
                className={"img-brush-color" + (color === c.token ? " is-on" : "")}
                style={{ background: `var(${c.token})` }}
                title={`画笔颜色：${c.label}`}
                onClick={() => setColor(c.token)}
              />
            ))}
            <input
              className="img-brush-range"
              type="range"
              min={2}
              max={16}
              step={1}
              value={brush}
              title={`画笔粗细：${brush}px`}
              onChange={(e) => setBrush(Number(e.target.value))}
            />
            <button type="button" className="icon-btn" title="撤销上一步" disabled={!strokes.length} onClick={undo}><Icon name="undo" small /></button>
            <button type="button" className="icon-btn" title="清除标注" disabled={!strokes.length} onClick={clearStrokes}><Icon name="trash" small /></button>
          </>
        )}
      </div>
      <button type="button" className="img-lightbox-close" title="关闭（Esc）" onClick={close}>
        <Icon name="x" />
      </button>
      <div
        className={"img-viewport" + (panning ? " is-panning" : "")}
        ref={viewportRef}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={onViewportPointerCancel}
      >
        <div
          className={"img-stage" + (drawing ? " is-drawing" : "")}
          style={natural ? { width: natural.w, height: natural.h, transform } : { width: 1, height: 1, visibility: "hidden" }}
          onDoubleClick={(e) => {
            if (drawing) { return; }
            e.preventDefault();
            if (zoomRef.current > 1.05) {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            } else {
              zoomAt(2, e.clientX, e.clientY);
            }
          }}
        >
          <img
            src={img.src}
            alt={img.alt || "图片"}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth && el.naturalHeight) { setNatural({ w: el.naturalWidth, h: el.naturalHeight }); }
              else { setFailed(true); }
            }}
            onError={() => setFailed(true)}
          />
          {natural ? (
            <canvas
              ref={canvasRef}
              className={"img-draw" + (drawing ? " is-drawing" : "")}
              width={natural.w}
              height={natural.h}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            />
          ) : null}
        </div>
        {failed ? <div className="img-failed">图片加载失败</div> : null}
      </div>
    </div>
  );
}
