import path from "node:path";
import { BrowserWindow, WebContentsView, session, shell } from "electron";

import { runChat, type ChatMessage, type ToolDef } from "./agent/model";
import * as logger from "./logger";
import {
  COMMENT_PLACEHOLDER,
  getMatchPositions,
  type ReplaceCommand
} from "../shared/overleaf-replace";
import type {
  OverleafBounds,
  OverleafChatRequest,
  OverleafEditResult,
  OverleafEvent,
  OverleafFile,
  OverleafReadResult,
  OverleafStatus,
  OverleafSyncResult
} from "../shared/types";

const PARTITION = "persist:overleaf";
const HOME_URL = "https://www.overleaf.com/project";
const LOGIN_URL = "https://www.overleaf.com/login";

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const SYSTEM_FILE_CHARS = 120_000;
const SYSTEM_TOTAL_CHARS = 360_000;
const READABLE_FILE = /\.(tex|bib|md|txt)$/i;
// 逐个提取时的随机间隔：只用于降低连续点击频率，不再承担“等待文件加载”的职责。
const EXTRACT_DELAY_MIN = 200;
const EXTRACT_DELAY_MAX = 600;

const OVERLEAF_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "列出当前 Overleaf 项目里的文本文件路径（不读取正文，不会切换编辑器）。",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_file",
    description: "打开并读取当前 Overleaf 项目里的一个文本文件。会短暂切换左侧编辑器。需要某文件正文时必须调用，不要因为当前上下文没有正文就断言文件不存在。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径，例如 main.tex、chapters/4.tex" } },
      required: ["path"],
      additionalProperties: false
    }
  }
];

let fileIndexCache: { projectId: string; paths: string[]; at: number } | null = null;

let parent: BrowserWindow | null = null;
let view: WebContentsView | null = null;
let permissionsReady = false;
let pageReady = false;
let lastBounds: OverleafBounds | null = null;

const controllers = new Map<string, AbortController>();

const READ_SCRIPT = String.raw`
(() => {
  const candidates = [];
  const pick = (el) => el && (el.cmTile?.view || el.cmView?.view || el._view || el.view);
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const el of document.querySelectorAll(".cm-content, .cm-editor")) {
    const editor = pick(el);
    if (editor?.state?.doc) candidates.push({ editor, host: el });
  }
  const ideEditor = window._ide?.editorManager?.editor?.view || window._ide?.editorManager?.view;
  if (ideEditor?.state?.doc) candidates.push({ editor: ideEditor, host: null });
  if (!candidates.length) return { ok: false, error: "没有找到编辑器（可能还没打开 .tex 文件）" };

  // 优先可见编辑器；如果多个都不可见，选内容最长的，避免拿到隐藏的空编辑器。
  const visible = candidates.filter((item) => item.host && isVisible(item.host));
  const chosen = visible[0] || candidates.slice().sort((a, b) => b.editor.state.doc.length - a.editor.state.doc.length)[0];
  const editor = chosen.editor;

  const treeLabel = (el) => el?.getAttribute('aria-label')?.trim()
    || el?.querySelector('.item-name-button span')?.textContent?.trim()
    || '';
  const treePath = (el) => {
    const parts = [treeLabel(el)].filter(Boolean);
    let list = el?.closest('ul.file-tree-folder-list');
    while (list) {
      const folder = list.previousElementSibling;
      if (!folder || !folder.matches('li[role="treeitem"]')) break;
      const name = treeLabel(folder);
      if (name) parts.unshift(name);
      list = folder.closest('ul.file-tree-folder-list');
    }
    return parts.join('/');
  };
  const active = document.querySelector('.file-tree-inner li[role="treeitem"][aria-selected="true"]');
  const fallback = document.querySelector('.file-tree .active');
  const activeEntity = (active || fallback)?.querySelector('.entity');
  if (activeEntity?.getAttribute('data-file-type') === 'folder') {
    return { ok: false, error: '当前选中的是文件夹，请先打开一个 .tex 文件' };
  }
  const fileName = treePath(active || fallback);

  let selection = '';
  try {
    const main = editor.state.selection.main;
    if (!main.empty) selection = editor.state.sliceDoc(main.from, main.to);
  } catch { /* ignore */ }

  return { ok: true, fileName, content: editor.state.doc.toString(), selection };
})()
`;

// 页面内的只读观察器：文件切换、正文变化、选区变化时把当前文档快照 postMessage 给 preload。
// 这里不用扩展的 300ms 轮询：正常的编辑/切换都会触发 MutationObserver；编辑器晚加载时只短暂重试。
const SNAPSHOT_SCRIPT = String.raw`
(() => {
  if (window.__arxiverOverleafSnapshot) return;
  window.__arxiverOverleafSnapshot = true;

  let timer = 0;
  let scrollerBound = false;
  let treeBound = false;
  let bodyObserver = null;

  const pick = (el) => el && (el.cmTile?.view || el.cmView?.view || el._view || el.view);
  const treeLabel = (el) => el?.getAttribute('aria-label')?.trim()
    || el?.querySelector('.item-name-button span')?.textContent?.trim()
    || '';
  const treePath = (el) => {
    const parts = [treeLabel(el)].filter(Boolean);
    let list = el?.closest('ul.file-tree-folder-list');
    while (list) {
      const folder = list.previousElementSibling;
      if (!folder || !folder.matches('li[role="treeitem"]')) break;
      const name = treeLabel(folder);
      if (name) parts.unshift(name);
      list = folder.closest('ul.file-tree-folder-list');
    }
    return parts.join('/');
  };

  const snapshot = () => {
    const candidates = [];
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (const el of document.querySelectorAll('.cm-content, .cm-editor')) {
      const editor = pick(el);
      if (editor?.state?.doc) candidates.push({ editor, host: el });
    }
    const ideEditor = window._ide?.editorManager?.editor?.view || window._ide?.editorManager?.view;
    if (ideEditor?.state?.doc) candidates.push({ editor: ideEditor, host: null });
    if (!candidates.length) return;

    const visible = candidates.filter((item) => item.host && isVisible(item.host));
    const chosen = visible[0] || candidates.slice().sort((a, b) => b.editor.state.doc.length - a.editor.state.doc.length)[0];
    const editor = chosen.editor;
    const active = document.querySelector('.file-tree-inner li[role="treeitem"][aria-selected="true"]');
    const fallback = document.querySelector('.file-tree .active');
    const activeEntity = (active || fallback)?.querySelector('.entity');
    if (activeEntity?.getAttribute('data-file-type') === 'folder') { return; }
    const fileName = treePath(active || fallback);
    if (!fileName) return;

    let selection = '';
    try {
      const main = editor.state.selection.main;
      if (!main.empty) selection = editor.state.sliceDoc(main.from, main.to);
    } catch { /* ignore */ }

    window.postMessage({
      type: 'ARXIVER_OVERLEAF_SNAPSHOT',
      data: { path: fileName, content: editor.state.doc.toString(), selection }
    }, '*');
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(snapshot, 600);
  };

  const attach = () => {
    const scroller = document.querySelector('.cm-scroller');
    const tree = document.querySelector('.file-tree-inner');
    if (scroller && !scrollerBound) {
      scrollerBound = true;
      new MutationObserver(schedule).observe(scroller, { childList: true, subtree: true, characterData: true });
    }
    if (tree && !treeBound) {
      treeBound = true;
      new MutationObserver(schedule).observe(tree, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-selected']
      });
    }
    document.removeEventListener('selectionchange', schedule);
    document.addEventListener('selectionchange', schedule);
    if (scrollerBound && treeBound && bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
    schedule();
  };

  attach();
  // 登录页 / 编辑器晚出现：用 DOM 观察器等它出现，不做定时轮询。
  if (!scrollerBound || !treeBound) {
    bodyObserver = new MutationObserver(() => attach());
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }
})()
`;

// 按 chat-overleaf 的做法：展开文件树，依次点击每个文本文件，等编辑器加载后读内容。
// 这是“提取项目文件”按钮的实现，不走 download/zip。
const EXTRACT_SCRIPT = String.raw`
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const treeRoot = document.querySelector('.file-tree-inner');
  if (!treeRoot) return { ok: false, error: '文件树还没加载' };
  const delayMin = __DELAY_MIN__;
  const delayMax = __DELAY_MAX__;
  const humanDelay = async () => {
    if (delayMax <= 0) return;
    const low = Math.max(0, Math.min(delayMin, delayMax));
    const high = Math.max(low, delayMax);
    await sleep(low + Math.random() * (high - low));
  };

  const label = (el) => el?.getAttribute('aria-label')?.trim()
    || el?.querySelector('.item-name-button span')?.textContent?.trim()
    || '';
  const treePath = (el) => {
    const parts = [label(el)].filter(Boolean);
    let list = el?.closest('ul.file-tree-folder-list');
    while (list) {
      const folder = list.previousElementSibling;
      if (!folder || !folder.matches('li[role="treeitem"]')) break;
      const name = label(folder);
      if (name) parts.unshift(name);
      list = folder.closest('ul.file-tree-folder-list');
    }
    return parts.join('/');
  };
  const allItems = () => [...treeRoot.querySelectorAll('li[role="treeitem"]')];
  const isFolder = (item) => !!item.querySelector('.entity[data-file-type="folder"]');
  const isTextFile = (name) => /\.(tex|txt|md|bib)$/i.test(name);
  const pick = (el) => el && (el.cmTile?.view || el.cmView?.view || el._view || el.view);
  const readDoc = () => {
    const candidates = [];
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (const el of document.querySelectorAll('.cm-content, .cm-editor')) {
      const editor = pick(el);
      if (editor?.state?.doc) candidates.push({ editor, host: el });
    }
    const ideEditor = window._ide?.editorManager?.editor?.view || window._ide?.editorManager?.view;
    if (ideEditor?.state?.doc) candidates.push({ editor: ideEditor, host: null });
    if (!candidates.length) return null;
    const visible = candidates.filter((item) => item.host && isVisible(item.host));
    const chosen = visible[0] || candidates.slice().sort((a, b) => b.editor.state.doc.length - a.editor.state.doc.length)[0];
    return chosen.editor.state.doc.toString();
  };
  const activeItem = () => document.querySelector('.file-tree-inner li[role="treeitem"][aria-selected="true"]')
    || document.querySelector('.file-tree .active');
  const cleanContent = (content) => {
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    const result = [];
    let commentBuffer = [];
    const flush = () => {
      if (commentBuffer.length) {
        result.push('%%% comment ...');
        commentBuffer = [];
      }
    };
    for (const line of lines) {
      if (line.trimStart().startsWith('%')) { commentBuffer.push(line); }
      else { flush(); result.push(line); }
    }
    flush();
    return result.join('\n');
  };

  const originalPath = treePath(activeItem());
  const collapsedBefore = allItems()
    .filter((item) => isFolder(item) && item.getAttribute('aria-expanded') === 'false')
    .map((item) => treePath(item))
    .filter(Boolean);

  // 展开所有文件夹
  for (let round = 0; round < 20; round++) {
    const collapsed = allItems().filter((item) => isFolder(item) && item.getAttribute('aria-expanded') === 'false');
    if (!collapsed.length) break;
    for (const folder of collapsed) {
      const button = folder.querySelector('.folder-expand-collapse-button, button[aria-label="Expand"], button[aria-label="Expand folder"]');
      if (button) button.click();
      await sleep(80);
    }
    await sleep(120);
  }
  await sleep(150);

  const paths = [...new Set(allItems()
    .filter((item) => !isFolder(item))
    .map((item) => treePath(item))
    .filter((path) => path && isTextFile(path)))];

  const files = [];
  const skipped = [];
  for (const path of paths) {
    const item = allItems().find((candidate) => !isFolder(candidate) && treePath(candidate) === path);
    if (!item) { skipped.push(path); continue; }
    const beforeContent = readDoc();
    const clickable = item.querySelector('.item-name-button') || item;
    clickable.click();

    let switched = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(100);
      if (treePath(activeItem()) === path) { switched = true; break; }
    }
    if (!switched) { skipped.push(path); continue; }

    // 仅 active 树节点切换还不够：CodeMirror 的正文可能还是上一个文件。
    // 等正文真正变化；空文件或内容恰好相同则最多等 1.5s。
    let content = readDoc();
    for (let settle = 0; settle < 15; settle++) {
      await sleep(100);
      const next = readDoc();
      if (next !== null && next !== beforeContent) { content = next; break; }
      content = next ?? content;
    }
    if (content === null) { skipped.push(path); continue; }
    const cleaned = cleanContent(content);
    if (cleaned.length > 2 * 1024 * 1024) { skipped.push(path); continue; }
    files.push({ name: path, content: cleaned, length: cleaned.length });
    await humanDelay();
  }

  // 恢复用户原来打开的文件
  if (originalPath) {
    const restore = allItems().find((item) => !isFolder(item) && treePath(item) === originalPath);
    if (restore) {
      (restore.querySelector('.item-name-button') || restore).click();
      await sleep(180);
    }
  }

  // 把原本折叠的文件夹恢复折叠
  for (const path of collapsedBefore) {
    const folder = allItems().find((item) => isFolder(item) && treePath(item) === path && item.getAttribute('aria-expanded') === 'true');
    if (!folder) continue;
    const button = folder.querySelector('.folder-expand-collapse-button, button[aria-label="Collapse"], button[aria-label="Collapse folder"]');
    if (button) button.click();
    await sleep(50);
  }

  if (!files.length) return { ok: false, error: '没有找到可提取的 .tex / .bib / .md / .txt 文件', skipped };
  return { ok: true, files, skipped };
})()
`;

function permissionSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION);
  if (!permissionsReady) {
    permissionsReady = true;
    // Overleaf 的正常编辑不需要摄像头/麦克风/定位；只放行剪贴板写入，避免页面误弹权限。
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write");
    });
  }
  return ses;
}

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) {
    return view;
  }
  if (!parent) {
    throw new Error("主窗口尚未就绪");
  }

  permissionSession();
  const next = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 只负责把页面里的文档快照转成 IPC；不向远程页面暴露 API
      preload: path.join(__dirname, "../preload/overleaf.js")
    }
  });
  next.setBackgroundColor("#1e1e1e");
  parent.contentView.addChildView(next);
  next.setVisible(false);
  pageReady = false;

  const wc = next.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { void shell.openExternal(url); }
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host !== "overleaf.com" && !host.endsWith(".overleaf.com")) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      /* 非法 URL 交给 Chromium 处理 */
    }
  });
  wc.on("did-start-loading", () => sendStatus());
  wc.on("did-stop-loading", () => sendStatus());
  wc.on("did-navigate", () => sendStatus());
  wc.on("did-navigate-in-page", () => sendStatus());
  wc.on("page-title-updated", () => sendStatus());
  wc.on("did-fail-load", (_event, code, desc, url, isMainFrame) => {
    if (isMainFrame) {
      logger.warn("overleaf", `页面加载失败 ${code} ${desc}: ${url}`);
      if (/^https:\/\/([a-z0-9-]+\.)?overleaf\.com\//i.test(url)) {
        pageReady = true;
        if (lastBounds?.visible) { next.setVisible(true); }
      }
      sendStatus();
    }
  });
  const installSnapshot = (): void => {
    void wc.executeJavaScript(SNAPSHOT_SCRIPT).catch((error) => {
      logger.warn("overleaf", "安装文档观察器失败: " + logger.errText(error));
    });
  };
  wc.on("dom-ready", () => {
    installSnapshot();
    // DOM 就绪就先显示页面（登录页/项目页的首屏通常已经可用），
    // 子资源（字体、验证码等）继续在后台加载，避免让用户一直看加载提示。
    const readyUrl = wc.getURL();
    if (/^https:\/\/([a-z0-9-]+\.)?overleaf\.com\//i.test(readyUrl)) {
      setTimeout(() => {
        if (wc.isDestroyed()) { return; }
        pageReady = true;
        if (lastBounds?.visible) { next.setVisible(true); }
        sendStatus();
      }, 120);
    }
    sendStatus();
  });
  wc.on("did-finish-load", () => {
    installSnapshot();
    const loadedUrl = wc.getURL();
    if (/^https:\/\/([a-z0-9-]+\.)?overleaf\.com\//i.test(loadedUrl)) {
      pageReady = true;
      if (lastBounds?.visible) { next.setVisible(true); }
    }
    sendStatus();
  });
  wc.on("ipc-message", (_event, channel, payload) => {
    if (channel !== "overleaf:snapshot") { return; }
    const data = payload as { path?: unknown; content?: unknown; selection?: unknown } | null;
    if (!data || typeof data.path !== "string" || !data.path || typeof data.content !== "string") { return; }
    if (data.content.length > MAX_FILE_CHARS) { return; }
    parent?.webContents.send("overleaf:doc", {
      path: data.path,
      content: data.content,
      selection: typeof data.selection === "string" ? data.selection : "",
      at: Date.now()
    });
  });

  void wc.loadURL(HOME_URL).catch((error) => {
    logger.warn("overleaf", "打开 Overleaf 失败: " + logger.errText(error));
  });

  view = next;
  return next;
}

export function attach(win: BrowserWindow): void {
  parent = win;
  if (view && !view.webContents.isDestroyed()) {
    try {
      win.contentView.addChildView(view);
      view.setVisible(false);
    } catch {
      /* 已在当前窗口里 */
    }
  }
}

export function getStatus(): OverleafStatus {
  if (!view || view.webContents.isDestroyed()) {
    return { url: "", title: "", loading: false, ready: false, canGoBack: false, canGoForward: false };
  }
  const wc = view.webContents;
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = wc.navigationHistory.canGoBack();
    canGoForward = wc.navigationHistory.canGoForward();
  } catch { /* ignore */ }
  let url = wc.getURL();
  if (url === "about:blank") { url = ""; }
  return {
    url,
    title: wc.getTitle(),
    loading: wc.isLoading(),
    ready: pageReady,
    canGoBack,
    canGoForward
  };
}

function sendStatus(): void {
  if (!parent || parent.isDestroyed()) { return; }
  try { parent.webContents.send("overleaf:status", getStatus()); } catch { /* ignore */ }
}

/** 渲染端报告 Overleaf 网页占位区的位置；隐藏时只把视图藏起来，不销毁登录态。 */
export function setBounds(bounds: OverleafBounds): void {
  if (!bounds) { return; }
  lastBounds = bounds;
  if (!bounds.visible || bounds.width <= 0 || bounds.height <= 0) {
    view?.setVisible(false);
    return;
  }
  const next = ensureView();
  next.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });
  // 像普通浏览器一样尽早显示页面，让用户看到 Overleaf 自己的加载过程；
  // 地址栏会同时显示 URL / 加载状态。
  next.setVisible(true);
  sendStatus();
}

export function back(): void {
  if (!view || view.webContents.isDestroyed()) { return; }
  if (view.webContents.navigationHistory.canGoBack()) { view.webContents.navigationHistory.goBack(); }
}

export function forward(): void {
  if (!view || view.webContents.isDestroyed()) { return; }
  if (view.webContents.navigationHistory.canGoForward()) { view.webContents.navigationHistory.goForward(); }
}

export function navigate(url: string): { ok: boolean; error?: string } {
  try {
    let raw = String(url || "").trim();
    if (!raw) { return { ok: false, error: "请输入网址" }; }
    if (!/^https?:\/\//i.test(raw)) { raw = "https://" + raw; }
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "只支持 http / https 网址" };
    }
    if (parsed.hostname !== "overleaf.com" && !parsed.hostname.endsWith(".overleaf.com")) {
      return { ok: false, error: "只能打开 overleaf.com 域名" };
    }
    void ensureView().webContents.loadURL(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: "网址格式不正确" };
  }
}

export function reload(): void {
  ensureView().webContents.reload();
}

export function home(): void {
  void ensureView().webContents.loadURL(HOME_URL);
}

export function login(): void {
  void ensureView().webContents.loadURL(LOGIN_URL);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readCurrent(): Promise<OverleafReadResult> {
  try {
    const wc = ensureView().webContents;
    const url = wc.getURL();
    if (!/^https:\/\/([a-z0-9-]+\.)?overleaf\.com\//i.test(url)) {
      return { ok: false, error: "请先在 Overleaf 区登录并打开一个项目" };
    }
    const result = await wc.executeJavaScript(READ_SCRIPT, true);
    if (!result || !result.ok) {
      return { ok: false, error: result?.error || "没有找到编辑器" };
    }
    return {
      ok: true,
      fileName: String(result.fileName || ""),
      content: String(result.content || ""),
      selection: String(result.selection || "")
    };
  } catch (error) {
    logger.warn("overleaf", "读取当前文件失败: " + errorText(error));
    return { ok: false, error: errorText(error) };
  }
}

export async function listProjectFiles(force = false): Promise<string[]> {
  const wc = ensureView().webContents;
  const match = /\/project\/([A-Za-z0-9]+)/.exec(wc.getURL());
  if (!match) { throw new Error("请先打开一个 Overleaf 项目"); }
  const projectId = match[1];
  if (!force && fileIndexCache && fileIndexCache.projectId === projectId && Date.now() - fileIndexCache.at < 30_000) {
    return fileIndexCache.paths;
  }

  const result = await wc.executeJavaScript(`(async () => {
    const res = await fetch(${JSON.stringify(`/project/${projectId}/entities`)}, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, entities: data.entities || [] };
  })()`, true);
  if (!result || !result.ok) {
    throw new Error(result?.error || "获取项目文件列表失败");
  }

  const paths: string[] = [...new Set<string>((result.entities || [])
    .filter((entity: { type?: unknown; path?: unknown }) => entity.type !== "folder" && typeof entity.path === "string")
    .map((entity: { path: string }): string => normalizePath(entity.path))
    .filter((path: string) => !!path && READABLE_FILE.test(path)))]
    .sort((a: string, b: string) => a.localeCompare(b));

  fileIndexCache = { projectId, paths, at: Date.now() };
  return paths;
}

async function readFileForAgent(path: string, signal: AbortSignal): Promise<{ ok: boolean; content?: string; error?: string }> {
  const target = normalizePath(path);
  if (!target) { return { ok: false, error: "文件路径不能为空" }; }
  if (signal.aborted) { return { ok: false, error: "已取消" }; }

  const before = await readCurrent();
  const alreadyOpen = before.ok && pathsMatch(before.fileName || "", target);
  if (alreadyOpen && before.content !== undefined) {
    return { ok: true, content: before.content };
  }

  const navigated = await navigateToFile(target);
  if (!navigated.ok) { return { ok: false, error: navigated.error }; }

  const previous = before.ok ? before.content || "" : "";
  let last: string | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal.aborted) { return { ok: false, error: "已取消" }; }
    await sleep(120);
    const current = await readCurrent();
    if (!current.ok || current.content === undefined) { continue; }
    if (!pathsMatch(current.fileName || "", target)) { continue; }
    last = current.content;
    if (current.content !== previous) {
      // 再等一个 tick，避免读到切换过程中尚未稳定的那一帧
      await sleep(100);
      const stable = await readCurrent();
      return {
        ok: true,
        content: stable.ok && pathsMatch(stable.fileName || "", target) ? stable.content : current.content
      };
    }
    // 空文件或内容恰好相同：等待约 1.2s 后接受当前内容
    if (attempt >= 10) { return { ok: true, content: current.content }; }
  }
  if (last !== undefined) { return { ok: true, content: last }; }
  return { ok: false, error: `读取 ${target} 超时：请确认文件已在 Overleaf 中打开` };
}

export async function syncProject(): Promise<OverleafSyncResult> {
  const empty: OverleafSyncResult = { ok: false, files: [], skipped: [] };
  try {
    const wc = ensureView().webContents;
    const url = wc.getURL();
    const match = /\/project\/([A-Za-z0-9]+)/.exec(url);
    if (!match) {
      return { ...empty, error: "请先打开一个 Overleaf 项目" };
    }
    const projectId = match[1];
    const script = EXTRACT_SCRIPT
      .replace("__DELAY_MIN__", String(EXTRACT_DELAY_MIN))
      .replace("__DELAY_MAX__", String(EXTRACT_DELAY_MAX));
    logger.info("overleaf", `开始逐个提取项目文件：${projectId}`);

    const result = await wc.executeJavaScript(script, true);
    if (!result || !result.ok) {
      return { ...empty, projectId, error: result?.error || "提取项目文件失败", skipped: result?.skipped || [] };
    }

    const files: OverleafFile[] = (result.files || [])
      .map((file: { name?: unknown; content?: unknown; length?: unknown }): OverleafFile => ({
        path: String(file.name || ""),
        content: String(file.content || ""),
        size: typeof file.length === "number" ? file.length : String(file.content || "").length
      }))
      .filter((file: OverleafFile) => !!file.path);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const skipped: string[] = Array.isArray(result.skipped) ? result.skipped.map(String) : [];
    logger.info("overleaf", `提取完成：${files.length} 个文本文件，跳过 ${skipped.length} 个`);
    return { ok: true, projectId, files, skipped, syncedAt: Date.now() };
  } catch (error) {
    logger.warn("overleaf", "提取项目文件失败: " + errorText(error));
    return { ...empty, error: errorText(error) };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePath(value: string): string {
  return String(value || "").replace(/^\/+|\/+$/g, "").trim();
}

function pathsMatch(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (!left || !right) { return false; }
  return left === right || left.endsWith("/" + right) || right.endsWith("/" + left);
}

function extractCommentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length) { blocks.push(buffer.join("")); buffer = []; }
  };
  const lineRegex = /(.*?)(\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(source)) !== null) {
    const line = match[1];
    const newline = match[2];
    if (line === "" && newline === "" && match.index >= source.length) { break; }
    if (line.trimStart().startsWith("%")) { buffer.push(line + newline); }
    else { flush(); }
    if (newline === "") { break; }
  }
  flush();
  return blocks;
}

function countTrailingNewlines(value: string): number {
  let count = 0;
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "\n") { break; }
    count++;
    if (i > 0 && value[i - 1] === "\r") { i--; }
  }
  return count;
}

/** 把模型输出里的注释占位符还原成原文里的注释块 */
function expandPlaceholders(replaceText: string, originalSlice: string): string {
  if (!replaceText.includes(COMMENT_PLACEHOLDER)) { return replaceText; }
  const blocks = extractCommentBlocks(originalSlice);
  let index = 0;
  const parts = replaceText.split(COMMENT_PLACEHOLDER);
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const block = blocks[index++] ?? COMMENT_PLACEHOLDER;
    let next = parts[i];
    if (countTrailingNewlines(block) === 1 && next.startsWith("\n")) {
      next = next.replace(/^\r?\n/, "");
    }
    result += block + next;
  }
  return result;
}

interface EditChange {
  from: number;
  to: number;
  insert: string;
}

interface BuiltEdit {
  ok: boolean;
  changes?: EditChange[];
  firstPos?: number;
  firstEnd?: number;
  error?: string;
}

function buildEditChanges(command: ReplaceCommand, content: string): BuiltEdit {
  try {
    if (command.commandType === "insert") {
      const after = command.insertAnchor?.after || "";
      const before = command.insertAnchor?.before || "";
      const afterMatches = after ? getMatchPositions(content, after, false) : [];
      const beforeMatches = before ? getMatchPositions(content, before, false) : [];
      if (after && afterMatches.length === 0) { return { ok: false, error: "未找到 AFTER 锚点" }; }
      if (before && beforeMatches.length === 0) { return { ok: false, error: "未找到 BEFORE 锚点" }; }
      let at: number;
      if (after && before) {
        const afterEnd = afterMatches[0].end;
        if (afterEnd > beforeMatches[0].start) {
          return { ok: false, error: "AFTER 锚点必须在 BEFORE 锚点之前" };
        }
        at = afterEnd;
      } else if (after) {
        at = afterMatches[0].end;
      } else if (before) {
        at = beforeMatches[0].start;
      } else {
        return { ok: false, error: "插入操作需要至少一个锚点" };
      }
      const insert = expandPlaceholders(command.replace, content.slice(at, at));
      return { ok: true, changes: [{ from: at, to: at, insert }], firstPos: at, firstEnd: at };
    }

    const positions = getMatchPositions(content, command.search, command.isRegex);
    if (positions.length === 0) { return { ok: false, error: "未找到匹配内容" }; }
    if (positions.length > 10) { return { ok: false, error: `匹配次数过多（${positions.length} 次）` }; }

    const changes = positions.slice().reverse().map((position) => ({
      from: position.start,
      to: position.end,
      insert: command.isRegex
        ? position.text.replace(new RegExp(command.search), command.replace)
        : expandPlaceholders(command.replace, position.text)
    }));
    return {
      ok: true,
      changes,
      firstPos: Math.min(...positions.map((position) => position.start)),
      firstEnd: Math.max(...positions.map((position) => position.end))
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function dispatchEdit(changes: EditChange[], firstPos: number, firstEnd: number): Promise<OverleafEditResult> {
  try {
    const wc = ensureView().webContents;
    const result = await wc.executeJavaScript(`(() => {
      const pick = (el) => el && (el.cmTile?.view || el.cmView?.view || el._view || el.view);
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = [];
      for (const el of document.querySelectorAll('.cm-content, .cm-editor')) {
        const editor = pick(el);
        if (editor?.state?.doc) candidates.push({ editor, host: el });
      }
      const ideEditor = window._ide?.editorManager?.editor?.view || window._ide?.editorManager?.view;
      if (ideEditor?.state?.doc) candidates.push({ editor: ideEditor, host: null });
      if (!candidates.length) return { ok: false, error: '未找到编辑器' };
      const visible = candidates.filter((item) => item.host && isVisible(item.host));
      const chosen = visible[0] || candidates.slice().sort((a, b) => b.editor.state.doc.length - a.editor.state.doc.length)[0];
      const view = chosen.editor;
      const changes = ${JSON.stringify(changes)};
      const length = view.state.doc.length;
      if (changes.some((c) => c.from < 0 || c.to > length || c.from > c.to)) {
        return { ok: false, error: '匹配位置已失效，请重新同步文件' };
      }
      view.dispatch({
        changes,
        selection: { anchor: ${firstPos} },
        scrollIntoView: true
      });
      view.focus?.();
      return { ok: true };
    })()`, true);
    if (!result || !result.ok) { return { ok: false, error: result?.error || "编辑失败" }; }
    return { ok: true, replaced: changes.length };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function ensureTargetFile(file: string): Promise<{ ok: boolean; error?: string }> {
  const current = await readCurrent();
  if (current.ok && pathsMatch(current.fileName || "", file)) { return { ok: true }; }
  const navigated = await navigateToFile(file);
  if (!navigated.ok) { return navigated; }
  for (let attempt = 0; attempt < 14; attempt++) {
    await sleep(250);
    const check = await readCurrent();
    if (check.ok && pathsMatch(check.fileName || "", file)) { return { ok: true }; }
  }
  return { ok: false, error: `已尝试打开 ${file}，但编辑器没有切换到该文件` };
}

async function navigateToFile(file: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const wc = ensureView().webContents;
    const target = normalizePath(file);
    const result = await wc.executeJavaScript(`(async () => {
      const target = ${JSON.stringify(target)};
      const norm = (value) => String(value || '').replace(/^\\/+|\\/+$/g, '').trim();
      const label = (el) => el?.getAttribute('aria-label')?.trim()
        || el?.querySelector('.item-name-button span')?.textContent?.trim()
        || '';
      const treePath = (el) => {
        const parts = [label(el)].filter(Boolean);
        let list = el?.closest('ul.file-tree-folder-list');
        while (list) {
          const folder = list.previousElementSibling;
          if (!folder || !folder.matches('li[role="treeitem"]')) break;
          const name = label(folder);
          if (name) parts.unshift(name);
          list = folder.closest('ul.file-tree-folder-list');
        }
        return parts.join('/');
      };
      const root = document.querySelector('.file-tree-inner');
      if (!root) return { ok: false, error: '文件树还没加载' };
      const parts = target.split('/').filter(Boolean);
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? prefix + '/' + parts[i] : parts[i];
        const items = [...root.querySelectorAll('li[role="treeitem"]')];
        const folder = items.find((item) => item.querySelector('.entity[data-file-type="folder"]') && norm(treePath(item)) === prefix);
        if (folder && folder.getAttribute('aria-expanded') === 'false') {
          const button = folder.querySelector('.folder-expand-collapse-button, button[aria-label="Expand"], button[aria-label="Expand folder"]');
          if (button) button.click();
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
      }
      const items = [...root.querySelectorAll('li[role="treeitem"]')];
      const fileItem = items.find((item) => {
        if (item.querySelector('.entity[data-file-type="folder"]')) return false;
        return norm(treePath(item)) === target || norm(label(item)) === target;
      });
      if (!fileItem) return { ok: false, error: '未找到文件：' + target };
      const clickable = fileItem.querySelector('.item-name-button') || fileItem;
      clickable.click();
      return { ok: true };
    })()`, true);
    if (!result || !result.ok) { return { ok: false, error: result?.error || "打开文件失败" }; }
    await sleep(350);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function previewEdit(command: ReplaceCommand): Promise<OverleafEditResult> {
  try {
    if (command.commandType === "create") {
      return { ok: false, error: "新建文件不需要预览" };
    }
    const target = await ensureTargetFile(command.file);
    if (!target.ok) { return { ok: false, error: target.error }; }
    const current = await readCurrent();
    if (!current.ok || current.content === undefined) {
      return { ok: false, error: current.error || "读取当前文件失败" };
    }
    const built = buildEditChanges(command, current.content);
    if (!built.ok || !built.changes) { return { ok: false, error: built.error || "没有可预览的修改" }; }
    const wc = ensureView().webContents;
    await wc.executeJavaScript(`(() => {
      const pick = (el) => el && (el.cmTile?.view || el.cmView?.view || el._view || el.view);
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = [];
      for (const el of document.querySelectorAll('.cm-content, .cm-editor')) {
        const editor = pick(el);
        if (editor?.state?.doc) candidates.push({ editor, host: el });
      }
      if (!candidates.length) return false;
      const visible = candidates.filter((item) => item.host && isVisible(item.host));
      const view = (visible[0] || candidates.slice().sort((a, b) => b.editor.state.doc.length - a.editor.state.doc.length)[0]).editor;
      view.dispatch({
        selection: { anchor: ${built.firstPos}, head: ${built.firstEnd} },
        scrollIntoView: true
      });
      view.focus?.();
      return true;
    })()`, true);
    return { ok: true, replaced: built.changes.length };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function createProjectFile(command: ReplaceCommand): Promise<OverleafEditResult> {
  try {
    const wc = ensureView().webContents;
    const url = wc.getURL();
    const match = /\/project\/([A-Za-z0-9]+)/.exec(url);
    if (!match) { return { ok: false, error: "请先打开一个 Overleaf 项目" }; }
    const projectId = match[1];
    const target = normalizePath(command.file);
    if (!target) { return { ok: false, error: "文件路径不能为空" }; }
    const parts = target.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) { return { ok: false, error: "文件路径无效" }; }

    const csrf = String(await wc.executeJavaScript(
      `document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') || ''`,
      true
    ) || "");
    // 在页面内发起同源请求：自动带登录 Cookie / Origin / Referer，和 Overleaf 自己的前端一致。
    const api = async (path: string, method: "GET" | "POST", body?: unknown): Promise<any> => {
      const url = `https://www.overleaf.com${path}`;
      const bodyLiteral = body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body));
      const result = await wc.executeJavaScript(`(async () => {
        const res = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': ${JSON.stringify(csrf)}
          },
          body: ${bodyLiteral}
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
      })()`, true);
      if (!result?.ok) {
        throw new Error(`HTTP ${result?.status ?? "?"}: ${String(result?.text || "").slice(0, 300)}`);
      }
      try {
        return result.text ? JSON.parse(result.text) : null;
      } catch {
        return null;
      }
    };

    const entities = (await api(`/project/${projectId}/entities`, "GET"))?.entities || [];
    if (entities.some((entity: any) => normalizePath(entity.path) === target && entity.type !== "folder")) {
      return { ok: false, error: "文件已存在，请使用替换指令" };
    }

    let parentId: string | undefined;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = entities.find((entity: any) => entity.type === "folder" && normalizePath(entity.path) === prefix);
      if (existing?._id) { parentId = existing._id; continue; }
      const created = await api(`/project/${projectId}/folder`, "POST", {
        name: part,
        ...(parentId ? { parent_folder_id: parentId } : {})
      });
      if (!created?._id) { throw new Error(`创建文件夹失败：${part}`); }
      parentId = created._id;
    }

    // 注意：Overleaf 的 POST /project/:id/doc 只接受 name / parent_folder_id，
    // 传 content 会返回 400 "Unrecognized key: content"。先建空文档，打开后再用
    // CodeMirror 写入内容。
    await api(`/project/${projectId}/doc`, "POST", {
      name: fileName,
      ...(parentId ? { parent_folder_id: parentId } : {})
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const opened = await ensureTargetFile(command.file);
      if (opened.ok) {
        const current = await readCurrent();
        if (current.ok && current.content !== undefined) {
          if (!current.content.trim()) {
            const written = await dispatchEdit([{ from: 0, to: current.content.length, insert: command.replace }], 0, 0);
            if (!written.ok) {
              return { ok: false, error: "文件已创建，但写入内容失败：" + (written.error || "未知错误") };
            }
          }
          return { ok: true };
        }
        return { ok: false, error: "文件已创建，但无法读取新文件，请在文件树里手动打开" };
      }
      await sleep(500);
    }
    return { ok: false, error: "文件已创建，但没能自动打开，请在文件树里手动打开" };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function applyEdit(command: ReplaceCommand): Promise<OverleafEditResult> {
  try {
    if (command.commandType === "create") { return createProjectFile(command); }

    // 文件可能在生成建议之后被删除或重命名；先确认它还在项目里，
    // 避免把旧修改块应用到同名的其他文件，或出现“看起来已写入”的错觉。
    try {
      const paths = await listProjectFiles(true);
      if (!paths.some((path) => pathsMatch(path, command.file))) {
        return { ok: false, error: `项目里没有 ${command.file}（可能已删除或重命名），请重新获取文件列表` };
      }
    } catch {
      // 索引获取失败时继续按原逻辑打开文件，避免误伤可用场景
    }

    const target = await ensureTargetFile(command.file);
    if (!target.ok) { return { ok: false, error: target.error }; }
    const current = await readCurrent();
    if (!current.ok || current.content === undefined) {
      return { ok: false, error: current.error || "读取当前文件失败" };
    }
    const built = buildEditChanges(command, current.content);
    if (!built.ok || !built.changes || built.firstPos === undefined || built.firstEnd === undefined) {
      return { ok: false, error: built.error || "没有可应用的修改" };
    }
    const result = await dispatchEdit(built.changes, built.firstPos, built.firstEnd);
    if (result.ok) {
      logger.info("overleaf", `已应用修改：${command.file}（${built.changes.length} 处）`);
      await sleep(120);
    }
    return result;
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function undoEdit(command: ReplaceCommand): Promise<OverleafEditResult> {
  if (command.commandType === "create") {
    return { ok: false, error: "新建文件暂不支持自动撤销，请在 Overleaf 文件树里手动删除" };
  }
  if (command.commandType === "insert") {
    if (!command.replace) { return { ok: false, error: "插入内容为空，无法撤销" }; }
    return applyEdit({
      ...command,
      id: command.id + "-undo",
      commandType: "replace",
      search: command.replace,
      replace: "",
      isRegex: false,
      insertAnchor: undefined
    });
  }
  if (!command.replace) { return { ok: false, error: "删除操作无法自动恢复，请使用 Overleaf 的撤销" }; }
  return applyEdit({
    ...command,
    id: command.id + "-undo",
    commandType: "replace",
    search: command.replace,
    replace: command.search,
    isRegex: false,
    insertAnchor: undefined
  });
}

const EDIT_PROMPT = `你是专业的 LaTeX/Overleaf 写作助手，运行在桌面应用 Arxiver 的 Overleaf 区。
你可以阅读用户提供的 LaTeX 文件，并且可以通过结构化编辑指令把修改直接应用到 Overleaf 编辑器；是否应用由用户在界面上确认。

## 消息格式
当用户带选区提问时，消息里可能出现：
- [当前文件路径]：用户正在编辑的文件
- [当前消息的用户选中内容]：本次提问时选中的文本
- [当前消息的用户问题]：用户本次的指令或问题
没有这些标记时，按普通消息处理。

## 特殊规则（重要）
1. 注释占位符：\`%%% comment ...\` 代表折叠的注释块。除非用户明确要求删除注释，否则在 SEARCH/AFTER/BEFORE 中原样保留，不要修改它。
2. 匹配文本时，换行符及其周围空白会被视为一个“换行块”，不需要逐字符对齐空白。

## 读取项目文件（工具）
你可以调用两个工具：
- list_files：列出项目里的文本文件路径（不读取正文）；
- read_file(path)：打开并读取指定文件的正文。

系统注入的上下文可能只包含用户手动勾选的文件，或者只有文件路径。**看到文件索引里存在某个文件、但正文没有注入时，必须先调用 read_file(path)，不要直接说“看不到这个文件”，也不要让用户自己粘贴内容。** 读取会短暂切换左侧编辑器，这是正常行为。

生成修改块之前，FILE 必须存在于项目文件索引中。索引里没有的文件（例如用户刚删除的 5.tex）不要生成 REPLACE / INSERT / CREATE_FILE；不确定时先调用 list_files。文件被删除或重命名后，应说明情况并让用户确认新路径。

## 文件编辑指令
需要修改文件时，严格输出以下三种格式之一。一次可以输出多个块；块以外的内容用 Markdown 说明。

### 一、替换 / 删除（REPLACE）
<<<REPLACE>>>
FILE: <文件路径>
<<<SEARCH>>>
<被替换的原始内容>
<<<WITH>>>
<新内容>
<<<END>>>

规则：
1. SEARCH 必须在文件中唯一，能精确定位到一处；
2. SEARCH 尽量使用包含足够上下文的单行文本；单行无法唯一定位时才用多行；
3. 删除时 <<<WITH>>> 留空；
4. SEARCH 最多 20000 字符，匹配次数不要超过 10。

示例：
<<<REPLACE>>>
FILE: 3_method.tex
<<<SEARCH>>>
\\section{Method}
<<<WITH>>>
\\section{Proposed Method}
<<<END>>>

### 二、插入（INSERT）
<<<INSERT>>>
FILE: <文件路径>
<<<AFTER>>>
<前置定位文本>
<<<BEFORE>>>
<后置定位文本>
<<<CONTENT>>>
<插入内容>
<<<END>>>

规则：
1. 行内插入必须同时提供 AFTER 和 BEFORE（例如在两个词之间插入）；
2. 在两行之间插入新段落 / 公式时，只提供一个锚点（推荐 AFTER），容错率更高；
3. AFTER / BEFORE 至少有一个，且锚点长度至少 3 个字符。

示例（插入新章节）：
<<<INSERT>>>
FILE: main.tex
<<<AFTER>>>
\\end{abstract}
<<<BEFORE>>>
<<<CONTENT>>>

\\section{Introduction}
This is the introduction...
<<<END>>>

### 三、新建文件（CREATE_FILE）
<<<CREATE_FILE>>>
FILE: <相对路径>
<<<CONTENT>>>
<完整文件内容>
<<<END>>>

规则：路径不要以 / 开头；如果文件已存在，不要使用该指令，改用 REPLACE。

## 语言与正文（重要）
1. **文档正文默认只写英文**。聊天用中文回答没问题，但不要把中文正文写进 .tex；
2. **中文只允许出现在 \`%\` 注释里**（例如 \`% 这里说明修改原因\`），注释可以是中文，但注释之外必须是英文；
3. 只有用户明确要求中文正文时，才先说明“需要把 Overleaf 编译器切到 XeLaTeX，并在导言区加入 ctex/xeCJK”，等用户确认后再写；默认不要这样做；
4. 不要把用户的要求、字数限制、提纲说明写进正文。例如“用 150--250 字概括：研究问题是什么……”是要求，不是摘要内容；应该直接写出最终英文摘要；
5. 不要留下 ZZZ、......、[待补充] 这类占位符；信息不足时明确说明缺少什么，不要假装已经写好。

## 回答要求
1. 不需要修改时，直接用 Markdown 回答；引用文件时写清楚路径和章节，例如 \`4_experiments.tex §4.2\`；
2. 需要修改时，先说明打算改什么，再输出编辑块；不要在代码块里包住编辑块；
3. 不要输出整个文件，只输出必要的 SEARCH / WITH / CONTENT；
4. 上下文没有的信息要明确说不确定，不要编造；
5. 默认用中文回答，除非用户要求其他语言；
6. **你不能直接写入 Overleaf**：修改块只是建议，必须等用户在界面上点「应用」才会生效。不要写“已写入”“已修改”“已完成”或“已保存到 Overleaf”，也不要说已经替用户改好了；应说“下面给出修改建议，确认后点应用”。如果用户问为什么没生效，说明需要点「应用」。`;

function buildSystemPrompt(files: OverleafFile[], currentFile?: string, fileIndex: string[] = []): string {
  const names = files.map((file) => file.path).join("、");
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const raw = String(file.content || "");
    if (!raw.trim()) { continue; }
    const content = raw.length > SYSTEM_FILE_CHARS ? raw.slice(0, SYSTEM_FILE_CHARS) : raw;
    if (total + content.length > SYSTEM_TOTAL_CHARS) { break; }
    total += content.length;
    parts.push(`### 文件：${file.path}\n~~~latex\n${content}\n~~~`);
  }

  return [
    EDIT_PROMPT,
    "",
    "语言约定：正文英文；中文只放在 % 注释里。",
    currentFile ? `当前打开文件：${currentFile}` : "当前没有打开的文件。",
    names ? `本轮上下文文件：${names}` : "本轮没有附加项目文件。",
    fileIndex.length
      ? `\n## 项目文件索引（只有路径，需要正文请调用 read_file）\n${fileIndex.map((path) => `- ${path}`).join("\n")}`
      : "\n项目文件索引为空或获取失败；可以调用 list_files 获取。",
    parts.length ? `\n## 已注入的项目内容\n\n${parts.join("\n\n")}` : ""
  ].join("\n");
}

const MAX_TOOL_ROUNDS = 6;

async function runOverleafTool(name: string, rawArgs: string, signal: AbortSignal): Promise<string> {
  let args: { path?: unknown } = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return "工具参数不是合法 JSON。"; }

  if (name === "list_files") {
    const paths = await listProjectFiles(true);
    return paths.length ? paths.map((path) => `- ${path}`).join("\n") : "项目里没有找到可读取的 .tex / .bib / .md / .txt 文件。";
  }

  if (name === "read_file") {
    const path = String(args.path || "").trim();
    if (!path) { return "缺少 path 参数。"; }
    const result = await readFileForAgent(path, signal);
    if (!result.ok || result.content === undefined) {
      return `读取 ${path} 失败：${result.error || "未知错误"}。可以请用户先在 Overleaf 里打开该文件，或换一个路径重试。`;
    }
    const content = result.content;
    const clipped = content.length > 25_000 ? content.slice(0, 25_000) + "\n\n（内容过长，已截断）" : content;
    return `文件：${path}\n~~~latex\n${clipped || "（空文件）"}\n~~~`;
  }

  return `未知工具：${name}`;
}

export function chat(payload: OverleafChatRequest, emit: (event: OverleafEvent) => void): { turnId: string } {
  const turnId = String(payload.turnId || "");
  const controller = new AbortController();
  if (turnId) { controllers.set(turnId, controller); }

  void (async () => {
    try {
      const files = (payload.files || []).filter((file) => file && file.path);
      const currentFile = String(payload.currentFile || "").trim();

      let fileIndex: string[] = [];
      try {
        fileIndex = await listProjectFiles();
      } catch (error) {
        logger.warn("overleaf", "读取项目文件索引失败: " + errorText(error));
      }

      const system = buildSystemPrompt(files, currentFile, fileIndex);
      const history: ChatMessage[] = (payload.history || [])
        .filter((item) => item && (item.role === "user" || item.role === "assistant") && item.content)
        .slice(-20)
        .map((item) => ({ role: item.role, content: String(item.content) }));

      const selection = String(payload.selection || "").trim();
      const question = String(payload.message || "").trim();
      const asked = [
        selection ? `[当前消息的用户选中内容]\n${selection.slice(0, 20_000)}` : "",
        currentFile ? `[当前文件路径]\n${currentFile}` : "",
        `[当前消息的用户问题]\n${question}`
      ].filter(Boolean).join("\n\n");

      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: asked }
      ];

      logger.info("overleaf", `AI 请求：${files.length} 个附加文件，索引 ${fileIndex.length} 个路径，约 ${files.reduce((n, file) => n + (file.content?.length || 0), 0)} 字符`);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (controller.signal.aborted) { break; }
        const result = await runChat({
          messages,
          tools: OVERLEAF_TOOLS,
          signal: controller.signal,
          onDelta: (text) => emit({ turnId, type: "delta", text }),
          onReasoning: (text) => emit({ turnId, type: "reasoning", text })
        });

        if (result.usage) { emit({ turnId, type: "usage", usage: result.usage }); }

        if (result.toolCalls.length) {
          messages.push({
            role: "assistant",
            content: result.content || null,
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          });

          for (const call of result.toolCalls) {
            if (controller.signal.aborted) { break; }
            let args: { path?: unknown } = {};
            try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* ignore */ }
            const target = String(args.path || "").trim();
            emit({
              turnId,
              type: "tool",
              name: call.name,
              text: call.name === "read_file"
                ? `正在读取 ${target || "文件"}…`
                : "正在读取项目文件列表…"
            });

            let output: string;
            try {
              output = await runOverleafTool(call.name, call.arguments, controller.signal);
            } catch (error) {
              output = `工具执行失败：${errorText(error)}`;
            }
            emit({
              turnId,
              type: "tool",
              name: call.name,
              text: call.name === "read_file"
                ? (output.startsWith("读取")
                  ? output.split("。")[0]
                  : `已读取 ${target}（${output.length} 字符）`)
                : "项目文件列表已更新"
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: output.slice(0, 25_000)
            });
          }
          continue;
        }

        emit({ turnId, type: "done" });
        return;
      }

      if (!controller.signal.aborted) {
        emit({ turnId, type: "delta", text: "\n\n（已达到最大工具读取轮数，回答可能不完整。）" });
      }
      emit({ turnId, type: "done" });
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ turnId, type: "done" });
      } else {
        const message = errorText(error);
        logger.warn("overleaf", "AI 请求失败: " + message);
        emit({ turnId, type: "error", error: message });
      }
    } finally {
      if (turnId) { controllers.delete(turnId); }
    }
  })();

  return { turnId };
}

export function cancel(turnId: string): void {
  const controller = controllers.get(turnId);
  if (controller) {
    controller.abort();
    controllers.delete(turnId);
  }
}

export function dispose(): void {
  for (const controller of controllers.values()) { controller.abort(); }
  controllers.clear();
  if (view) {
    try { parent?.contentView.removeChildView(view); } catch { /* ignore */ }
    try { view.webContents.close(); } catch { /* ignore */ }
    view = null;
  }
  parent = null;
  pageReady = false;
  lastBounds = null;
}
