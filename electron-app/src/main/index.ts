import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
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
import { resolveIdentifier, parseIdentifier } from "./metadata";
import { probePdf } from "./pdfmeta";
import * as logger from "./logger";
import { Updater } from "./updater";
import type { TranslationLogEntry } from "../shared/types";

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
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray(): void {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip("Arxiver");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示控制台", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => { quitting = true; app.quit(); } }
    ]));
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

function arxivToPdf(url: string): string {
  const match = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/abs\/([^?#\s]+)/i.exec(url);
  if (match) {
    return "https://arxiv.org/pdf/" + match[1].replace(/v\d+$/, "") + ".pdf";
  }
  return url;
}

async function fetchPdf(url: string): Promise<{ bytes: Buffer; name: string; sourceUrl: string }> {
  const target = arxivToPdf(url);
  const response = await fetch(target, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 Arxiver" }
  });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  let name = "paper.pdf";
  try {
    const parsed = new URL(response.url || target);
    name = path.basename(decodeURIComponent(parsed.pathname)) || name;
  } catch {
    // keep default
  }
  if (!/\.pdf$/i.test(name)) {
    name += ".pdf";
  }
  return { bytes: buffer, name, sourceUrl: target };
}

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
  for (const e of library.listTranslations().entries) {
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
  ipcMain.handle("logs:translation", () => translationLog());
  ipcMain.handle("library:result", (_event, id: string, cacheKey: string, variant?: string) => storage.readTranslation(id, cacheKey, variant));
  ipcMain.handle("library:blocks", (_event, id: string, cacheKey: string) => storage.readBlocks(id, cacheKey));
  ipcMain.handle("doc:outline", (_event, id: string) => getOutline(id));

  ipcMain.handle("library:state", () => library.list());
  ipcMain.handle("library:add", async (_event, payload: SourcePayload & { type?: string; collections?: string[] }) => {
    const loaded = await loadSourceBytes(payload);
    return library.addDocument({
      bytes: loaded.bytes,
      name: loaded.name,
      sourceUrl: loaded.sourceUrl,
      title: payload?.title,
      type: payload?.type,
      collections: payload?.collections
    });
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

  // 本地导入后补全元数据：优先文件名里的 arXiv 编号，其次 PDF 自带元信息 / 首页里的 arXiv、DOI
  ipcMain.handle("library:enrichMetadata", async (_event, docId: string) => {
    const doc = library.getDocument(docId);
    if (!doc) { return null; }
    try {
      const nameHit = parseIdentifier(doc.sourceName || "");
      let meta = nameHit ? await resolveIdentifier(doc.sourceName || "") : null;
      if (!meta) {
        const probe = await probePdf(docId);
        if (probe) {
          const id = probe.arxivId || probe.doi;
          if (id) { meta = await resolveIdentifier(id); }
          if (!meta) {
            // 只有 PDF 自带的 title/author 也要用上
            const patch: Partial<typeof doc> = {};
            if (probe.title && probe.title.length > 3 && probe.title.length < 300) { patch.title = probe.title; }
            if (probe.author) { patch.authors = probe.author; }
            if (Object.keys(patch).length) { library.updateDocument(docId, patch); }
            return library.getDocument(docId);
          }
        }
      }
      if (meta) {
        library.updateDocument(docId, {
          title: meta.title || doc.title,
          authors: meta.authors || doc.authors,
          year: meta.year || doc.year,
          venue: meta.venue || doc.venue,
          doi: meta.doi || doc.doi,
          abstract: meta.abstract || doc.abstract,
          summary: meta.abstract || doc.summary,
          type: meta.kind === "arxiv" ? "预印本" : doc.type
        });
        logger.info("library", `已补全元信息：${meta.title || docId}`);
      }
      return library.getDocument(docId);
    } catch (e) {
      logger.warn("library", "补全元信息失败：" + logger.errText(e));
      return doc;
    }
  });

  // 按标识符导入（粘贴 arXiv 链接/编号或 DOI）：走官方接口取元信息，arXiv 顺带下载 PDF
  ipcMain.handle("library:importByIdentifier", async (_event, input: string, collections: string[]) => {
    try {
      const meta = await resolveIdentifier(input);
      if (!meta) {
        return { ok: false, error: "没识别出 arXiv 编号或 DOI（可直接粘贴链接）" };
      }
      let bytes: Buffer | undefined;
      let name = meta.id.replace(/[\\/:*?"<>|]/g, "_") + ".pdf";
      if (meta.pdfUrl) {
        try {
          const loaded = await fetchPdf(meta.pdfUrl);
          bytes = loaded.bytes;
          if (loaded.name) { name = loaded.name; }
        } catch (e) {
          logger.warn("library", "下载 PDF 失败（仍导入元信息）：" + logger.errText(e));
        }
      }
      const doc = library.addDocument({
        bytes,
        name,
        sourceUrl: meta.pageUrl,
        title: meta.title || meta.id,
        type: meta.kind === "arxiv" ? "预印本" : "期刊论文",
        collections
      });
      library.updateDocument(doc.id, {
        authors: meta.authors,
        year: meta.year,
        venue: meta.venue,
        doi: meta.doi,
        abstract: meta.abstract,
        summary: meta.abstract
      });
      logger.info("library", `按标识符导入：${meta.title || meta.id}（${meta.kind}）`);
      return { ok: true, doc: library.getDocument(doc.id) };
    } catch (e) {
      logger.warn("library", "按标识符导入失败：" + logger.errText(e));
      return { ok: false, error: logger.errText(e, 200) };
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
  ipcMain.handle("window:hide", () => mainWindow?.hide());
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
