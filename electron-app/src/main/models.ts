import { BrowserWindow, net, shell } from "electron";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as paths from "./paths";
import { get as getConfig } from "./config";
import { stopServer as stopLocalServer } from "./localmodel";
import type { LocalModelId, LocalModelInfo, LocalModelProgress, LocalModelSource, ModelSourceTest } from "../shared/types";

/**
 * 按需下载的本地模型 / 运行时。
 *
 * 安装包只带引擎源码、Python 运行时、依赖和 CPU 版 llama.cpp；大文件放到用户数据目录：
 * - layout：DocLayout-YOLO ONNX，任何翻译都要用（本地 / 在线接口都会跑本机版面识别）
 * - translate：HY-MT2 GGUF，仅「本地模型」翻译需要
 * - gpu：Vulkan 版 llama.cpp（约 37 MB），本地翻译的可选显卡加速
 *
 * 下载完成后 layout 还会复制一份到 babeldoc 的缓存目录（引擎从那里读）；
 * gpu 运行时解压到 data/runtime/vulkan。
 */

interface ModelSpec {
  id: LocalModelId;
  name: string;
  description: string;
  size: number;
  /** 下载后的文件名 */
  file: string;
  /** file = 单文件；zip = 下载后解压安装 */
  kind: "file" | "zip";
  hashAlgo: "sha256";
  hash: string;
  sources: LocalModelSource[];
  requiredFor: "all" | "local" | "accel";
}

const LAYOUT: ModelSpec = {
  id: "layout",
  name: "版面识别模型",
  description: "DocLayout-YOLO ONNX（约 72 MB）。识别标题、正文、图表等版式；本地翻译和在线接口翻译都需要。",
  size: 75_324_598,
  file: "doclayout_yolo_docstructbench_imgsz1024.onnx",
  kind: "file",
  hashAlgo: "sha256",
  hash: "fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21",
  sources: [
    { label: "HuggingFace", url: "https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx?download=true" },
    { label: "hf-mirror", url: "https://hf-mirror.com/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx?download=true" },
    { label: "ModelScope", url: "https://www.modelscope.cn/models/AI-ModelScope/DocLayout-YOLO-DocStructBench-onnx/resolve/master/doclayout_yolo_docstructbench_imgsz1024.onnx" }
  ],
  requiredFor: "all"
};

const TRANSLATE: ModelSpec = {
  id: "translate",
  name: "本地翻译模型",
  description: "HY-MT2 1.8B Q4_K_M（约 1.1 GB）。仅「本地模型」翻译需要；使用在线接口时无需下载。",
  size: 1_133_081_344,
  file: "hy-mt2-1.8b-q4_k_m.gguf",
  kind: "file",
  hashAlgo: "sha256",
  hash: "6ef641a1fac7fb863af5d3627f767543aac95fc3be943bde12beec7cfca2fbff",
  sources: [
    { label: "HuggingFace", url: "https://huggingface.co/mradermacher/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B.Q4_K_M.gguf" },
    { label: "hf-mirror", url: "https://hf-mirror.com/mradermacher/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B.Q4_K_M.gguf" }
  ],
  requiredFor: "local"
};

const GPU: ModelSpec = {
  id: "gpu",
  name: "GPU 加速包",
  description: "Vulkan 版 llama.cpp 运行时（约 35 MB）。安装后本地翻译用显卡，速度是纯 CPU 的数倍；显卡或驱动不可用时自动回退 CPU。",
  size: 37_049_027,
  file: "llama-b11889-bin-win-vulkan-x64.zip",
  kind: "zip",
  hashAlgo: "sha256",
  hash: "3874d6cb33c3540a68191c1ca31b774bd72914e8ca65e51dfe23e3dae8201f00",
  sources: [
    { label: "GitHub", url: "https://github.com/ggml-org/llama.cpp/releases/download/b11889/llama-b11889-bin-win-vulkan-x64.zip" },
    { label: "gh-proxy", url: "https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b11889/llama-b11889-bin-win-vulkan-x64.zip" },
    { label: "ghproxy.net", url: "https://ghproxy.net/https://github.com/ggml-org/llama.cpp/releases/download/b11889/llama-b11889-bin-win-vulkan-x64.zip" }
  ],
  requiredFor: "accel"
};

const SPECS: Record<LocalModelId, ModelSpec> = { layout: LAYOUT, translate: TRANSLATE, gpu: GPU };
const active = new Map<LocalModelId, AbortController>();
const cancelled = new Set<LocalModelId>();

function ensureTargetDir(id: LocalModelId): void {
  fs.mkdirSync(path.dirname(downloadPath(id)), { recursive: true });
}

/** 下载文件的落盘路径（zip 运行时保存为 data/runtime/<file>.zip 后解压） */
function downloadPath(id: LocalModelId): string {
  // babeldoc 只认 ~/.cache/babeldoc/models；直接下到这里，避免再复制一份。
  if (id === "layout") { return paths.babeldocModelPath(); }
  if (id === "translate") { return paths.managedTranslateModelPath(); }
  return path.join(paths.runtimeDir(), SPECS.gpu.file);
}

/** 安装位置（界面展示 / 打开目录用） */
function installedPath(id: LocalModelId): string {
  return id === "gpu" ? paths.gpuRuntimeDir() : downloadPath(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** 旧版本把版面模型下载到 data/models；现在统一放在 babeldoc 缓存目录。 */
function migrateLegacyLayout(): boolean {
  const cache = paths.babeldocModelPath();
  if (fileSize(cache) === LAYOUT.size) { return true; }
  const legacy = paths.managedLayoutModelPath();
  if (fileSize(legacy) !== LAYOUT.size) { return false; }
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.renameSync(legacy, cache);
    return true;
  } catch { /* fall through */ }
  try {
    fs.copyFileSync(legacy, cache);
    fs.rmSync(legacy, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

function customTranslateModel(): string {
  return String(getConfig().local_model || "").trim();
}

function installedSource(id: LocalModelId): LocalModelInfo["source"] {
  const spec = SPECS[id];
  if (id === "translate") {
    const custom = customTranslateModel();
    if (custom && fs.existsSync(custom)) { return "custom"; }
  }
  if (id === "gpu") {
    const version = readText(paths.gpuRuntimeVersionFile());
    return fs.existsSync(paths.gpuRuntimeExe()) && version === SPECS.gpu.file ? "managed" : "none";
  }
  if (id === "layout") {
    return migrateLegacyLayout() ? "cache" : "none";
  }
  if (fileSize(downloadPath(id)) === spec.size) { return "managed"; }
  return "none";
}

function isInstalled(id: LocalModelId): boolean {
  return installedSource(id) !== "none";
}

export function layoutModelReady(): boolean {
  return isInstalled("layout");
}

/**
 * 翻译前调用：确保版面识别模型已经在 babeldoc 的缓存目录里。
 * 缺失时抛出可展示给用户的错误（不触发 babeldoc 自己的静默下载）。
 */
export function ensureLayoutModel(): void {
  if (!migrateLegacyLayout()) {
    throw new Error("缺少版面识别模型（DocLayout-YOLO），请到「设置 → 本地模型」下载");
  }
  // 缓存已经就绪时，清掉旧版本可能留下的重复文件。
  try { fs.rmSync(paths.managedLayoutModelPath(), { force: true }); } catch { /* ignore */ }
}

/** 升级后加速包的构建版本可能变了：清掉旧目录，让设置页重新提示下载 */
export function pruneStaleRuntime(): void {
  const dir = paths.gpuRuntimeDir();
  if (!fs.existsSync(dir)) { return; }
  if (readText(paths.gpuRuntimeVersionFile()) === SPECS.gpu.file) { return; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 打开某个模型实际所在的目录；文件会定位到所在文件夹，GPU 运行时直接打开目录。 */
export async function revealModel(id: LocalModelId): Promise<boolean> {
  if (!SPECS[id]) { return false; }
  const source = installedSource(id);
  if (source === "none") { return false; }
  const target = id === "gpu"
    ? paths.gpuRuntimeDir()
    : id === "translate" && source === "custom"
      ? customTranslateModel()
      : id === "layout"
        ? paths.babeldocModelPath()
        : downloadPath(id);
  try {
    if (fs.statSync(target).isDirectory()) {
      return !(await shell.openPath(target));
    }
    shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
}

export function listModels(): LocalModelInfo[] {
  return [LAYOUT, TRANSLATE, GPU].map((spec) => {
    const source = installedSource(spec.id);
    const installed = source !== "none";
    const custom = spec.id === "translate" ? customTranslateModel() : "";
    const modelPath = spec.id === "gpu"
      ? installedPath("gpu")
      : source === "custom"
        ? custom
        : source === "cache"
          ? paths.babeldocModelPath()
          : downloadPath(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      size: spec.size,
      installed,
      requiredFor: spec.requiredFor,
      path: modelPath,
      source,
      sources: spec.sources
    };
  });
}

function emit(progress: LocalModelProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) { win.webContents.send("model:progress", progress); }
  }
}

function emitProgress(id: LocalModelId, state: LocalModelProgress["state"], received: number, total: number, error?: string): void {
  const percent = total > 0 ? Math.max(0, Math.min(100, (received / total) * 100)) : 0;
  emit({ id, state, received, total, percent, error });
}

async function downloadFrom(spec: ModelSpec, url: string, part: string, controller: AbortController): Promise<void> {
  // 长时间没有数据就放弃这个地址，换下一个镜像；用户主动取消则直接结束。
  const local = new AbortController();
  const onAbort = (): void => local.abort();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let watchdog = setTimeout(() => local.abort(), 60000);
  const kick = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => local.abort(), 60000);
  };
  try {
    const res = await net.fetch(url, {
      signal: local.signal,
      redirect: "follow",
      headers: { "User-Agent": "Arxiver/model-downloader", "Accept-Encoding": "identity" }
    });
    kick();
    if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status}`); }
    const total = Number(res.headers.get("content-length")) || spec.size;
    const hash = crypto.createHash(spec.hashAlgo);
    let received = 0;
    let lastSent = 0;
    let lastPercent = -1;

    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        kick();
        received += chunk.length;
        hash.update(chunk);
        const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
        const now = Date.now();
        if (now - lastSent > 150 || percent !== lastPercent) {
          lastSent = now;
          lastPercent = percent;
          emitProgress(spec.id, "downloading", received, total);
        }
        cb(null, chunk);
      }
    });

    await pipeline(Readable.fromWeb(res.body as never), tap, fs.createWriteStream(part));
    emitProgress(spec.id, "verifying", received, total);
    if (received !== spec.size) { throw new Error(`文件大小不匹配（${received} / ${spec.size}）`); }
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== spec.hash.toLowerCase()) {
      throw new Error("文件校验失败，请重试");
    }
  } finally {
    clearTimeout(watchdog);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function runFile(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

async function extractZip(zip: string, dest: string): Promise<void> {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  try {
    await runFile(path.join(sysRoot, "System32", "tar.exe"), ["-xf", zip, "-C", dest]);
    return;
  } catch {
    // 极少数精简系统没有 tar.exe，退回 PowerShell
  }
  const quote = (p: string): string => "'" + p.replace(/'/g, "''") + "'";
  await runFile(path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dest)} -Force`
  ]);
}

/** 只保留 llama-server 与它需要的 DLL：官方压缩包里的其它工具（cli / bench 等）用不到 */
function trimRuntimeDir(dir: string): void {
  const dropDll = /^llama-(batched-bench|bench|cli|completion|fit-params|perplexity|quantize)-impl\.dll$/i;
  for (const name of fs.readdirSync(dir)) {
    const lower = name.toLowerCase();
    const drop =
      (lower.endsWith(".exe") && lower !== "llama-server.exe") ||
      dropDll.test(name) ||
      lower === "ggml-rpc.dll";
    if (drop) { fs.rmSync(path.join(dir, name), { force: true }); }
  }
}

async function installZip(zip: string): Promise<void> {
  const dest = paths.gpuRuntimeDir();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  try {
    await extractZip(zip, dest);
    trimRuntimeDir(dest);
    if (!fs.existsSync(paths.gpuRuntimeExe())) { throw new Error("压缩包内容不完整"); }
    fs.writeFileSync(paths.gpuRuntimeVersionFile(), SPECS.gpu.file, "utf8");
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error("运行时安装失败：" + (err instanceof Error ? err.message : String(err)));
  }
  fs.rmSync(zip, { force: true });
}

export async function downloadModel(id: LocalModelId, source?: string): Promise<boolean> {
  const spec = SPECS[id];
  if (!spec) { return false; }
  if (isInstalled(id)) {
    emitProgress(id, "done", spec.size, spec.size);
    return true;
  }
  if (active.has(id)) { return false; }
  const urls = spec.sources.map((s) => s.url);
  const preferred = source && urls.includes(source) ? source : "";
  const ordered = preferred ? [preferred, ...urls.filter((u) => u !== preferred)] : urls;
  const controller = new AbortController();
  active.set(id, controller);
  cancelled.delete(id);
  ensureTargetDir(id);
  const target = downloadPath(id);
  const part = target + ".part";
  try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
  let lastError = "";
  try {
    for (const url of ordered) {
      try {
        emitProgress(id, "downloading", 0, spec.size);
        await downloadFrom(spec, url, part, controller);
        if (cancelled.has(id)) { throw new Error("cancelled"); }
        // 模型 / 运行时的文件会被 llama-server 占用，替换前先停掉并等文件句柄释放
        if (id === "translate" || id === "gpu") { stopLocalServer(); await sleep(300); }
        if (spec.kind === "zip") {
          await installZip(part);
        } else {
          try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
          let moved = false;
          for (let i = 0; i < 10 && !moved; i++) {
            try { fs.renameSync(part, target); moved = true; } catch { await sleep(200); }
          }
          if (!moved) { throw new Error("无法替换模型文件（可能仍被占用），请稍后重试"); }
        }
        emitProgress(id, "done", spec.size, spec.size);
        return true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (cancelled.has(id) || controller.signal.aborted) { break; }
      }
    }
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    if (cancelled.has(id)) {
      emitProgress(id, "cancelled", 0, spec.size);
    } else {
      emitProgress(id, "error", 0, spec.size, lastError || "下载失败");
    }
    return false;
  } finally {
    active.delete(id);
    cancelled.delete(id);
  }
}

export function cancelModelDownload(id: LocalModelId): boolean {
  const controller = active.get(id);
  if (!controller) { return false; }
  cancelled.add(id);
  controller.abort();
  return true;
}

export async function removeModel(id: LocalModelId): Promise<boolean> {
  const spec = SPECS[id];
  if (!spec) { return false; }
  cancelModelDownload(id);
  if (id === "translate" || id === "gpu") { stopLocalServer(); await sleep(300); }
  if (id === "gpu") {
    try { fs.rmSync(paths.gpuRuntimeDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(downloadPath("gpu"), { force: true }); } catch { /* ignore */ }
    return true;
  }
  for (const file of [downloadPath(id), downloadPath(id) + ".part"]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  if (id === "layout") {
    // 兼容旧版本留在 data/models 的那份
    try { fs.rmSync(paths.managedLayoutModelPath(), { force: true }); } catch { /* ignore */ }
  }
  return true;
}

const SOURCE_URLS = new Set(
  [LAYOUT, TRANSLATE, GPU].flatMap((spec) => spec.sources.map((s) => s.url))
);

/** 从下载源拉取 1 MB 左右，估算首字节延迟与下载速度（用于设置页手动测速）。 */
export async function testModelSource(url: string): Promise<ModelSourceTest> {
  if (!SOURCE_URLS.has(url)) {
    return { ok: false, latencyMs: 0, speedBps: 0, bytes: 0, error: "未知下载源" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const started = Date.now();
  let firstByteMs = 0;
  let headerMs = 0;
  let bytes = 0;
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Arxiver/model-downloader",
        "Accept-Encoding": "identity",
        "Range": "bytes=0-1048575",
        "Cache-Control": "no-cache"
      }
    });
    headerMs = Date.now() - started;
    if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const deadline = Date.now() + 5000;
    while (bytes < 1024 * 1024 && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) { break; }
      if (!firstByteMs) { firstByteMs = Date.now() - started; }
      bytes += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const elapsed = Math.max(1, Date.now() - started);
    return {
      ok: true,
      latencyMs: firstByteMs || headerMs,
      speedBps: Math.round(bytes / (elapsed / 1000)),
      bytes
    };
  } catch (err) {
    if (bytes > 0) {
      const elapsed = Math.max(1, Date.now() - started);
      return { ok: true, latencyMs: firstByteMs || headerMs, speedBps: Math.round(bytes / (elapsed / 1000)), bytes };
    }
    return {
      ok: false,
      latencyMs: firstByteMs || headerMs,
      speedBps: 0,
      bytes,
      error: controller.signal.aborted ? "测速超时" : (err instanceof Error ? err.message : String(err))
    };
  } finally {
    clearTimeout(timeout);
  }
}
