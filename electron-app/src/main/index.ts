import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";

import * as config from "./config";
import * as storage from "./storage";
import * as library from "./library";
import * as paths from "./paths";
import { EngineManager, clearTmpJobs, type PublicJob, type TransParams } from "./engine";
import * as localModel from "./localmodel";
import { AgentService, type AgentChatRequest } from "./agent/agent";
import * as conversations from "./agent/conversations";
import { getOutline } from "./outline";
import { importPaper, fetchPdf } from "./importPaper";
import { enrichDocMeta } from "./enrich";
import * as logger from "./logger";
import { Updater } from "./updater";
import type { AppChildProc, AppMetrics, AppProcessInfo, TranslationLogEntry } from "../shared/types";

// 数据目录优先级：
//   1. 显式覆盖 --user-data-dir=<path> 或环境变量 ARXIVER_USER_DATA（便于同时试跑多份构建）
//   2. 开发运行（未打包）→ %APPDATA%\Arxiver-dev（避免与安装版争用）
//   3. 安装版 → 默认 %APPDATA%\Arxiver
const userDataArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
const userDataOverride =
  (userDataArg ? userDataArg.slice("--user-data-dir=".length) : "") || process.env.ARXIVER_USER_DATA || "";
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
} else if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "Arxiver-dev"));
}

// 用户自选背景用的自定义协议，必须在本进程 ready 之前注册。
protocol.registerSchemesAsPrivileged([
  { scheme: "arxiver-bg", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const engine = new EngineManager();
const agent = new AgentService();
const updater = new Updater();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// 启动耗时打点：仅当 ARXIVER_PERF=1 时输出（用于对比/调试，不影响正常使用）
const PERF = !!process.env.ARXIVER_PERF;
const PERF_T0 = Date.now();
function perf(label: string): void {
  if (PERF) { console.log(`[perf] +${Date.now() - PERF_T0}ms ${label}`); }
}
perf("main module loaded");

// 翻译任务状态（用于系统运行日志：只在状态变化时记一条）
const jobStatus = new Map<string, string>();

process.on("unhandledRejection", (e) => logger.warn("app", "unhandledRejection: " + logger.errText(e)));

interface SourcePayload {
  docId?: string;
  sourceBytes?: Uint8Array;
  filePath?: string;
  url?: string;
  name?: string;
  sourceUrl?: string;
  title?: string;
  params?: Partial<TransParams>;
}

function trayImage(): Electron.NativeImage {
  const ico = paths.iconPath();
  return ico ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  tray?.setToolTip("Arxiver");
}

function createWindow(): void {
  perf("createWindow() called");
  // 初始就用"最大化大小"建窗（而不是显示后再最大化），避免出现"先小窗、再最大化"的一帧闪烁。
  const work = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: work.x,
    y: work.y,
    width: work.width,
    height: work.height,
    minWidth: 900,
    minHeight: 640,
    title: "Arxiver",
    icon: paths.iconPath(),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0d0d0d", symbolColor: "#e6e6e9", height: 36 },
    backgroundColor: "#0b0b0b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized", true));
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximized", false);
    // 建窗时用的就是"最大化大小"，所以取消最大化时要收敛到正常的浮动窗口尺寸
    const win = mainWindow;
    if (win) {
      const b = win.getBounds();
      if (b.width >= work.width && b.height >= work.height) {
        const w = Math.min(1180, work.width - 80);
        const h = Math.min(820, work.height - 80);
        win.setBounds({
          x: work.x + Math.round((work.width - w) / 2),
          y: work.y + Math.round((work.height - h) / 2),
          width: w,
          height: h
        });
      }
    }
  });

  mainWindow.webContents.once("did-start-loading", () => perf("renderer did-start-loading"));
  mainWindow.webContents.once("dom-ready", () => perf("renderer dom-ready"));
  mainWindow.webContents.once("did-finish-load", () => perf("renderer did-finish-load"));

  // 首帧就绪后再显示，避免白屏闪烁（启动动画现在是渲染端窗口内的遮罩层）。
  const reveal = (): void => {
    if (!mainWindow || mainWindow.isVisible()) { return; }
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
    logger.info("window", "主窗口已显示");
    logProcessMap();
    perf(`main window shown (ready-to-show) maximized=${mainWindow.isMaximized()} bounds=${JSON.stringify(mainWindow.getBounds())}`);
    if (PERF) { setTimeout(() => app.exit(0), 2500); }
  };
  mainWindow.once("ready-to-show", reveal);
  mainWindow.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) { reveal(); }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  const win = mainWindow;
  win.on("close", (event) => {
    if (!quitting) {
      // 关闭（点 × / 任务栏右键"关闭窗口" / Alt+F4）= 收进托盘：窗口从任务栏消失，应用继续在后台跑
      // （翻译任务不受影响）。想再打开：点托盘图标，或再启动一次（单实例会唤起已有窗口）。
      event.preventDefault();
      win.hide();
      tray?.setToolTip("Arxiver — 后台运行中");
    }
  });
}

// 任务管理器里所有子进程都叫 "Arxiver"（Windows 只按 exe 的描述显示，Chromium 那套
// "GPU 进程 / 工具进程" 是浏览器专属的内部机制，Electron 改不了）。所以在系统日志里列一份
// "是什么 → PID → 内存"，方便和任务管理器逐行对照（日志 → 系统运行日志）。
function processKind(m: Electron.ProcessMetric): string {
  const svc = (m as unknown as { serviceName?: string }).serviceName || "";
  if (m.type === "Browser") { return "主进程（窗口 + 后端）"; }
  if (m.type === "Tab") { return "界面渲染"; }
  if (m.type === "GPU") { return "GPU 进程（绘制/解码）"; }
  if (m.type === "Utility") {
    if (/network/i.test(svc)) { return "网络服务"; }
    if (/audio/i.test(svc)) { return "音频服务"; }
    if (/storage/i.test(svc)) { return "存储服务"; }
    if (/media|video|cdm|codec/i.test(svc)) { return "媒体/解码服务"; }
    if (/crash/i.test(svc)) { return "崩溃上报"; }
    return svc ? `工具进程 ${svc}` : "工具进程";
  }
  return m.type || "未知";
}

function logProcessMap(): void {
  try {
    const rows = collectProcs().map((p) => `${p.kind} pid=${p.pid} 工作集=${p.rssMB}MB（提交 ${p.commitMB}MB）`);
    logger.info("app", `本应用进程（${rows.length}）：${rows.join("；")}`);
  } catch { /* 拿不到就算了 */ }
}

// 主进程子进程（Python 引擎 / llama-server）的内存：Electron 的进程表里没有它们，
// 只能用系统计数（tasklist）拿；异步刷新 + 缓存，绝不阻塞主进程。
let osMemMap = new Map<number, { name: string; memMB: number }>();
let osMemAt = 0;
let osMemBusy = false;
function refreshOsMem(): void {
  if (osMemBusy || process.platform !== "win32" || Date.now() - osMemAt < 6000) { return; }
  osMemBusy = true;
  execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    osMemBusy = false;
    osMemAt = Date.now();
    if (err || !stdout) { return; }
    const map = new Map<number, { name: string; memMB: number }>();
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split('","');
      if (cols.length < 5) { continue; }
      const name = cols[0].replace(/^"/, "");
      const pid = Number(cols[1]);
      const kb = parseInt(cols[4].replace(/[^\d]/g, ""), 10) || 0;
      if (pid) { map.set(pid, { name, memMB: Math.round(kb / 1024) }); }
    }
    osMemMap = map;
  });
}

// 主进程的子进程清单（翻译引擎 / 本地模型服务）——只读内存里的状态，不做系统调用
function childProcs(): { pid: number; kind: string; name: string; detail?: string }[] {
  const out: { pid: number; kind: string; name: string; detail?: string }[] = [];
  const model = localModel.serverInfo();
  if (model.pid) {
    out.push({ pid: model.pid, kind: "本地模型服务", name: "llama-server", detail: model.port ? `端口 ${model.port}` : undefined });
  }
  for (const p of engine.processes()) {
    out.push({ pid: p.pid, kind: "翻译引擎", name: "python", detail: p.name || undefined });
  }
  return out;
}

// 自有进程快照（供"运行状态"面板与诊断报告复用）
function collectProcs(): AppProcessInfo[] {
  return app.getAppMetrics().map((m) => {
    const svc = (m as unknown as { serviceName?: string }).serviceName;
    const mem = (m.memory || {}) as { workingSetSize?: number; peakWorkingSetSize?: number; privateBytes?: number };
    return {
      pid: m.pid,
      kind: processKind(m),
      type: m.type || "?",
      serviceName: svc,
      // 工作集 / 提交大小都能在任务管理器「详细信息」里加同名列对照（Electron 没有"活动的专用工作集"这个数）
      rssMB: Math.round((mem.workingSetSize || 0) / 1024),
      commitMB: Math.round((mem.privateBytes || 0) / 1024),
      peakMB: Math.round((mem.peakWorkingSetSize || 0) / 1024),
      cpuPercent: m.cpu?.percentCPUUsage || 0,
      isMain: m.type === "Browser"
    };
  });
}

function createTray(): void {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip("Arxiver");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开主窗口", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  } catch {
    tray = null;
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

engine.on("update", (job: PublicJob) => {
  send("job:update", job);
  // 只在状态变化时记一条系统日志（进度更新太频繁）
  if (jobStatus.get(job.id) === job.status) { return; }
  jobStatus.set(job.id, job.status);
  const title = job.result_name || job.source_name || job.id;
  if (job.status === "queued") { logger.info("translate", `加入队列：${title}`); }
  else if (job.status === "running") { logger.info("translate", `开始翻译：${title}（${job.total_pages} 页）`); }
  else if (job.status === "done") { logger.info("translate", `翻译完成：${title}（${job.total_pages} 页）`); }
  else if (job.status === "error") { logger.error("translate", `翻译失败：${title} — ${job.error || job.message}`); }
  else if (job.status === "cancelled") { logger.warn("translate", `已取消：${title}`); }
});
engine.on("partial", (id: string, info: unknown) => send("job:partial", { id, ...(info as object) }));
engine.on("blocks", (id: string, blocks: unknown) => send("job:blocks", { id, blocks }));
agent.on("event", (event: unknown) => send("agent:event", event));
updater.on("status", (status: unknown) => send("update:status", status));


function resolveParams(overrides?: Partial<TransParams>): TransParams {
  const base = config.get() as unknown as Record<string, unknown>;
  const merged = { ...base, ...(overrides || {}) } as Record<string, unknown>;
  const isLocal = merged.translate_mode === "local";
  return {
    source_lang: (merged.source_lang as string) || "en",
    target_lang: (merged.target_lang as string) || "zh-CN",
    service: isLocal ? "openai" : (merged.service as string) || "openai",
    model: isLocal ? "hy-mt" : (merged.translate_model as string) || "",
    output_variant: (merged.output_variant as string) || "dual",
    pages: (merged.pages as string) || "",
    threads: (merged.threads as number) || 4,
    use_babeldoc: !!merged.use_babeldoc,
    skip_subset_fonts: !!merged.skip_subset_fonts,
    ignore_cache: !!merged.ignore_cache,
    formula_font_regex: (merged.formula_font_regex as string) || "",
    prompt: (merged.prompt as string) || "",
    extra_args: (merged.extra_args as string) || ""
  };
}

// 导入 PDF / 解析元数据是长耗时操作：把当前阶段推给渲染端，避免看起来像卡死
function reportLibraryProgress(text: string, done = false): void {
  try { mainWindow?.webContents.send("library:progress", { text, done }); } catch { /* 窗口已关闭 */ }
}

async function loadSourceBytes(payload?: SourcePayload): Promise<{ bytes: Buffer; name: string; sourceUrl: string }> {
  if (payload?.sourceBytes) {
    return {
      bytes: Buffer.from(payload.sourceBytes),
      name: payload.name || "source.pdf",
      sourceUrl: payload.sourceUrl || ""
    };
  }
  if (payload?.filePath) {
    return {
      bytes: fs.readFileSync(payload.filePath),
      name: payload.name || path.basename(payload.filePath),
      sourceUrl: ""
    };
  }
  if (payload?.url) {
    return fetchPdf(payload.url);
  }
  throw new Error("未指定 PDF 来源");
}

const BG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska"
};

function backgroundMime(name: string): string {
  return BG_MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
}

function readUiSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.uiSettingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUiSettings(data: unknown): void {
  try {
    const file = paths.uiSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2), "utf8");
  } catch {
    /* 忽略写失败 */
  }
}

// 翻译日志：文库里的已完成译文 + 引擎里进行中 / 失败的任务
function translationLog(): TranslationLogEntry[] {
  const out: TranslationLogEntry[] = [];
  const docOf = new Map<string, string>();
  for (const doc of library.list().documents) {
    for (const ref of doc.translations || []) { docOf.set(ref.cacheKey, doc.id); }
  }
  const seenIds = new Set<string>();
  for (const e of library.listTranslations().entries) {
    // 同一篇译文可能被多个文献条目引用（同一篇论文导入过两次）→ 只列一条，否则选中态会同时命中多行
    if (seenIds.has(e.id)) { continue; }
    seenIds.add(e.id);
    out.push({
      id: e.id,
      docId: docOf.get(e.id) || "",
      cacheKey: e.id,
      name: e.name || e.source_name,
      sourceName: e.source_name,
      sourceUrl: e.source_url,
      targetLang: e.target_lang,
      service: e.service,
      variant: e.output_variant,
      pages: e.pages,
      size: e.size,
      status: "done",
      message: "",
      created_at: (e.created_at || 0) * 1000,
      finished_at: null,
      donePages: 0,
      totalPages: 0,
      progress: null
    });
  }
  const known = new Set(out.map((x) => x.cacheKey));
  for (const j of engine.list()) {
    if (j.cache_key && known.has(j.cache_key)) { continue; }
    const failed = j.status === "error" || j.status === "cancelled";
    out.push({
      id: j.id,
      docId: j.doc_id,
      cacheKey: j.cache_key || "",
      name: j.result_name || j.source_name || j.id,
      sourceName: j.source_name,
      sourceUrl: j.source_url,
      targetLang: j.params?.target_lang || "",
      service: j.params?.service || "",
      variant: j.params?.output_variant || "",
      pages: j.params?.pages || "",
      size: 0,
      status: failed ? "failed" : j.status === "running" ? "running" : "queued",
      message: j.error || j.message || "",
      created_at: (j.created_at || 0) * 1000,
      finished_at: j.finished_at ? j.finished_at * 1000 : null,
      donePages: j.done_pages,
      totalPages: j.total_pages,
      progress: j.progress
    });
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out;
}

function registerIpc(): void {
  // 用户自选背景：arxiver-bg://bg/<文件名> → <userData>/background/<文件名>
  // 自己处理 Range（否则视频无法边下边播 / 拖动）。
  protocol.handle("arxiver-bg", (request) => {
    const name = path.basename(decodeURIComponent(new URL(request.url).pathname));
    const file = name ? path.join(paths.backgroundDir(), name) : "";
    if (!file || !fs.existsSync(file)) {
      return new Response("Not found", { status: 404 });
    }
    const size = fs.statSync(file).size;
    const type = backgroundMime(name);
    const match = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response("Range Not Satisfiable", { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "cache-control": "no-store"
        }
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      status: 200,
      headers: { "content-type": type, "content-length": String(size), "accept-ranges": "bytes", "cache-control": "no-store" }
    });
  });

  ipcMain.handle("background:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择背景图片或视频",
      properties: ["openFile"],
      filters: [
        { name: "图片或视频", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm", "mov", "mkv"] },
        { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
        { name: "视频", extensions: ["mp4", "webm", "mov", "mkv"] }
      ]
    });
    const source = result.canceled ? "" : result.filePaths[0] || "";
    if (!source) { return null; }
    const dir = paths.backgroundDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const name = "bg-" + Date.now() + path.extname(source).toLowerCase();
    fs.copyFileSync(source, path.join(dir, name));
    return { name, source };
  });

  ipcMain.handle("background:clear", () => {
    fs.rmSync(paths.backgroundDir(), { recursive: true, force: true });
    return true;
  });

  // 同步读取：渲染端首屏就要拿到设置（避免启动瞬间按默认值闪一下开屏动画）
  ipcMain.on("ui-settings:get", (event) => { event.returnValue = readUiSettings(); });
  ipcMain.handle("ui-settings:get", () => readUiSettings());
  ipcMain.handle("ui-settings:set", (_event, data: unknown) => { writeUiSettings(data); return true; });

  ipcMain.handle("config:get", () => config.get());
  ipcMain.handle("config:set", (_event, patch) => config.update(patch));
  ipcMain.handle("local:status", () => localModel.localModelStatus());

  ipcMain.handle("app:info", () => {
    perf("renderer first IPC (app:info) — React mounted");
    return {
    version: app.getVersion(),
    engineVersion: paths.engineVersion(),
    platform: process.platform,
    userData: paths.userDataDir(),
    engineDir: paths.engineDir()
    };
  });

  ipcMain.handle("source:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return { filePath, name: path.basename(filePath) };
  });

  ipcMain.handle("source:load", async (_event, payload: SourcePayload) => {
    const loaded = await loadSourceBytes(payload);
    return { bytes: loaded.bytes, name: loaded.name, sourceUrl: loaded.sourceUrl || "" };
  });

  ipcMain.handle("job:start", async (_event, payload: SourcePayload) => {
    const params = resolveParams(payload?.params);
    const loaded = await loadSourceBytes(payload);
    return engine.create(params, loaded.bytes, loaded.name, loaded.sourceUrl, payload?.docId || "");
  });

  ipcMain.handle("job:list", () => engine.list());
  ipcMain.handle("job:get", (_event, id: string) => engine.get(id));
  ipcMain.handle("job:cancel", (_event, id: string) => engine.cancel(id));
  ipcMain.handle("job:remove", (_event, id: string) => engine.remove(id));
  ipcMain.handle("job:blocks", (_event, id: string) => engine.blocks(id));
  ipcMain.handle("job:result", (_event, id: string, variant?: string) => engine.readResult(id, variant));
  ipcMain.handle("job:partial", (_event, id: string, variant?: string) => engine.readPartial(id, variant));

  ipcMain.handle("job:saveAs", async (_event, id: string, variant?: string) => {
    const bytes = engine.readResult(id, variant);
    if (!bytes) {
      return null;
    }
    const job = engine.get(id);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: "导出译文 PDF",
      defaultPath: job ? job.result_name : "translated.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (canceled || !filePath) {
      return null;
    }
    fs.writeFileSync(filePath, bytes);
    return filePath;
  });

  ipcMain.handle("agent:chat", (_event, payload: AgentChatRequest) => agent.run(payload));
  ipcMain.handle("agent:cancel", (_event, turnId: string) => agent.cancel(turnId));
  ipcMain.handle("agent:confirm", (_event, confirmId: string, decision: { approved: boolean; args?: string }) => agent.confirm(confirmId, decision));

  ipcMain.handle("update:status", () => updater.getStatus());
  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:download", () => updater.download());
  ipcMain.handle("update:install", () => updater.install());
  ipcMain.handle("agent:conversations", (_event, filter: { scope: "paper" | "library"; docId?: string }) => conversations.list(filter));
  ipcMain.handle("agent:conversation", (_event, id: string) => conversations.get(id));
  ipcMain.handle("agent:conversationSave", (_event, conv) => conversations.save(conv));
  ipcMain.handle("agent:conversationDelete", (_event, id: string) => conversations.remove(id));

  ipcMain.handle("storage:list", () => library.listTranslations());
  ipcMain.handle("logs:system", () => ({ entries: logger.list(), file: logger.logFile() }));
  ipcMain.handle("app:metrics", (_event, opts?: { os?: boolean }): AppMetrics => {
    const procs = collectProcs();
    const kids = childProcs();
    // 只有"面板在看" + "确实有子进程（引擎/模型在跑）"时才查系统计数：tasklist 有成本，其余情况一律跳过
    if (opts?.os !== false && kids.length) { refreshOsMem(); }
    const children: AppChildProc[] = kids.map((k) => {
      const info = osMemMap.get(k.pid);
      return { ...k, name: info?.name || k.name, memMB: info?.memMB ?? null };
    });
    const jobs = engine.list().slice(0, 8).map((j) => ({
      id: j.id,
      name: j.source_name || j.result_name || j.id,
      status: j.status,
      pages: j.total_pages,
      donePages: j.done_pages,
      message: j.message
    }));
    return {
      version: app.getVersion(),
      dev: !app.isPackaged,
      uptimeSec: Math.round(process.uptime()),
      userData: paths.userDataDir(),
      logFile: logger.logFile(),
      totalRssMB: procs.reduce((n, p) => n + p.rssMB, 0),
      totalCommitMB: procs.reduce((n, p) => n + p.commitMB, 0),
      procs,
      children,
      jobs
    };
  });
  // 导出诊断报告：进程快照 + 版本/环境 + 最近的系统日志（发给别人排查用）
  ipcMain.handle("app:diagnosticsSave", async (): Promise<string | null> => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: "导出诊断报告",
      defaultPath: path.join(app.getPath("documents"), `arxiver-diagnostics-${stamp}.txt`),
      filters: [{ name: "文本", extensions: ["txt"] }]
    });
    if (canceled || !filePath) { return null; }
    const procs = collectProcs();
    const lines = [
      `Arxiver ${app.getVersion()}（${app.isPackaged ? "安装版" : "开发版"}）`,
      `导出时间：${new Date().toLocaleString()}`,
      `已运行：${Math.round(process.uptime())} 秒`,
      `平台：${process.platform} ${process.arch} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
      `数据目录：${paths.userDataDir()}`,
      `日志文件：${logger.logFile()}`,
      "",
      `== 进程（${procs.length}，工作集合计 ${procs.reduce((n, p) => n + p.rssMB, 0)} MB / 提交合计 ${procs.reduce((n, p) => n + p.commitMB, 0)} MB）==`,
      ...procs.map((p) => `${p.kind}\t${p.type}${p.serviceName ? "/" + p.serviceName : ""}\tpid=${p.pid}\t工作集=${p.rssMB}MB\t提交=${p.commitMB}MB\t峰值=${p.peakMB}MB\tCPU=${p.cpuPercent}%`),
      "",
      "== 系统日志（最近 300 条）==",
      ...logger.list().slice(-300).map((e) => `${new Date(e.at).toISOString()} [${e.level}] ${e.scope}: ${e.message}`)
    ];
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    logger.info("app", `已导出诊断报告：${filePath}`);
    return filePath;
  });
  ipcMain.handle("logs:translation", () => translationLog());
  ipcMain.handle("library:result", (_event, id: string, cacheKey: string, variant?: string) => storage.readTranslation(id, cacheKey, variant));
  ipcMain.handle("library:blocks", (_event, id: string, cacheKey: string) => storage.readBlocks(id, cacheKey));
  ipcMain.handle("doc:outline", (_event, id: string) => getOutline(id));

  ipcMain.handle("library:state", () => library.list());
  ipcMain.handle("library:add", async (_event, payload: SourcePayload & { type?: string; collections?: string[] }) => {
    const label = payload?.name || "PDF";
    reportLibraryProgress(payload?.filePath ? `正在读取 ${label}…` : `正在导入 ${label}…`);
    try {
      const loaded = await loadSourceBytes(payload);
      reportLibraryProgress("正在写入文库…");
      return library.addDocument({
        bytes: loaded.bytes,
        name: loaded.name,
        sourceUrl: loaded.sourceUrl,
        title: payload?.title,
        type: payload?.type,
        collections: payload?.collections
      });
    } finally {
      reportLibraryProgress("", true);
    }
  });
  ipcMain.handle("library:addManual", (_event, payload: {
    title: string; authors?: string; year?: string; venue?: string; type?: string;
    tags?: string[]; collections?: string[]; summary?: string; abstract?: string;
  }) => library.addDocument({
    title: payload.title,
    authors: payload.authors,
    year: payload.year,
    venue: payload.venue,
    type: payload.type,
    tags: payload.tags,
    collections: payload.collections,
    summary: payload.summary,
    abstract: payload.abstract
  }));

  // 本地导入后补全元数据 → enrich.ts
  ipcMain.handle("library:enrichMetadata", async (_event, docId: string) => {
    try {
      return await enrichDocMeta(docId, (t) => reportLibraryProgress(t));
    } finally {
      reportLibraryProgress("", true);
    }
  });

  // 按标识符导入（粘贴 arXiv 链接/编号或 DOI）：逻辑在 importPaper.ts（agent 的 import_paper 工具共用）
  ipcMain.handle("library:importByIdentifier", async (_event, input: string, collections: string[]) => {
    try {
      return await importPaper({ identifier: input, collections, onProgress: (t) => reportLibraryProgress(t) });
    } finally {
      reportLibraryProgress("", true);
    }
  });
  ipcMain.handle("library:update", (_event, id: string, patch) => library.updateDocument(id, patch));
  ipcMain.handle("library:setTrash", (_event, id: string, trashed: boolean) => library.setTrash(id, trashed));
  ipcMain.handle("library:purge", (_event, id: string) => library.purge(id));
  ipcMain.handle("library:emptyTrash", () => library.emptyTrash());
  ipcMain.handle("library:addCollection", (_event, name: string, parent?: string | null) => library.addCollection(name, parent ?? null));
  ipcMain.handle("library:removeCollection", (_event, id: string) => library.removeCollection(id));
  ipcMain.handle("library:setTagColor", (_event, tag: string, color: string) => library.setTagColor(tag, color));
  ipcMain.handle("library:renameTag", (_event, from: string, to: string) => library.renameTag(from, to));
  ipcMain.handle("library:deleteTag", (_event, name: string) => library.deleteTag(name));
  ipcMain.handle("library:addTag", (_event, name: string) => library.addTag(name));
  ipcMain.handle("library:renameCollection", (_event, id: string, name: string) => library.renameCollection(id, name));
  ipcMain.handle("library:moveCollection", (_event, id: string, target: string | null, position: "before" | "after" | "inside") => library.moveCollection(id, target, position));
  ipcMain.handle("library:setDocsCollection", (_event, ids: string[], collectionId: string | null) => library.setDocsCollection(ids, collectionId));
  ipcMain.handle("library:recordOpen", (_event, id: string) => library.recordOpen(id));
  ipcMain.handle("library:addTranslation", (_event, id: string, ref) => library.addTranslation(id, ref));
  ipcMain.handle("library:removeTranslation", (_event, id: string, key: string) => library.removeTranslation(id, key));
  ipcMain.handle("library:reveal", (_event, id: string) => {
    const file = library.sourcePath(id);
    if (!file) { return false; }
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle("library:open", (_event, id: string) => {
    const doc = library.getDocument(id);
    return {
      bytes: library.readSource(id),
      name: doc ? doc.sourceName : "paper.pdf",
      sourceUrl: doc ? doc.sourceUrl : ""
    };
  });

  ipcMain.handle("shell:open", (_event, target: string) => shell.openPath(target));
  ipcMain.handle("shell:openExternal", (_event, url: string) => shell.openExternal(String(url)));
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow) { return; }
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); } else { mainWindow.maximize(); }
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);


}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    perf("app.whenReady");
    logger.info("app", `Arxiver ${app.getVersion()} 启动（${app.isPackaged ? "安装版" : "开发版"}），数据目录 ${paths.userDataDir()}`);
    if (process.platform === "win32") {
      app.setAppUserModelId("com.sherioccode.arxiver");
    }
    registerIpc();
    clearTmpJobs();
    createWindow();
    createTray();
    updater.init();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        showWindow();
      }
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    localModel.stopServer();
  });

  app.on("window-all-closed", () => {
    // keep running in the tray on Windows/Linux
  });
}
