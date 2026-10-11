import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

export function engineDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine")
    : path.join(app.getAppPath(), "engine");
}

export function pythonExe(): string {
  const runtime = path.join(engineDir(), "runtime");
  return path.join(runtime, process.platform === "win32" ? "python.exe" : "python");
}

export function runScript(): string {
  return path.join(engineDir(), "run.py");
}

export function engineVersion(): string {
  try {
    return fs.readFileSync(path.join(engineDir(), "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

// 内置的本地翻译运行时：engine/llama（llama.cpp）与 engine/models（GGUF 翻译模型）。
// 二者随安装包分发（engine/ 已整体作为 extraResources 打包）。
export function localLlamaDir(): string {
  return path.join(engineDir(), "llama");
}

export function localModelDir(): string {
  return path.join(engineDir(), "models");
}

export function llamaServerExe(): string {
  return path.join(localLlamaDir(), process.platform === "win32" ? "llama-server.exe" : "llama-server");
}

export function bundledModelPath(): string {
  const dir = localModelDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".gguf"));
  } catch {
    // 目录不存在
  }
  // 优先使用 Q4_K_M；否则取任意一个 GGUF。
  const preferred = files.find((name) => name.toLowerCase().includes("q4_k_m"));
  if (preferred) {
    return path.join(dir, preferred);
  }
  if (files.length) {
    return path.join(dir, files.sort()[0]);
  }
  return path.join(dir, "hy-mt2-1.8b-q4_k_m.gguf");
}

export function userDataDir(): string {
  return app.getPath("userData");
}

export function configPath(): string {
  return path.join(userDataDir(), "config.json");
}

export function storageDir(): string {
  return path.join(userDataDir(), "storage");
}

export function tmpJobsDir(): string {
  return path.join(userDataDir(), "tmp_jobs");
}

export function iconPath(): string {
  const ico = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "resources", "icon.ico");
  return fs.existsSync(ico) ? ico : "";
}
