import { BrowserWindow, net } from "electron";
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
 * 按需下载的本地模型。
 *
 * 安装包只带引擎源码、Python 运行时和依赖；两个大模型放到用户数据目录：
 * - layout：DocLayout-YOLO ONNX，任何翻译都要用（本地 / 在线接口都会跑本机版面识别）
 * - translate：HY-MT2 GGUF，仅「本地模型」翻译需要
 *
 * 下载完成后 layout 还会复制一份到 babeldoc 的缓存目录（引擎从那里读）。
 */

interface ModelSpec {
  id: LocalModelId;
  name: string;
  description: string;
  size: number;
  file: string;
  hashAlgo: "sha256";
  hash: string;
  sources: LocalModelSource[];
  requiredFor: "all" | "local";
}

const LAYOUT: ModelSpec = {
  id: "layout",
  name: "版面识别模型",
  description: "DocLayout-YOLO ONNX（约 72 MB）。识别标题、正文、图表等版式；本地翻译和在线接口翻译都需要。",
  size: 75_324_598,
  file: "doclayout_yolo_docstructbench_imgsz1024.onnx",
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
  hashAlgo: "sha256",
  hash: "6ef641a1fac7fb863af5d3627f767543aac95fc3be943bde12beec7cfca2fbff",
  sources: [
    { label: "HuggingFace", url: "https://huggingface.co/mradermacher/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B.Q4_K_M.gguf" },
    { label: "hf-mirror", url: "https://hf-mirror.com/mradermacher/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B.Q4_K_M.gguf" }
  ],
  requiredFor: "local"
};

const SPECS: Record<LocalModelId, ModelSpec> = { layout: LAYOUT, translate: TRANSLATE };
const active = new Map<LocalModelId, AbortController>();
const cancelled = new Set<LocalModelId>();

function ensureModelsDir(): void {
  fs.mkdirSync(paths.managedModelsDir(), { recursive: true });
}

function targetPath(id: LocalModelId): string {
  return id === "layout" ? paths.managedLayoutModelPath() : paths.managedTranslateModelPath();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
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
  if (fileSize(targetPath(id)) === spec.size) { return "managed"; }
  if (id === "layout" && fileSize(paths.babeldocModelPath()) === spec.size) { return "cache"; }
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
  const spec = LAYOUT;
  const cache = paths.babeldocModelPath();
  if (fileSize(cache) === spec.size) { return; }
  const src = targetPath("layout");
  if (fileSize(src) !== spec.size) {
    throw new Error("缺少版面识别模型（DocLayout-YOLO），请到「设置 → 本地模型」下载");
  }
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.copyFileSync(src, cache);
  } catch (err) {
    throw new Error("版面识别模型复制失败：" + (err instanceof Error ? err.message : String(err)));
  }
}

export function modelsDirectory(): string {
  ensureModelsDir();
  return paths.managedModelsDir();
}

export function listModels(): LocalModelInfo[] {
  return [LAYOUT, TRANSLATE].map((spec) => {
    const source = installedSource(spec.id);
    const installed = source !== "none";
    const custom = spec.id === "translate" ? customTranslateModel() : "";
    const path = source === "custom"
      ? custom
      : source === "managed"
        ? targetPath(spec.id)
        : source === "cache"
          ? paths.babeldocModelPath()
          : targetPath(spec.id);
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      size: spec.size,
      installed,
      requiredFor: spec.requiredFor,
      path,
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
      throw new Error("模型校验失败，请重试");
    }
  } finally {
    clearTimeout(watchdog);
    controller.signal.removeEventListener("abort", onAbort);
  }
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
  ensureModelsDir();
  const target = targetPath(id);
  const part = target + ".part";
  try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
  let lastError = "";
  try {
    for (const url of ordered) {
      try {
        emitProgress(id, "downloading", 0, spec.size);
        await downloadFrom(spec, url, part, controller);
        if (cancelled.has(id)) { throw new Error("cancelled"); }
        // 翻译模型会被 llama-server 占用，替换前先停掉并等文件句柄释放
        if (id === "translate") { stopLocalServer(); await sleep(300); }
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
        let moved = false;
        for (let i = 0; i < 10 && !moved; i++) {
          try { fs.renameSync(part, target); moved = true; } catch { await sleep(200); }
        }
        if (!moved) { throw new Error("无法替换模型文件（可能仍被占用），请稍后重试"); }
        if (id === "layout") {
          const cache = paths.babeldocModelPath();
          fs.mkdirSync(path.dirname(cache), { recursive: true });
          fs.copyFileSync(target, cache);
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
  if (id === "translate") { stopLocalServer(); await sleep(300); }
  for (const file of [targetPath(id), targetPath(id) + ".part"]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  if (id === "layout") {
    try { fs.rmSync(paths.babeldocModelPath(), { force: true }); } catch { /* ignore */ }
  }
  return true;
}

const SOURCE_URLS = new Set(
  [LAYOUT, TRANSLATE].flatMap((spec) => spec.sources.map((s) => s.url))
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
