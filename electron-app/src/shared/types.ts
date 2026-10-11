export interface AppConfig {
  service: string;
  openai_base_url: string;
  openai_api_key: string;
  openai_model: string;
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

export interface ConvTool { name: string; args?: string; content?: string }
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
}

export interface AppInfo {
  version: string;
  engineVersion: string;
  platform: string;
  userData: string;
  engineDir: string;
}

export interface Api {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  appInfo(): Promise<AppInfo>;
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
  saveResult(id: string, variant?: string): Promise<string | null>;
  listStorage(): Promise<{ entries: StorageEntry[]; total: number }>;
  libraryState(): Promise<LibraryState>;
  libraryAdd(payload: SourcePayload & { type?: string; collections?: string[] }): Promise<LibraryDoc>;
  libraryAddManual(payload: {
    title: string; authors?: string; year?: string; venue?: string; type?: string;
    tags?: string[]; collections?: string[]; summary?: string; abstract?: string;
  }): Promise<LibraryDoc>;
  libraryUpdate(id: string, patch: Partial<LibraryDoc>): Promise<LibraryDoc | null>;
  librarySetTrash(id: string, trashed: boolean): Promise<LibraryDoc | null>;
  libraryPurge(id: string): Promise<boolean>;
  libraryEmptyTrash(): Promise<number>;
  libraryAddCollection(name: string, parent?: string | null): Promise<LibraryCollection>;
  libraryRemoveCollection(id: string): Promise<boolean>;
  libraryRecordOpen(id: string): Promise<void>;
  libraryOpen(id: string): Promise<{ bytes: Uint8Array | null; name: string; sourceUrl: string }>;
  libraryReveal(id: string): Promise<boolean>;
  libraryAddTranslation(id: string, ref: TranslationRef): Promise<LibraryDoc | null>;
  libraryRemoveTranslation(id: string, cacheKey: string): Promise<LibraryDoc | null>;
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
