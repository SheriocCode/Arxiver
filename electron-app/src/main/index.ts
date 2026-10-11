import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";

import * as config from "./config";
import * as storage from "./storage";
import * as library from "./library";
import * as paths from "./paths";
import { EngineManager, clearTmpJobs, type PublicJob, type TransParams } from "./engine";
import * as localModel from "./localmodel";
import { AgentService, type AgentChatRequest } from "./agent/agent";
import * as conversations from "./agent/conversations";
import { Updater } from "./updater";

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

const engine = new EngineManager();
const agent = new AgentService();
const updater = new Updater();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

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
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "Arxiver",
    icon: paths.iconPath(),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0d0d0d", symbolColor: "#e6e6e9", height: 36 },
    backgroundColor: "#171717",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized", false));

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.maximize();

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

engine.on("update", (job: PublicJob) => send("job:update", job));
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

function registerIpc(): void {
  ipcMain.handle("config:get", () => config.get());
  ipcMain.handle("config:set", (_event, patch) => config.update(patch));
  ipcMain.handle("local:status", () => localModel.localModelStatus());

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    engineVersion: paths.engineVersion(),
    platform: process.platform,
    userData: paths.userDataDir(),
    engineDir: paths.engineDir()
  }));

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
  ipcMain.handle("library:result", (_event, id: string, cacheKey: string, variant?: string) => storage.readTranslation(id, cacheKey, variant));
  ipcMain.handle("library:blocks", (_event, id: string, cacheKey: string) => storage.readBlocks(id, cacheKey));

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
  ipcMain.handle("library:update", (_event, id: string, patch) => library.updateDocument(id, patch));
  ipcMain.handle("library:setTrash", (_event, id: string, trashed: boolean) => library.setTrash(id, trashed));
  ipcMain.handle("library:purge", (_event, id: string) => library.purge(id));
  ipcMain.handle("library:emptyTrash", () => library.emptyTrash());
  ipcMain.handle("library:addCollection", (_event, name: string, parent?: string | null) => library.addCollection(name, parent ?? null));
  ipcMain.handle("library:removeCollection", (_event, id: string) => library.removeCollection(id));
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
