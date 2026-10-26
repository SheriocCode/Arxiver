/**
 * 内置本地翻译模型（llama.cpp + HY-MT GGUF）。
 *
 * 翻译时按需拉起一个 `llama-server`（OpenAI 兼容端点），并复用同一进程；
 * 应用退出时调用 stopServer() 回收。二进制与模型随安装包分发在
 * engine/llama 与 engine/models 下（见 paths.ts）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { get as getConfig } from "./config";
import { llamaServerExe, localLlamaDir, managedTranslateModelPath, dataHomeDir } from "./paths";

// 对外暴露的模型名（--alias），稳定为 "hy-mt"，与具体 GGUF 文件名解耦。
export const LOCAL_MODEL_ALIAS = "hy-mt";
const MODEL_ALIAS = LOCAL_MODEL_ALIAS;

function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

let child: ChildProcess | null = null;
let baseUrl = "";
let startPromise: Promise<{ baseUrl: string; model: string }> | null = null;
let lastError = "";
let tail = "";

export function modelPath(): string {
  const override = String(getConfig().local_model || "").trim();
  if (override) { return override; }
  // 优先使用按需下载到用户数据目录的模型；开发环境回退到随仓库的 engine/models
  return managedTranslateModelPath();
}

export function localModelStatus(): { available: boolean; reason: string } {
  if (!fs.existsSync(llamaServerExe())) {
    return { available: false, reason: "缺少本地翻译运行时（engine/llama）" };
  }
  if (!fs.existsSync(modelPath())) {
    return { available: false, reason: "未下载本地翻译模型，请到「设置 → 本地模型」下载" };
  }
  return { available: true, reason: "" };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null) {
      throw new Error(`本地翻译服务启动失败：${lastError || tail.slice(-400) || "进程已退出"}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        if (!body || body.status === "ok") {
          return;
        }
      }
    } catch {
      // 尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("本地翻译服务启动超时");
}

async function spawnAndWait(gpuLayers: number): Promise<{ baseUrl: string; model: string }> {
  const config = getConfig();
  const port = await freePort();
  const threads = Math.max(1, Math.min(16, os.cpus().length - 1));
  const model = modelPath();
  const args = [
    "--model", model,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--alias", MODEL_ALIAS,
    "--ctx-size", "8192",
    "--threads", String(threads),
    "--n-gpu-layers", String(gpuLayers),
    "--jinja"
  ];

  // HY-MT2 的 GGUF 元数据把 eos_token_id 写成了 3（普通 token），真正用于结束助手回合的是
  // <｜hy_place▁holder▁no▁2｜>（id 120020）。不覆盖会导致模型不停、一直复读到上下文耗尽。
  if (/hy-mt2-1\.8b/i.test(path.basename(model))) {
    args.push("--override-kv", "tokenizer.ggml.eos_token_id=int:120020");
  }
  if (config.local_extra_args) {
    args.push(...splitArgs(String(config.local_extra_args)));
  }

  tail = "";
  lastError = "";
  const proc = spawn(llamaServerExe(), args, {
    cwd: localLlamaDir(),
    windowsHide: true,
    env: { ...process.env, HOME: dataHomeDir(), USERPROFILE: dataHomeDir() }
  });
  child = proc;
  proc.stdout?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-4000); });
  proc.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-4000); });
  proc.on("error", (err) => { lastError = err.message; });
  proc.on("exit", (code, signal) => {
    if (child === proc) {
      child = null;
      baseUrl = "";
      lastError = `本地翻译服务已退出（code ${code ?? signal ?? "?"}）`;
    }
  });

  await waitForHealth(port, 120000);
  baseUrl = `http://127.0.0.1:${port}/v1`;
  return { baseUrl, model: MODEL_ALIAS };
}

async function start(): Promise<{ baseUrl: string; model: string }> {
  const gpuLayers = Math.max(0, Number(getConfig().local_gpu_layers) || 0);
  try {
    return await spawnAndWait(gpuLayers);
  } catch (err) {
    if (gpuLayers > 0) {
      // 显卡不可用 / 显存不足 / 驱动不匹配时退回纯 CPU，保证本地翻译始终可用。
      stopServer();
      return await spawnAndWait(0);
    }
    throw err;
  }
}

export async function ensureServer(): Promise<{ baseUrl: string; model: string }> {
  const status = localModelStatus();
  if (!status.available) {
    throw new Error("本地翻译不可用：" + status.reason);
  }
  if (child && child.exitCode === null && baseUrl) {
    return { baseUrl, model: MODEL_ALIAS };
  }
  if (!startPromise) {
    startPromise = start().finally(() => { startPromise = null; });
  }
  return startPromise;
}

// 本地模型服务状态（供"运行状态"面板显示 PID / 端口）
export function serverInfo(): { pid: number | null; baseUrl: string; port: number | null } {
  const pid = child && child.exitCode === null ? (child.pid ?? null) : null;
  let port: number | null = null;
  const m = /:(\d+)\//.exec(baseUrl);
  if (m) { port = Number(m[1]); }
  return { pid, baseUrl, port };
}

export function stopServer(): void {
  const proc = child;
  child = null;
  baseUrl = "";
  if (!proc || proc.exitCode !== null) {
    return;
  }
  try {
    proc.kill();
  } catch {
    // best effort
  }
}
