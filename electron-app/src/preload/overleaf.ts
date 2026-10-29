import { ipcRenderer } from "electron";

// 只把页面主动发出的「文档快照」转发给主进程；不向远程页面暴露任何本地能力。
const MAX_CONTENT = 2_000_000;
let lastAt = 0;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) { return; }
  const data = event.data as { type?: string; data?: { path?: unknown; content?: unknown; selection?: unknown } } | null;
  if (!data || data.type !== "ARXIVER_OVERLEAF_SNAPSHOT" || !data.data) { return; }

  const path = data.data.path;
  const content = data.data.content;
  if (typeof path !== "string" || !path || typeof content !== "string" || content.length > MAX_CONTENT) { return; }

  const now = Date.now();
  if (now - lastAt < 250) { return; }
  lastAt = now;

  ipcRenderer.send("overleaf:snapshot", {
    path: path.slice(0, 600),
    content,
    selection: typeof data.data.selection === "string" ? data.data.selection.slice(0, 20_000) : ""
  });
});
