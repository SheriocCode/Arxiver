import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { pythonExe, runScript, engineDir, tmpJobsDir } from "./paths";
import * as storage from "./storage";
import * as localModel from "./localmodel";
import { LOCAL_MODEL_ALIAS } from "./localmodel";
import { get as getConfig } from "./config";

export interface TransParams {
  source_lang: string;
  target_lang: string;
  service: string;
  model: string;
  output_variant: string;
  pages: string;
  threads: number;
  use_babeldoc: boolean;
  skip_subset_fonts: boolean;
  ignore_cache?: boolean;
  formula_font_regex: string;
  prompt: string;
  extra_args: string;
}

export interface PublicJob {
  id: string;
  status: string;
  message: string;
  error: string | null;
  progress: number | null;
  done_pages: number;
  total_pages: number;
  current_page: number;
  page_done: number;
  page_total: number;
  block_page: number;
  block_index: number;
  block_total: number;
  log_tail: string;
  cache_key: string | null;
  cached: boolean;
  result_name: string;
  variants: string[];
  source_name: string;
  source_url: string;
  params: TransParams;
  created_at: number;
  finished_at: number | null;
}

export interface BlockEvent {
  page: number;
  index: number;
  total: number;
  bbox: number[];
  src: string;
  dst: string;
}

const CACHE_KEY_FIELDS = [
  "source_lang", "target_lang", "service", "model", "output_variant", "pages",
  "threads", "use_babeldoc", "skip_subset_fonts", "formula_font_regex",
  "prompt", "extra_args"
];

// HY-MT 推荐的翻译提示词模板（按目标语言选中文/英文版本），并明确要求保留
// babeldoc 注入的 {{vN}} 占位符（公式 / 富文本），否则译文公式会错乱。
const HYMT_ZH_NAMES: Record<string, string> = {
  en: "英语", "zh-CN": "中文", "zh-TW": "繁体中文", ja: "日语", ko: "韩语",
  fr: "法语", de: "德语", es: "西班牙语", ru: "俄语", pt: "葡萄牙语",
  it: "意大利语", ar: "阿拉伯语"
};
const HYMT_EN_NAMES: Record<string, string> = {
  en: "English", "zh-CN": "Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese",
  ko: "Korean", fr: "French", de: "German", es: "Spanish", ru: "Russian",
  pt: "Portuguese", it: "Italian", ar: "Arabic"
};

function hyMtPrompt(langIn: string, langOut: string): string {
  const isZh = (code: string): boolean => /^zh/i.test(code) || code === "yue";
  const useZh = isZh(langOut) || isZh(langIn);
  const guardZh = "原文中的 {{v0}}、{{v1}} 这类双花括号占位符表示公式或格式信息，必须原样保留，不要翻译或改动。";
  const guardEn = "Keep placeholders such as {{v0}} and {{v1}} (they mark formulas/formatting) exactly as-is — do not translate or alter them.";
  if (useZh) {
    const name = HYMT_ZH_NAMES[langOut] || "中文";
    return `将以下文本翻译为${name}，注意只需要输出翻译后的结果，不要额外解释。${guardZh}\n\n$text`;
  }
  const name = HYMT_EN_NAMES[langOut] || langOut;
  return `Translate the following segment into ${name}, without additional explanation. ${guardEn}\n\n$text`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROGRESS_RE = /(\d{1,3})%\|/;
const PARTIAL_RE = /ENGINE_PARTIAL\s+(\d+)\s+(\d+)/g;
const BLOCK_RE = /ENGINE_BLOCK\s+(\d+)\s+(\d+)\s+(\d+)/g;
const PAGE_START_RE = /ENGINE_PAGE_START\s+(\d+)/g;
const PAGE_PROG_RE = /ENGINE_PAGE_PROGRESS\s+(\d+)\s+(\d+)\s+(\d+)/g;

function cleanLog(text: string): string {
  return (text || "").replace(ANSI_RE, "").replace(/\r/g, "");
}

function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

export function cacheKey(sourceBytes: Buffer, params: TransParams): string {
  const digest = crypto.createHash("sha256");
  digest.update(sourceBytes || Buffer.alloc(0));
  digest.update(Buffer.from([0]));
  for (const field of CACHE_KEY_FIELDS) {
    const value = (params as unknown as Record<string, unknown>)[field];
    digest.update(Buffer.from(`${field}=${value === undefined ? "" : value}\x1f`, "utf8"));
  }
  return digest.digest("hex").slice(0, 32);
}

export function safeName(name: string): string {
  const base = path.basename(name || "source.pdf").replace(/\.pdf$/i, "") || "translated";
  return base.replace(/[\\/:*?"<>|]/g, "").trim() || "translated";
}

interface Job {
  id: string;
  docId: string;
  params: TransParams;
  sourceBytes: Buffer | null;
  filename: string;
  sourceUrl: string;
  workdir: string;
  status: string;
  message: string;
  error: string | null;
  progress: number | null;
  done_pages: number;
  total_pages: number;
  current_page: number;
  page_done: number;
  page_total: number;
  block_page: number;
  block_index: number;
  block_total: number;
  logTail: string;
  raw: string;
  cacheKey: string | null;
  cached: boolean;
  resultName: string;
  resultVariants: string[];
  proc: ChildProcess | null;
  cancelled: boolean;
  createdAt: number;
  finishedAt: number | null;
  emittedBlocks: Set<string>;
  emittedPages: Set<number>;
  timer: NodeJS.Timeout | null;
}

export class EngineManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running: string | null = null;

  create(params: TransParams, sourceBytes: Buffer, filename: string, sourceUrl: string, docId: string): PublicJob {
    const id = crypto.randomBytes(16).toString("hex");
    const workdir = path.join(tmpJobsDir(), id);
    fs.mkdirSync(path.join(workdir, "partials"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "events"), { recursive: true });
    const job: Job = {
      id, docId, params, sourceBytes, filename: filename || "source.pdf", sourceUrl: sourceUrl || "", workdir,
      status: "queued", message: "排队中", error: null, progress: null,
      done_pages: 0, total_pages: 0, current_page: 0, page_done: 0, page_total: 0,
      block_page: 0, block_index: 0, block_total: 0,
      logTail: "", raw: "", cacheKey: null, cached: false, resultName: "", resultVariants: [],
      proc: null, cancelled: false, createdAt: Date.now() / 1000, finishedAt: null,
      emittedBlocks: new Set(), emittedPages: new Set(), timer: null
    };
    job.resultName = this.buildResultName(job);
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emit("update", this.public(job));
    this.pump();
    return this.public(job);
  }

  private buildResultName(job: Job): string {
    const variant = job.params.output_variant || "dual";
    const lang = job.params.target_lang || "zh";
    return `${safeName(job.filename)}.${variant}.${lang}.pdf`;
  }

  private public(job: Job): PublicJob {
    return {
      id: job.id, status: job.status, message: job.message, error: job.error, progress: job.progress,
      done_pages: job.done_pages, total_pages: job.total_pages,
      current_page: job.current_page, page_done: job.page_done, page_total: job.page_total,
      block_page: job.block_page, block_index: job.block_index, block_total: job.block_total,
      log_tail: job.logTail.slice(-2000), cache_key: job.cacheKey, cached: job.cached,
      result_name: job.resultName, variants: job.resultVariants,
      source_name: job.filename, source_url: job.sourceUrl, params: job.params,
      created_at: job.createdAt, finished_at: job.finishedAt
    };
  }

  get(id: string): PublicJob | null {
    const job = this.jobs.get(id);
    return job ? this.public(job) : null;
  }

  list(): PublicJob[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.public(job));
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) {
      return;
    }
    const id = this.queue.shift()!;
    const job = this.jobs.get(id);
    if (!job || job.cancelled) {
      this.pump();
      return;
    }
    this.running = id;
    this.run(job)
      .catch((err) => this.fail(job, err?.message ? err.message : String(err)))
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }
    job.cancelled = true;
    if (this.queue.includes(id)) {
      this.queue = this.queue.filter((item) => item !== id);
      job.status = "cancelled";
      job.message = "已取消";
      job.finishedAt = Date.now() / 1000;
      this.emit("update", this.public(job));
    }
    if (job.proc && !job.proc.killed) {
      this.killTree(job.proc.pid);
    }
    return true;
  }

  private killTree(pid?: number): void {
    if (!pid) {
      return;
    }
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }
    if (job.proc) {
      this.killTree(job.proc.pid);
    }
    if (job.timer) {
      clearInterval(job.timer);
    }
    try {
      fs.rmSync(job.workdir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    this.jobs.delete(id);
    return true;
  }

  private fail(job: Job, message: string): void {
    job.status = "error";
    job.error = message;
    job.message = message;
    job.finishedAt = Date.now() / 1000;
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
    this.emit("update", this.public(job));
  }

  private buildArgs(job: Job): string[] {
    const p = job.params;
    const args = [
      path.join(job.workdir, "source.pdf"),
      "-li", String(p.source_lang),
      "-lo", String(p.target_lang),
      "-s", String(p.service),
      "-o", job.workdir
    ];
    if (p.pages) args.push("-p", String(p.pages));
    if (p.threads) args.push("-t", String(p.threads));
    if (p.formula_font_regex) args.push("-f", String(p.formula_font_regex));
    if (p.use_babeldoc) args.push("--babeldoc");
    if (p.skip_subset_fonts) args.push("--skip-subset-fonts");
    if (p.ignore_cache) args.push("--ignore-cache");
    if (p.prompt) {
      const promptFile = path.join(job.workdir, "prompt.txt");
      fs.writeFileSync(promptFile, String(p.prompt), "utf8");
      args.push("--prompt", promptFile);
    }
    if (p.extra_args) {
      args.push(...splitArgs(String(p.extra_args)));
    }
    args.push("--partial-dir", path.join(job.workdir, "partials"));
    args.push("--events-dir", path.join(job.workdir, "events"));
    return args;
  }

  private findVariants(workdir: string): Partial<Record<"dual" | "mono", string>> {
    const out: Partial<Record<"dual" | "mono", string>> = {};
    let files: string[] = [];
    try {
      files = fs.readdirSync(workdir);
    } catch {
      return out;
    }
    for (const name of files) {
      const lower = name.toLowerCase();
      if (!lower.endsWith(".pdf") || lower === "source.pdf") {
        continue;
      }
      if (lower.endsWith(".dual.pdf") || lower.endsWith("-dual.pdf")) {
        out.dual = path.join(workdir, name);
      } else if (lower.endsWith(".mono.pdf") || lower.endsWith("-mono.pdf")) {
        out.mono = path.join(workdir, name);
      }
    }
    return out;
  }

  private readBlocks(job: Job): BlockEvent[] {
    const file = path.join(job.workdir, "events", "engine-events.jsonl");
    const blocks: BlockEvent[] = [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return blocks;
    }
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      try {
        blocks.push(JSON.parse(text) as BlockEvent);
      } catch {
        // skip malformed line
      }
    }
    return blocks;
  }

  private processTail(job: Job): void {
    const tail = cleanLog(job.raw).slice(-64000);
    job.raw = tail;
    job.logTail = tail;

    let match = PROGRESS_RE.exec(tail);
    if (match) {
      job.progress = parseInt(match[1], 10);
    }

    PARTIAL_RE.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    while ((match = PARTIAL_RE.exec(tail)) !== null) {
      last = match;
    }
    if (last) {
      job.done_pages = parseInt(last[1], 10);
      job.total_pages = parseInt(last[2], 10);
      this.emit("partial", job.id, { done_pages: job.done_pages, total_pages: job.total_pages });
    }

    PAGE_START_RE.lastIndex = 0;
    while ((match = PAGE_START_RE.exec(tail)) !== null) {
      const page = parseInt(match[1], 10);
      if (!job.emittedPages.has(page)) {
        job.emittedPages.add(page);
        job.current_page = page;
        job.page_done = 0;
        job.page_total = 0;
      }
    }

    PAGE_PROG_RE.lastIndex = 0;
    while ((match = PAGE_PROG_RE.exec(tail)) !== null) {
      job.current_page = parseInt(match[1], 10);
      job.page_done = parseInt(match[2], 10);
      job.page_total = parseInt(match[3], 10);
    }

    BLOCK_RE.lastIndex = 0;
    let blockMatch: RegExpExecArray | null = null;
    while ((match = BLOCK_RE.exec(tail)) !== null) {
      blockMatch = match;
    }
    if (blockMatch) {
      const page = parseInt(blockMatch[1], 10);
      const index = parseInt(blockMatch[2], 10);
      const total = parseInt(blockMatch[3], 10);
      job.block_page = page;
      job.block_index = index;
      job.block_total = total;
      const token = `${page}:${total}`;
      if (total && index === total && !job.emittedBlocks.has(token)) {
        job.emittedBlocks.add(token);
        this.emit("blocks", job.id, this.readBlocks(job));
      }
    }

    this.emit("update", this.public(job));
  }

  private async run(job: Job): Promise<void> {
    const config = getConfig();
    const isLocal = config.translate_mode === "local";
    // 先解析有效的服务端信息（本地模式不在此启动服务，仅确定端名以便计算缓存键）。
    job.params.service = isLocal ? "openai" : (config.service || "openai");
    job.params.model = isLocal ? LOCAL_MODEL_ALIAS : config.translate_model;
    if (isLocal && !job.params.prompt) {
      job.params.prompt = hyMtPrompt(job.params.source_lang, job.params.target_lang);
    }

    const sourceBytes = job.sourceBytes || Buffer.alloc(0);
    job.cacheKey = cacheKey(sourceBytes, job.params);
    job.resultName = this.buildResultName(job);

    try {
      const variant = job.params.output_variant || "dual";
      if (!job.params.ignore_cache && storage.hasTranslation(job.docId, job.cacheKey, variant)) {
        job.status = "done";
        job.cached = true;
        job.message = "已命中本地缓存";
        job.progress = 100;
        job.resultVariants = ["dual", "mono"].filter((v) => storage.hasTranslation(job.docId, job.cacheKey!, v));
        job.finishedAt = Date.now() / 1000;
        this.emit("update", this.public(job));
        return;
      }

      fs.writeFileSync(path.join(job.workdir, "source.pdf"), sourceBytes);

      let baseUrl = String(config.translate_base_url || "");
      let apiKey = String(config.translate_api_key || "");
      let model = String(config.translate_model || "");
      if (isLocal) {
        try {
          const server = await localModel.ensureServer();
          baseUrl = server.baseUrl;
          apiKey = "local";
          model = server.model;
        } catch (err) {
          this.fail(job, (err as Error).message);
          return;
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8"
      };
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
      if (apiKey) env.OPENAI_API_KEY = apiKey;
      if (model) env.OPENAI_MODEL = model;

      const args = this.buildArgs(job);
      job.status = "running";
      job.message = "引擎已启动";
      this.emit("update", this.public(job));

      job.timer = setInterval(() => this.processTail(job), 400);

      const code = await new Promise<number>((resolve) => {
        const child = spawn(pythonExe(), [runScript(), ...args], {
          cwd: engineDir(),
          env,
          windowsHide: true
        });
        job.proc = child;

        const timeoutMs = (config.timeout || 3600) * 1000;
        const deadline = setTimeout(() => {
          job.cancelled = true;
          job.error = "引擎超时";
          this.killTree(child.pid);
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => { job.raw += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { job.raw += chunk.toString("utf8"); });
        child.on("error", (err) => {
          clearTimeout(deadline);
          this.fail(job, "无法启动引擎：" + err.message);
          resolve(-1);
        });
        child.on("close", (exit) => {
          clearTimeout(deadline);
          resolve(exit ?? -1);
        });
      });

      this.finish(job, code);
    } finally {
      this.cleanupWorkdir(job);
    }
  }

  private cleanupWorkdir(job: Job): void {
    try {
      fs.rmSync(job.workdir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  private finish(job: Job, code: number): void {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
    job.proc = null;
    this.processTail(job);
    if (job.status === "error") {
      return;
    }

    if (job.cancelled) {
      job.status = "cancelled";
      job.message = job.error || "已取消";
      job.finishedAt = Date.now() / 1000;
      this.emit("update", this.public(job));
      return;
    }
    if (code !== 0) {
      this.fail(job, `引擎退出，代码 ${code}`);
      return;
    }

    const variants = this.findVariants(job.workdir);
    const files: Partial<Record<"dual" | "mono", string>> = {};
    const found: string[] = [];
    for (const variant of ["dual", "mono"] as const) {
      if (variants[variant]) {
        files[variant] = variants[variant];
        found.push(variant);
      }
    }
    if (found.length === 0) {
      this.fail(job, "未生成译文 PDF");
      return;
    }

    try {
      storage.saveTranslation(job.docId, job.cacheKey!, files, path.join(job.workdir, "events", "engine-events.jsonl"));
    } catch (err) {
      job.error = "保存译文失败：" + (err as Error).message;
    }
    job.resultVariants = found;
    job.progress = 100;
    job.status = "done";
    job.message = "翻译完成";
    job.finishedAt = Date.now() / 1000;
    this.emit("blocks", job.id, this.readBlocks(job));
    this.emit("update", this.public(job));
  }

  readResult(id: string, variant?: string): Buffer | null {
    const job = this.jobs.get(id);
    if (!job || !job.cacheKey) {
      return null;
    }
    const wanted = variant || job.params.output_variant || "dual";
    return storage.readTranslation(job.docId, job.cacheKey, wanted);
  }

  readPartial(id: string, variant?: string): Buffer | null {
    const job = this.jobs.get(id);
    if (!job) {
      return null;
    }
    const name = "partial-" + (variant || job.params.output_variant || "dual") + ".pdf";
    const file = path.join(job.workdir, "partials", name);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  blocks(id: string): BlockEvent[] {
    const job = this.jobs.get(id);
    return job ? this.readBlocks(job) : [];
  }
}

export function clearTmpJobs(): void {
  const dir = tmpJobsDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  fs.mkdirSync(dir, { recursive: true });
}
