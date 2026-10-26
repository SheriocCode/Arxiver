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

// 按需下载模型的目录（用户数据目录，安装目录可能没有写权限）
export function managedModelsDir(): string {
  return path.join(userDataDir(), "models");
}

// 引擎（babeldoc）以 HOME/USERPROFILE 为根；放在 data/home 下，字体 / 版面模型 / tiktoken
// 也都跟着落到安装目录，不写 C 盘用户缓存。
export function dataHomeDir(): string {
  return path.join(userDataDir(), "home");
}

export function managedTranslateModelPath(): string {
  return path.join(managedModelsDir(), "hy-mt2-1.8b-q4_k_m.gguf");
}

export function managedLayoutModelPath(): string {
  return path.join(managedModelsDir(), "doclayout_yolo_docstructbench_imgsz1024.onnx");
}

// babeldoc 的离线资源缓存；版面识别模型需要放在这里
export function babeldocModelPath(): string {
  return path.join(dataHomeDir(), ".cache", "babeldoc", "models", "doclayout_yolo_docstructbench_imgsz1024.onnx");
}





// Electron/Chromium 的用户目录（缓存、LocalStorage、Cookies）。
export function profileDir(): string {
  return app.getPath("userData");
}

let resolvedDataDir = "";

// 应用数据（文库、模型、配置、日志）：优先 <安装目录>/data；不可写时回退到 profile。
export function userDataDir(): string {
  if (resolvedDataDir) { return resolvedDataDir; }
  const override = String(process.env.ARXIVER_DATA_DIR || "").trim();
  const installRoot = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  const candidate = override ? path.resolve(override) : path.join(installRoot, "data");
  try {
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    resolvedDataDir = candidate;
  } catch (err) {
    console.error("[arxiver] 数据目录不可写，回退到用户目录:", err);
    resolvedDataDir = app.getPath("userData");
  }
  return resolvedDataDir;
}

export function configPath(): string {
  return path.join(userDataDir(), "config.json");
}

// 界面设置（外观/启动等），由主进程同步写文件持久化，避免 localStorage 因渲染端
// origin（dev 端口）变化或进程被强杀而丢失。
export function uiSettingsPath(): string {
  return path.join(userDataDir(), "ui-settings.json");
}

export function storageDir(): string {
  return path.join(userDataDir(), "storage");
}

// AI 助手的技能库（可复用的提示词 / 工作流程），只在本机保存。
export function skillsPath(): string {
  return path.join(userDataDir(), "skills.json");
}

// 用户自选的界面背景（图片/视频），由 arxiver-bg:// 协议提供给渲染端。
export function backgroundDir(): string {
  return path.join(userDataDir(), "background");
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
