import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch: unknown) => ipcRenderer.invoke("config:set", patch),
  appInfo: () => ipcRenderer.invoke("app:info"),

  pickFile: () => ipcRenderer.invoke("source:pick"),
  loadSource: (payload: unknown) => ipcRenderer.invoke("source:load", payload),
  startJob: (payload: unknown) => ipcRenderer.invoke("job:start", payload),
  listJobs: () => ipcRenderer.invoke("job:list"),
  getJob: (id: string) => ipcRenderer.invoke("job:get", id),
  cancelJob: (id: string) => ipcRenderer.invoke("job:cancel", id),
  removeJob: (id: string) => ipcRenderer.invoke("job:remove", id),
  getBlocks: (id: string) => ipcRenderer.invoke("job:blocks", id),
  getResult: (id: string, variant?: string) => ipcRenderer.invoke("job:result", id, variant),
  getPartial: (id: string, variant?: string) => ipcRenderer.invoke("job:partial", id, variant),
  saveResult: (id: string, variant?: string) => ipcRenderer.invoke("job:saveAs", id, variant),

  readTranslation: (id: string, cacheKey: string, variant?: string) => ipcRenderer.invoke("library:result", id, cacheKey, variant),
  readBlocks: (id: string, cacheKey: string) => ipcRenderer.invoke("library:blocks", id, cacheKey),
  listStorage: () => ipcRenderer.invoke("storage:list"),

  libraryState: () => ipcRenderer.invoke("library:state"),
  libraryAdd: (payload: unknown) => ipcRenderer.invoke("library:add", payload),
  libraryAddManual: (payload: unknown) => ipcRenderer.invoke("library:addManual", payload),
  libraryUpdate: (id: string, patch: unknown) => ipcRenderer.invoke("library:update", id, patch),
  librarySetTrash: (id: string, trashed: boolean) => ipcRenderer.invoke("library:setTrash", id, trashed),
  libraryPurge: (id: string) => ipcRenderer.invoke("library:purge", id),
  libraryEmptyTrash: () => ipcRenderer.invoke("library:emptyTrash"),
  libraryAddCollection: (name: string, parent?: string | null) => ipcRenderer.invoke("library:addCollection", name, parent ?? null),
  libraryRemoveCollection: (id: string) => ipcRenderer.invoke("library:removeCollection", id),
  libraryRecordOpen: (id: string) => ipcRenderer.invoke("library:recordOpen", id),
  libraryOpen: (id: string) => ipcRenderer.invoke("library:open", id),
  libraryReveal: (id: string) => ipcRenderer.invoke("library:reveal", id),
  libraryAddTranslation: (id: string, ref: unknown) => ipcRenderer.invoke("library:addTranslation", id, ref),
  libraryRemoveTranslation: (id: string, key: string) => ipcRenderer.invoke("library:removeTranslation", id, key),

  openPath: (target: string) => ipcRenderer.invoke("shell:open", target),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  onWindowMaximized: (cb: (value: boolean) => void) => subscribe("window:maximized", cb as (p: unknown) => void),

  agentChat: (payload: unknown) => ipcRenderer.invoke("agent:chat", payload),
  agentCancel: (turnId: string) => ipcRenderer.invoke("agent:cancel", turnId),
  agentConfirm: (confirmId: string, decision: unknown) => ipcRenderer.invoke("agent:confirm", confirmId, decision),
  agentConversations: (filter: unknown) => ipcRenderer.invoke("agent:conversations", filter),
  agentConversation: (id: string) => ipcRenderer.invoke("agent:conversation", id),
  agentSaveConversation: (conv: unknown) => ipcRenderer.invoke("agent:conversationSave", conv),
  agentDeleteConversation: (id: string) => ipcRenderer.invoke("agent:conversationDelete", id),

  getUpdateStatus: () => ipcRenderer.invoke("update:status"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (cb: (payload: unknown) => void) => subscribe("update:status", cb),

  onJobUpdate: (cb: (payload: unknown) => void) => subscribe("job:update", cb),
  onJobPartial: (cb: (payload: unknown) => void) => subscribe("job:partial", cb),
  onJobBlocks: (cb: (payload: unknown) => void) => subscribe("job:blocks", cb),
  onAgentEvent: (cb: (payload: unknown) => void) => subscribe("agent:event", cb)
};

contextBridge.exposeInMainWorld("api", api);
