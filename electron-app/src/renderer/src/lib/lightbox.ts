export interface ZoomImage {
  src: string;
  alt?: string;
}

type Listener = (img: ZoomImage | null) => void;

let listener: Listener | null = null;

// 任意位置（React 组件 / 引擎生成的 DOM）都可以调用；由 App 根部的灯箱统一展示。
export function zoomImage(src: string, alt?: string): void {
  if (!src) { return; }
  listener?.({ src, alt });
}

export function subscribeZoomImage(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) { listener = null; } };
}
