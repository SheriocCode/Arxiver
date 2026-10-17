export interface AppConfig {
  translate_mode: "local" | "remote";
  service: string;
  translate_base_url: string;
  translate_api_key: string;
  translate_model: string;
  local_model: string;
  local_gpu_layers: number;
  local_extra_args: string;
  chat_base_url: string;
  chat_api_key: string;
  chat_model: string;
  search_enabled: boolean;
  search_provider: "tavily" | "bocha" | "deepseek";
  search_key_tavily: string;
  search_key_bocha: string;
  search_key_deepseek: string;
  search_scope: "academic" | "web";
  source_lang: string;
  target_lang: string;
  output_variant: string;
  threads: number;
  use_babeldoc: boolean;
  skip_subset_fonts: boolean;
  extra_args: string;
  prompt: string;
  timeout: number;
}

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

export interface SourcePayload {
  docId?: string;
  sourceBytes?: Uint8Array;
  filePath?: string;
  url?: string;
  name?: string;
  sourceUrl?: string;
  title?: string;
  params?: Partial<TransParams>;
}

export interface LoadedSource {
  bytes: Uint8Array;
  name: string;
  sourceUrl: string;
}

export interface JobSummary {
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
  // 片段里引用到的公式占位符 {vN} → 引擎抽出的公式文本（抽不出就没有这个键）
  vars?: Record<string, string>;
}

export interface OutlineItem {
  level: number;
  title: string;
  page: number;
  // vertical position within the page (0 = top); generated outlines set this so
  // headings sharing a page stay distinguishable
  anchor?: number;
}

export interface DocOutline {
  source: "bookmarks" | "heuristic" | "none" | "error";
  items: OutlineItem[];
}

export interface AgentChatRequest {
  // 由渲染端生成并先于请求设定：这样"零延迟报错"（如未配置模型）的事件不会赶在 turnId 之前到达而被丢掉
  turnId?: string;
  scope: "paper" | "library";
  docId?: string;
  selection?: { text: string; page: number };
  refs?: string[];
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
  // 该对话里已经出现过的检索卡片数：让 [[card:N]] 的编号在整个对话里保持稳定
  cardBase?: number;
}

// 外部文献检索结果（arXiv / OpenAlex），既喂给模型也渲染成卡片
export interface PaperHit {
  key: string;
  idx?: number; // 本轮对话里卡片的全局编号（1 起），模型用 [[card:N]] 引用
  source: string;
  title: string;
  authors: string;
  year: string;
  date: string;
  venue: string;
  url: string;
  pdfUrl: string;
  arxivId: string;
  doi: string;
  citations: number;
  abstract: string;
}

// 一次"读正文"（fetch_url）的元信息，用来在对话里显示"已读了什么"
export interface PageRead {
  url: string;
  title: string;
  domain: string;
  chars: number;
  via: string;
}

// 运行信息（设置 → 日志 → 系统运行日志 顶部的实时面板）：任务管理器只按 exe 描述显示进程名，
// 这里给出"是什么 + PID + 内存/CPU"，方便对照。
export interface AppProcessInfo {
  pid: number;
  kind: string; // 中文说明，如「界面渲染」「GPU 进程（绘制/解码）」
  type: string; // Electron 原始类型：Browser / Tab / GPU / Utility …
  serviceName?: string;
  rssMB: number; // 工作集（驻留内存）—— 对应任务管理器「详细信息 → 工作集(内存)」
  commitMB: number; // 提交大小 —— 对应任务管理器「详细信息 → 提交大小」
  peakMB: number; // 峰值工作集
  cpuPercent: number;
  isMain: boolean;
}

export interface AppMetrics {
  version: string;
  dev: boolean;
  uptimeSec: number;
  userData: string;
  logFile: string;
  totalRssMB: number;
  totalCommitMB: number;
  procs: AppProcessInfo[];
  // 主进程的子进程（翻译引擎 Python / 本地模型服务），Electron 的进程表里看不到，单独列
  children: AppChildProc[];
  jobs: AppJobInfo[];
}

export interface AppChildProc {
  pid: number;
  kind: string; // 「翻译引擎」「本地模型服务」…
  name: string; // python.exe / llama-server.exe
  memMB: number | null; // 由系统计数读取；非 Windows 或读不到给 null
  detail?: string; // 端口 / 正在翻译的文件名
}

export interface AppJobInfo {
  id: string;
  name: string;
  status: string; // queued / running / done / error / cancelled
  pages: number;
  donePages: number;
  message: string;
}

export interface AgentEvent {
  turnId: string;
  type: "delta" | "reasoning" | "tool_call" | "tool_result" | "progress" | "confirmation" | "library_changed" | "papers" | "read" | "usage" | "done" | "error";
  text?: string;
  name?: string;
  args?: string;
  content?: string;
  confirmId?: string;
  papers?: PaperHit[];
  read?: PageRead;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ConvTool { name: string; args?: string; content?: string; ms?: number; at?: number; progress?: string }
// 一轮回答里按**到达顺序**排布的内容块（文本 / 工具 / 检索卡片），
// 这样界面可以按时间顺序还原"先检索、后作答"的过程，而不是固定把卡片堆在最后。
export type ConvBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tools"; items: ConvTool[] }
  | { kind: "papers"; items: PaperHit[] }
  | { kind: "read"; items: PageRead[] };

export interface ConvMessage {
  role: "user" | "assistant";
  text: string;
  blocks?: ConvBlock[];
  tools?: ConvTool[];
  papers?: PaperHit[];
  reasoning?: string;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
export type UpdateState = "unsupported" | "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";
export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  error?: string;
  /** 该版本的更新日志（来自 latest.yml 的 releaseNotes） */
  notes?: string;
}

export interface Conversation {
  id: string;
  scope: "paper" | "library";
  docId?: string;
  docIds?: string[];
  title: string;
  updated_at: number;
  messages: ConvMessage[];
}
export interface ConversationSummary {
  id: string;
  scope: "paper" | "library";
  docId?: string;
  docIds: string[];
  title: string;
  updated_at: number;
  count: number;
}

export interface StorageEntry {
  id: string;
  name: string;
  source_name: string;
  source_url: string;
  service: string;
  source_lang: string;
  target_lang: string;
  output_variant: string;
  pages: string;
  size: number;
  created_at: number;
  variants?: Partial<Record<"dual" | "mono", number>>;
}

/** 翻译日志一条：已完成（来自文库译文）或进行中/失败（来自引擎任务） */
export interface TranslationLogEntry {
  id: string;
  docId: string;
  cacheKey: string;
  name: string;
  sourceName: string;
  sourceUrl: string;
  targetLang: string;
  service: string;
  variant: string;
  pages: string;
  size: number;
  status: "done" | "running" | "queued" | "failed";
  message: string;
  created_at: number;
  finished_at: number | null;
  donePages: number;
  totalPages: number;
  progress: number | null;
}

export type LogLevel = "info" | "warn" | "error";

/** 系统运行日志一条 */
export interface SystemLogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface SystemLogSnapshot {
  entries: SystemLogEntry[];
  /** 日志文件路径（可在资源管理器中打开） */
  file: string;
}

/** 按标识符（arXiv / DOI）取回的元信息 */
export interface ResolvedMeta {
  kind: "arxiv" | "doi";
  id: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi: string;
  abstract: string;
  pdfUrl: string;
  pageUrl: string;
}

export interface ItemNote {
  id: string;
  text: string;
  date: string;
}

export interface TranslationRef {
  cacheKey: string;
  target_lang: string;
  service: string;
  model: string;
  output_variant: string;
  pages: string;
  created_at: number;
  name: string;
}

export interface LibraryDoc {
  id: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  doi: string;
  type: string;
  abstract: string;
  summary: string;
  tags: string[];
  collections: string[];
  read: boolean;
  starred: boolean;
  notes: ItemNote[];
  sourceUrl: string;
  sourceName: string;
  files: { source: string | null };
  translations: TranslationRef[];
  added_at: number;
  modified_at: number;
  trash: boolean;
  trashedAt: number | null;
}

export interface LibraryCollection {
  id: string;
  name: string;
  parent: string | null;
}

export interface ReadingRecord {
  itemId: string;
  at: number;
}

export interface LibraryState {
  documents: LibraryDoc[];
  collections: LibraryCollection[];
  history: ReadingRecord[];
  // tag name -> palette key (see renderer state/tagColors.ts); absent = no color
  tag_colors: Record<string, string>;
  /** 用户显式新建的标签（可能暂时没有文献） */
  tag_names: string[];
}

export interface AppInfo {
  version: string;
  engineVersion: string;
  platform: string;
  userData: string;
  engineDir: string;
}

export interface LocalModelStatus {
  available: boolean;
  reason: string;
}

export interface Api {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  appInfo(): Promise<AppInfo>;
  localStatus(): Promise<LocalModelStatus>;
  pickFile(): Promise<{ filePath: string; name: string } | null>;
  loadSource(payload: SourcePayload): Promise<LoadedSource>;
  startJob(payload: SourcePayload): Promise<JobSummary>;
  listJobs(): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobSummary | null>;
  cancelJob(id: string): Promise<boolean>;
  removeJob(id: string): Promise<boolean>;
  getBlocks(id: string): Promise<BlockEvent[]>;
  getResult(id: string, variant?: string): Promise<Uint8Array | null>;
  getPartial(id: string, variant?: string): Promise<Uint8Array | null>;
  readTranslation(id: string, cacheKey: string, variant?: string): Promise<Uint8Array | null>;
  readBlocks(id: string, cacheKey: string): Promise<BlockEvent[]>;
  docOutline(id: string): Promise<DocOutline>;
  saveResult(id: string, variant?: string): Promise<string | null>;
  listStorage(): Promise<{ entries: StorageEntry[]; total: number }>;
  logsTranslation(): Promise<TranslationLogEntry[]>;
  logsSystem(): Promise<SystemLogSnapshot>;
  appMetrics(opts?: { os?: boolean }): Promise<AppMetrics>;
  saveDiagnostics(): Promise<string | null>;
  libraryState(): Promise<LibraryState>;
  libraryAdd(payload: SourcePayload & { type?: string; collections?: string[] }): Promise<LibraryDoc>;
  libraryAddManual(payload: {
    title: string; authors?: string; year?: string; venue?: string; type?: string;
    tags?: string[]; collections?: string[]; summary?: string; abstract?: string;
  }): Promise<LibraryDoc>;
  libraryImportByIdentifier(input: string, collections: string[]): Promise<{ ok: boolean; doc?: LibraryDoc; error?: string }>;
  libraryEnrichMetadata(id: string): Promise<LibraryDoc | null>;
  libraryUpdate(id: string, patch: Partial<LibraryDoc>): Promise<LibraryDoc | null>;
  librarySetTrash(id: string, trashed: boolean): Promise<LibraryDoc | null>;
  libraryPurge(id: string): Promise<boolean>;
  libraryEmptyTrash(): Promise<number>;
  libraryAddCollection(name: string, parent?: string | null): Promise<LibraryCollection>;
  libraryRemoveCollection(id: string): Promise<boolean>;
  librarySetTagColor(tag: string, color: string): Promise<void>;
  libraryRenameTag(from: string, to: string): Promise<boolean>;
  libraryDeleteTag(name: string): Promise<boolean>;
  libraryAddTag(name: string): Promise<boolean>;
  libraryRenameCollection(id: string, name: string): Promise<boolean>;
  libraryMoveCollection(id: string, target: string | null, position: "before" | "after" | "inside"): Promise<boolean>;
  librarySetDocsCollection(ids: string[], collectionId: string | null): Promise<number>;
  libraryRecordOpen(id: string): Promise<void>;
  libraryOpen(id: string): Promise<{ bytes: Uint8Array | null; name: string; sourceUrl: string }>;
  libraryReveal(id: string): Promise<boolean>;
  libraryAddTranslation(id: string, ref: TranslationRef): Promise<LibraryDoc | null>;
  libraryRemoveTranslation(id: string, cacheKey: string): Promise<LibraryDoc | null>;
  backgroundPick(): Promise<{ name: string; source: string } | null>;
  backgroundClear(): Promise<boolean>;
  uiSettingsGet(): Promise<Record<string, unknown>>;
  uiSettingsGetSync(): Record<string, unknown>;
  uiSettingsSet(data: unknown): Promise<boolean>;
  openPath(target: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  hideWindow(): Promise<void>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowIsMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (value: boolean) => void): () => void;
  onJobUpdate(cb: (job: JobSummary) => void): () => void;
  onJobPartial(cb: (info: { id: string; done_pages: number; total_pages: number }) => void): () => void;
  onJobBlocks(cb: (info: { id: string; blocks: BlockEvent[] }) => void): () => void;
  agentChat(payload: AgentChatRequest): Promise<{ turnId: string }>;
  agentCancel(turnId: string): Promise<void>;
  agentConfirm(confirmId: string, decision: { approved: boolean; args?: string }): Promise<void>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  agentConversations(filter: { scope: "paper" | "library"; docId?: string }): Promise<ConversationSummary[]>;
  agentConversation(id: string): Promise<Conversation | null>;
  agentSaveConversation(conv: Conversation): Promise<void>;
  agentDeleteConversation(id: string): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}
