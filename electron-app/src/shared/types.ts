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
  scope: "paper" | "library";
  docId?: string;
  selection?: { text: string; page: number };
  refs?: string[];
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface AgentEvent {
  turnId: string;
  type: "delta" | "reasoning" | "tool_call" | "tool_result" | "confirmation" | "library_changed" | "usage" | "done" | "error";
  text?: string;
  name?: string;
  args?: string;
  content?: string;
  confirmId?: string;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ConvTool { name: string; args?: string; content?: string; ms?: number; at?: number }
export interface ConvMessage {
  role: "user" | "assistant";
  text: string;
  tools?: ConvTool[];
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
