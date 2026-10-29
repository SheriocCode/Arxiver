import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { AppConfig, OverleafDocEvent, OverleafEvent, OverleafFile, OverleafStatus } from "../../../shared/types";
import { overleafTarget } from "../../../shared/ai";
import { parseReplaceCommands, stripPendingCommandBlocks, type ReplaceCommand } from "../../../shared/overleaf-replace";
import { Icon } from "./Icons";
import { Markdown } from "../lib/markdown";
import OverleafEditBlock from "./OverleafEditBlock";

interface OverleafTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  error?: string;
  reasoning?: string;
  toolStatus?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface Props {
  /** 该区当前是否显示在界面上（用于 CSS） */
  onScreen: boolean;
  /** 嵌入式网页是否可见；打开设置/弹窗时临时隐藏，避免盖住模态框 */
  active: boolean;
  config: AppConfig | null;
  onOpenSettings: () => void;
}

function fmtChars(n: number): string {
  if (n < 1000) { return `${n} 字符`; }
  return `${(n / 1000).toFixed(1)}k 字符`;
}

function estimateTokens(n: number): number {
  return Math.ceil(n / 3);
}

// 与 chat-overleaf / 提取脚本保持一致：只把这几类文本文件加入上下文列表。
const TEXT_FILE = /\.(tex|bib|md|txt)$/i;

function clampChatWidth(width: number): number {
  const max = Math.max(320, Math.min(760, window.innerWidth - 560));
  return Math.round(Math.min(max, Math.max(300, width)));
}

/** 去掉 LaTeX 注释（% 到行尾，忽略 \%），注释里的中文不算正文中文。 */
function stripLatexComments(text: string): string {
  return String(text || "").split(/\r?\n/).map((line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "%" && line[i - 1] !== "\\") { return line.slice(0, i); }
    }
    return line;
  }).join("\n");
}

export default function OverleafView({ onScreen, active, config, onOpenSettings }: Props): JSX.Element {
  const [turns, setTurns] = useState<OverleafTurn[]>([]);
  const [input, setInput] = useState("");
  const [projectFiles, setProjectFiles] = useState<OverleafFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<OverleafFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState("");
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [commands, setCommands] = useState<Map<string, ReplaceCommand>>(new Map());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [pageStatus, setPageStatus] = useState<OverleafStatus>({
    url: "", title: "", loading: false, ready: false, canGoBack: false, canGoForward: false
  });
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("arxiver.overleafChatWidth"));
      return Number.isFinite(saved) && saved > 0 ? clampChatWidth(saved) : 390;
    } catch { return 390; }
  });
  const [chatCollapsed, setChatCollapsed] = useState(() => {
    try { return localStorage.getItem("arxiver.overleafChatCollapsed") === "1"; } catch { return false; }
  });
  const [urlDraft, setUrlDraft] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);

  const webRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef("");
  const turnsRef = useRef<OverleafTurn[]>([]);
  const processedTurnsRef = useRef(new Set<string>());
  const ignoredFilesRef = useRef(new Set<string>());
  const lastDocPathRef = useRef("");
  const projectFilesRef = useRef<OverleafFile[]>([]);
  const syncingRef = useRef(false);
  turnsRef.current = turns;
  projectFilesRef.current = projectFiles;
  syncingRef.current = syncing;

  const target = overleafTarget(config);
  const aiReady = !!(target.baseUrl && target.apiKey && target.model);
  const inProject = /\/project\/[A-Za-z0-9]+/.test(pageStatus.url);

  const selectedFiles = useMemo(
    () => projectFiles.filter((file) => selected.has(file.path)),
    [projectFiles, selected]
  );

  const contextFiles = selectedFiles;

  const contextChars = useMemo(
    () => contextFiles.reduce((sum, file) => sum + (file.content?.length || 0), 0),
    [contextFiles]
  );

  const cjkSupported = useMemo(() => {
    const pattern = /\\usepackage(?:\[[^\]]*\])?\{(?:ctex|xeCJK)\}|\\setCJKmainfont|\\usepackage\{fontspec\}/;
    return [current, ...projectFiles].some((file) => file?.content && pattern.test(file.content));
  }, [current, projectFiles]);

  const cjkWarningFor = (command: ReplaceCommand): string | undefined => {
    if (cjkSupported) { return undefined; }
    const text = String(command.replace || "") + (command.commandType === "replace" ? String(command.search || "") : "");
    if (!/[\u3400-\u9fff]/.test(stripLatexComments(text))) { return undefined; }
    return "修改块正文里包含中文。当前约定是正文默认只写英文（中文放在 % 注释里）；如果确实要写中文正文，请先把 Overleaf 编译器切到 XeLaTeX 并在导言区加入 ctex/xeCJK。";
  };

  // 把网页占位区的位置告诉主进程；WebContentsView 本身由主进程创建和定位。
  const reportBounds = useCallback(() => {
    const el = webRef.current;
    if (!el) { return; }
    const rect = el.getBoundingClientRect();
    const visible = active && rect.width > 0 && rect.height > 0 && rect.bottom > 0;
    void window.api.overleafSetBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible
    });
  }, [active]);

  // 先订阅状态，再创建网页视图；否则首屏的加载/就绪事件会漏掉。
  useEffect(() => {
    const off = window.api.onOverleafStatus((status) => setPageStatus(status));
    void window.api.overleafGetStatus().then((status) => setPageStatus(status)).catch(() => undefined);
    return off;
  }, []);

  useEffect(() => {
    try { localStorage.setItem("arxiver.overleafChatCollapsed", chatCollapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [chatCollapsed]);

  useEffect(() => {
    const onResize = (): void => setChatWidth((width) => clampChatWidth(width));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!urlFocused) { setUrlDraft(pageStatus.url); }
  }, [pageStatus.url, urlFocused]);

  const navigateToDraft = useCallback(async (): Promise<boolean> => {
    const target = urlDraft.trim();
    if (!target) { return false; }
    const result = await window.api.overleafNavigate(target);
    if (!result.ok) { setStatus(result.error || "无法打开网址"); return false; }
    setStatus("正在打开 " + target);
    setUrlDraft(target);
    return true;
  }, [urlDraft]);

  useEffect(() => {
    const el = webRef.current;
    if (!el) { return; }
    const observer = new ResizeObserver(() => reportBounds());
    observer.observe(el);
    window.addEventListener("resize", reportBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
    };
  }, [reportBounds]);

  useEffect(() => {
    reportBounds();
  }, [reportBounds, onScreen]);

  useEffect(() => () => {
    void window.api.overleafSetBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
  }, []);

  useEffect(() => {
    const off = window.api.onOverleafEvent((event: OverleafEvent) => {
      if (event.turnId !== turnRef.current) { return; }
      setTurns((prev) => {
        const next = prev.slice();
        const index = next.length - 1;
        if (index < 0 || next[index].role !== "assistant") { return prev; }
        const turn = { ...next[index] };
        if (event.type === "delta" && event.text) { turn.text += event.text; }
        else if (event.type === "reasoning" && event.text) { turn.reasoning = (turn.reasoning || "") + event.text; }
        else if (event.type === "tool") { turn.toolStatus = event.text || ""; }
        else if (event.type === "error") {
          turn.error = event.error || "请求失败";
          turn.streaming = false;
        } else if (event.type === "done") {
          turn.streaming = false;
        } else if (event.type === "usage" && event.usage) {
          turn.usage = event.usage;
        }
        next[index] = turn;
        return next;
      });
      if (event.type === "done" || event.type === "error") { setBusy(false); }
    });
    return () => {
      off();
      if (turnRef.current) { void window.api.overleafCancel(turnRef.current); }
    };
  }, []);

  // Overleaf 页面里的观察器会在文件切换/正文变化时发来快照；更新本地缓存，
  // 这样编辑后切换文件，AI 仍能读到最新内容，不需要重新同步 zip。
  useEffect(() => {
    const off = window.api.onOverleafDoc((doc: OverleafDocEvent) => {
      if (!doc || !doc.path || typeof doc.content !== "string") { return; }
      // 提取期间由提取脚本统一读取，忽略中间的半加载快照，避免把空内容写进列表。
      if (syncingRef.current) { return; }
      // 切到另一个文件时，允许它重新被加入列表；同一文件连续编辑则尊重“从列表移除”。
      if (lastDocPathRef.current !== doc.path) {
        ignoredFilesRef.current.delete(doc.path);
        lastDocPathRef.current = doc.path;
      }
      const file: OverleafFile = { path: doc.path, content: doc.content, size: doc.content.length };
      setCurrent(file);
      const exists = projectFilesRef.current.some((item) => item.path === doc.path);
      if (exists) {
        setProjectFiles((prev) => prev.map((item) => (
          item.path === doc.path ? { ...item, content: doc.content, size: doc.content.length } : item
        )));
      } else if (TEXT_FILE.test(doc.path) && !ignoredFilesRef.current.has(doc.path)) {
        // 用户手动打开/编辑器里的文件自动加入列表并选中；PDF、图片等不会进来。
        setProjectFiles((prev) => [...prev, file]);
        setSelected((prev) => {
          const next = new Set(prev);
          next.add(doc.path);
          return next;
        });
      }
    });
    return off;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; }
  }, [turns]);

  // 流式结束后再解析编辑块，避免半截指令反复解析。
  useEffect(() => {
    setCommands((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const turn of turns) {
        if (turn.role !== "assistant" || turn.streaming || !turn.text) { continue; }
        if (processedTurnsRef.current.has(turn.id)) { continue; }
        processedTurnsRef.current.add(turn.id);
        const parsed = parseReplaceCommands(turn.text);
        for (const command of parsed.commands) {
          // 解析出的 ID 基于文件+内容，跨轮次会重复；必须按轮次隔离，
          // 否则新一轮里相同的修改块会继承上一轮的“已应用/已拒绝”状态。
          const id = `${turn.id}:${command.id}`;
          if (!next.has(id)) {
            next.set(id, { ...command, id });
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [turns]);

  const updateCommand = useCallback((id: string, patch: Partial<ReplaceCommand>) => {
    setCommands((prev) => {
      const current = prev.get(id);
      if (!current) { return prev; }
      const next = new Map(prev);
      next.set(id, { ...current, ...patch });
      return next;
    });
  }, []);

  const fileContentFor = useCallback((path: string): string | undefined => {
    const normalize = (value: string): string => String(value || "").replace(/^\/+|\/+$/g, "").trim();
    const target = normalize(path);
    if (current && normalize(current.path) === target) { return current.content; }
    const direct = projectFiles.find((file) => normalize(file.path) === target);
    if (direct) { return direct.content; }
    return projectFiles.find((file) => normalize(file.path).endsWith("/" + target) || target.endsWith("/" + normalize(file.path)))?.content;
  }, [current, projectFiles]);

  const startChatResize = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 0) { return; }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidth;
    let width = startWidth;
    const onMove = (move: MouseEvent): void => {
      width = clampChatWidth(startWidth + startX - move.clientX);
      setChatWidth(width);
    };
    const onUp = (): void => {
      document.body.classList.remove("ov-chat-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try { localStorage.setItem("arxiver.overleafChatWidth", String(width)); } catch { /* ignore */ }
    };
    document.body.classList.add("ov-chat-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [chatWidth]);

  const readCurrent = useCallback(async (silent = false): Promise<{ file: OverleafFile; selection: string } | null> => {
    if (!silent) { setStatus("正在读取当前编辑器…"); }
    const result = await window.api.overleafReadCurrent();
    if (!result.ok || result.content === undefined) {
      if (!silent) { setStatus(result.error || "读取当前文件失败"); }
      return null;
    }
    const file: OverleafFile = {
      path: result.fileName || "当前文件.tex",
      content: result.content,
      size: result.content.length
    };
    ignoredFilesRef.current.delete(file.path);
    setCurrent(file);
    const exists = projectFilesRef.current.some((item) => item.path === file.path);
    if (exists) {
      setProjectFiles((prev) => prev.map((item) => (
        item.path === file.path ? { ...item, content: file.content, size: file.content.length } : item
      )));
    } else if (TEXT_FILE.test(file.path)) {
      setProjectFiles((prev) => [...prev, file]);
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(file.path);
        return next;
      });
    }
    if (!silent) { setStatus(`已读取 ${file.path}（${fmtChars(file.content.length)}）`); }
    return { file, selection: result.selection || "" };
  }, []);

  const syncProject = useCallback(async () => {
    setSyncing(true);
    setStatus("正在逐个读取项目文件…（会短暂切换文件）");
    try {
      const result = await window.api.overleafSyncProject();
      if (!result.ok) {
        setStatus(result.error || "提取失败");
        return;
      }
      ignoredFilesRef.current.clear();
      setProjectFiles(result.files);
      const auto = result.files.filter((file) => /\.(tex|bib)$/i.test(file.path));
      setSelected(new Set((auto.length ? auto : result.files).map((file) => file.path)));
      setSyncedAt(result.syncedAt || Date.now());
      const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个` : "";
      setStatus(skipped ? `提取完成${skipped}` : "");
      await readCurrent(true);
    } catch (error) {
      setStatus("提取失败：" + ((error as Error)?.message || String(error)));
    } finally {
      setSyncing(false);
    }
  }, [readCurrent]);

  const toggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) { next.delete(path); } else { next.add(path); }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(projectFiles.map((file) => file.path)));
  }, [projectFiles]);

  const selectNone = useCallback(() => setSelected(new Set()), []);

  const removeFile = useCallback((path: string) => {
    ignoredFilesRef.current.add(path);
    setProjectFiles((prev) => prev.filter((file) => file.path !== path));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const removeFromSession = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const clearSession = useCallback(() => {
    setSelected(new Set());
  }, []);

  const applyEdit = useCallback(async (command: ReplaceCommand) => {
    setApplyingId(command.id);
    setStatus(`正在应用 ${command.file}…`);
    try {
      const result = await window.api.overleafApplyEdit(command);
      if (!result.ok) {
        updateCommand(command.id, { status: "pending", errorMessage: result.error || "应用失败" });
        setStatus(result.error || "应用失败");
        return;
      }
      updateCommand(command.id, { status: "applied", errorMessage: undefined });
      setStatus(`已应用 ${command.file}${result.replaced && result.replaced > 1 ? `（${result.replaced} 处）` : ""}`);
      // 写入后立即刷新当前文件；页面观察器随后还会继续同步协作者的改动。
      await readCurrent(true);
    } catch (error) {
      updateCommand(command.id, { status: "pending", errorMessage: (error as Error)?.message || String(error) });
      setStatus("应用失败");
    } finally {
      setApplyingId(null);
    }
  }, [readCurrent, updateCommand]);

  const rejectEdit = useCallback((command: ReplaceCommand) => {
    updateCommand(command.id, { status: "rejected", errorMessage: undefined });
  }, [updateCommand]);

  const undoEdit = useCallback(async (command: ReplaceCommand) => {
    if (command.status === "rejected") {
      updateCommand(command.id, { status: "pending", errorMessage: undefined });
      return;
    }
    setApplyingId(command.id);
    setStatus(`正在撤销 ${command.file}…`);
    try {
      const result = await window.api.overleafUndoEdit(command);
      if (!result.ok) {
        updateCommand(command.id, { errorMessage: result.error || "撤销失败" });
        setStatus(result.error || "撤销失败");
        return;
      }
      updateCommand(command.id, { status: "pending", errorMessage: undefined });
      setStatus(`已撤销 ${command.file}，修改块恢复为候选`);
      await readCurrent(true);
    } catch (error) {
      updateCommand(command.id, { errorMessage: (error as Error)?.message || String(error) });
      setStatus("撤销失败");
    } finally {
      setApplyingId(null);
    }
  }, [readCurrent, updateCommand]);

  const previewEdit = useCallback(async (command: ReplaceCommand) => {
    setStatus(`正在定位 ${command.file}…`);
    try {
      const result = await window.api.overleafPreviewEdit(command);
      if (!result.ok) {
        setStatus(result.error || "定位失败");
        return;
      }
      setStatus(`已定位到 ${command.file}${result.replaced && result.replaced > 1 ? `（${result.replaced} 处）` : ""}`);
    } catch (error) {
      setStatus("定位失败：" + ((error as Error)?.message || String(error)));
    }
  }, []);

  const stop = useCallback(() => {
    if (turnRef.current) { void window.api.overleafCancel(turnRef.current); }
    setBusy(false);
    setTurns((prev) => {
      const next = prev.slice();
      const index = next.length - 1;
      if (index >= 0 && next[index].role === "assistant") {
        next[index] = { ...next[index], streaming: false };
      }
      return next;
    });
  }, []);

  const send = useCallback(async (preset?: string) => {
    const question = (preset !== undefined ? preset : input).trim();
    if (!question || busy) { return; }

    if (!aiReady) {
      const stamp = Date.now().toString(36);
      setTurns((prev) => [
        ...prev,
        { id: "u" + stamp, role: "user", text: question },
        { id: "a" + stamp, role: "assistant", text: "", error: "AI 助手尚未配置：请在「设置 → AI 服务」里选择连接并填写模型。" }
      ]);
      setInput("");
      return;
    }

    // 发送前静默刷新当前编辑器内容，避免 600ms 快照 debounce 导致最后一两行没带上。
    let latest: OverleafFile | null = null;
    let latestSelection = "";
    const read = await window.api.overleafReadCurrent();
    if (read.ok && read.content !== undefined) {
      const path = read.fileName || "当前文件.tex";
      latest = { path, content: read.content, size: read.content.length };
      latestSelection = read.selection || "";
      setCurrent(latest);
      setProjectFiles((prev) => prev.map((item) => (
        item.path === path ? { ...item, content: read.content!, size: read.content!.length } : item
      )));
    }

    const files = new Map<string, OverleafFile>();
    for (const file of projectFiles) {
      if (selected.has(file.path) && file.content) { files.set(file.path, file); }
    }
    if (latest && selected.has(latest.path)) { files.set(latest.path, latest); }
    const includeSelection = latest && selected.has(latest.path) ? latestSelection : "";

    const history = turnsRef.current
      .filter((turn) => turn.text.trim() && !turn.error)
      .slice(-20)
      .map((turn) => ({ role: turn.role, content: turn.text }));

    const turnId = "ov" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stamp = Date.now().toString(36);
    turnRef.current = turnId;
    setInput("");
    setTurns((prev) => [
      ...prev,
      { id: "u" + stamp, role: "user", text: question },
      { id: "a" + stamp, role: "assistant", text: "", streaming: true }
    ]);
    setBusy(true);
    try {
      await window.api.overleafChat({
        turnId,
        message: question,
        files: [...files.values()],
        history,
        selection: includeSelection,
        currentFile: latest && selected.has(latest.path) ? latest.path : undefined
      });
    } catch (error) {
      setBusy(false);
      setTurns((prev) => {
        const next = prev.slice();
        const index = next.length - 1;
        if (index >= 0 && next[index].role === "assistant") {
          next[index] = { ...next[index], streaming: false, error: (error as Error)?.message || String(error) };
        }
        return next;
      });
    }
  }, [aiReady, busy, input, projectFiles, selected]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section className={"overleaf-page" + (onScreen ? " is-on" : "")} aria-label="Overleaf">
      <div className="ov-browserbar">
        <button type="button" className="icon-btn" title="登录 Overleaf" onClick={() => void window.api.overleafLogin()}>
          <Icon name="log-in" small />
        </button>
        <button type="button" className="icon-btn" title="打开 Overleaf 项目列表" onClick={() => void window.api.overleafHome()}>
          <Icon name="layout-dashboard" small />
        </button>
        <span className="ov-tools-sep" aria-hidden="true" />
        <button
          type="button"
          className="icon-btn"
          title="后退"
          disabled={!pageStatus.canGoBack}
          onClick={() => void window.api.overleafBack()}
        >
          <Icon name="chev-left" small />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="前进"
          disabled={!pageStatus.canGoForward}
          onClick={() => void window.api.overleafForward()}
        >
          <Icon name="chev-right" small />
        </button>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void window.api.overleafReload()}>
          <Icon name="rotate-right" small />
        </button>
        <div className={"ov-address" + (!pageStatus.ready ? " is-loading" : "")} title={pageStatus.url || undefined}>
          {!pageStatus.ready ? (
            <span className="ov-spinner" aria-hidden="true" />
          ) : (
            <Icon name="overleaf-mark" small />
          )}
          <input
            className="ov-url-input"
            value={urlDraft}
            placeholder="输入 overleaf.com 网址"
            spellCheck={false}
            onChange={(event) => setUrlDraft(event.target.value)}
            onFocus={(event) => {
              setUrlFocused(true);
              setUrlDraft(pageStatus.url);
              event.currentTarget.select();
            }}
            onBlur={() => { setUrlFocused(false); setUrlDraft(pageStatus.url); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const input = event.currentTarget;
                void navigateToDraft().then((ok) => { if (ok) { input.blur(); } });
              } else if (event.key === "Escape") {
                setUrlDraft(pageStatus.url);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <button
          type="button"
          className="icon-btn"
          title="复制网址"
          disabled={!pageStatus.url}
          onClick={() => { if (pageStatus.url) { void navigator.clipboard.writeText(pageStatus.url); } }}
        >
          <Icon name="copy" small />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="在系统浏览器中打开"
          disabled={!pageStatus.url}
          onClick={() => { if (pageStatus.url) { void window.api.openExternal(pageStatus.url); } }}
        >
          <Icon name="external" small />
        </button>

        <span className="ov-tools-sep" aria-hidden="true" />
        <div className="ov-tools">
          <button
            type="button"
            className="icon-btn"
            title={chatCollapsed ? "展开 AI 面板" : "收起 AI 面板"}
            aria-pressed={!chatCollapsed}
            onClick={() => setChatCollapsed((value) => !value)}
          >
            <Icon name="panel-right" small />
          </button>
          <button type="button" className="icon-btn" title="AI 设置" onClick={onOpenSettings}><Icon name="settings" small /></button>
        </div>
      </div>

      {!aiReady && (
        <div className="ov-banner">
          <span>AI 助手还没有配置对话模型。</span>
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}><Icon name="settings" small /> 去设置</button>
        </div>
      )}

      <div className="ov-body">
        <div className="ov-web" ref={webRef}>
          <div className="ov-web-hint">
            {!pageStatus.ready || !pageStatus.url ? (
              <>
                <span className="ov-spinner ov-spinner-lg" aria-hidden="true" />
                <b>{pageStatus.url ? "正在加载 Overleaf…" : "正在连接 Overleaf…"}</b>
                <span>首次打开需要下载 Overleaf 的页面资源，之后会快很多。</span>
              </>
            ) : (
              <>
                <Icon name="leaf" />
                <b>Overleaf</b>
                <span>请使用邮箱密码登录。Google 登录在嵌入式窗口里不可用。</span>
                <span>登录后打开一个项目，右侧会自动收集打开过的文件，也可以一键提取全部文本。</span>
              </>
            )}
          </div>
        </div>

        {!chatCollapsed && (
          <>
            <div
              className="ov-chat-resize"
              role="separator"
              aria-orientation="vertical"
              title="拖动调整 AI 面板宽度"
              onMouseDown={startChatResize}
            />
            <aside className="ov-chat" style={{ width: chatWidth }} aria-label="Arxiver X Overleaf">
              <div className="ov-chat-head">
                <div className="ov-brand">
                  <Icon name="arxiver" small />
                  <b>Arxiver</b>
                  <span className="ov-brand-x">X</span>
                  <Icon name="overleaf-mark" small />
                  <b>Overleaf</b>
                </div>
              </div>

          <div className="ov-context">
            <div className="ov-context-row">
              <button
                type="button"
                className="ov-context-toggle"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((open) => !open)}
                title={contextOpen ? "收起上下文面板" : "展开上下文面板"}
              >
                <Icon name={contextOpen ? "chev-down" : "chev-right"} small />
                <span>上下文</span>
              </button>
              <span className="ov-context-count">
                {contextFiles.length} 个文件 · 约 {estimateTokens(contextChars).toLocaleString()} tokens
              </span>
              <button
                type="button"
                className="icon-btn ov-extract-icon"
                onClick={() => void syncProject()}
                disabled={syncing || !onScreen}
                title={syncedAt
                  ? `重新提取项目文件（上次 ${new Date(syncedAt).toLocaleTimeString()}）`
                  : "提取项目文件：自动读取全部 tex/bib/md/txt"}
              >
                {syncing ? <span className="ov-spinner" /> : <Icon name="files" small />}
              </button>
            </div>

            {contextOpen ? (
              projectFiles.length > 0 ? (
                <div className="ov-files">
                  <div className="ov-files-head">
                    <span>已提取文件（{projectFiles.length}）</span>
                    <div className="ov-file-actions">
                      <button type="button" className="btn btn-ghost" onClick={selectAll}>全选</button>
                      <button type="button" className="btn btn-ghost" onClick={selectNone}>清空</button>
                    </div>
                  </div>
                  <div className="ov-file-list">
                    {projectFiles.map((file) => (
                      <label key={file.path} className="ov-file">
                        <input
                          type="checkbox"
                          checked={selected.has(file.path)}
                          onChange={() => toggleFile(file.path)}
                        />
                        <span className="ov-file-name" title={file.path}>{file.path}</span>
                        <span className="ov-file-size">≈{estimateTokens(file.content.length).toLocaleString()} token</span>
                        <button
                          type="button"
                          className="icon-btn ov-file-del"
                          title="从文件列表移除（不会删除 Overleaf 里的文件）"
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeFile(file.path); }}
                        >
                          <Icon name="x" small />
                        </button>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="ov-context-empty">还没有加入文件</div>
              )
            ) : null}
          </div>

          <div className="ai-scroll ov-msgs" ref={scrollRef}>
            {turns.length === 0 ? (
              <div className="ov-empty">
                <div className="ov-empty-title"><Icon name="sparkle" small /> 让 AI 参与写作</div>
                <p>打开文件会自动加入上下文，也可以一次读取整个项目。</p>
                {inProject ? (
                  <button
                    type="button"
                    className="btn btn-primary ov-empty-action"
                    onClick={() => void syncProject()}
                    disabled={syncing || !onScreen}
                  >
                    {syncing ? <span className="ov-spinner" /> : <Icon name="files" small />}
                    {syncing ? "正在读取…" : "读取项目文件"}
                  </button>
                ) : (
                  <div className="ov-empty-hint">先在上方打开一个 Overleaf 项目</div>
                )}
                <div className="ov-empty-foot">修改先确认再写入 · 正文英文，中文用 <code>%</code> 注释</div>
              </div>
            ) : null}

            {turns.map((turn) => {
              const parsed = turn.role === "assistant" && !turn.streaming && turn.text
                ? parseReplaceCommands(turn.text)
                : null;
              const cleanText = parsed
                ? parsed.cleanContent.replace(/\[\[REPLACE_BLOCK:[^\]]+\]\]/g, "").trim()
                : turn.role === "assistant" && turn.streaming
                  // 流式输出时先藏掉未完成的修改块，避免原始标记闪烁
                  ? stripPendingCommandBlocks(turn.text)
                  : turn.text;
              const turnCommands = parsed
                ? parsed.commands.map((command) => commands.get(`${turn.id}:${command.id}`) || command)
                : [];
              return (
                <div key={turn.id} className={"msg " + (turn.role === "user" ? "msg-user" : "msg-assistant")}>
                  <div className="msg-body">
                    <div className="msg-role">
                      {turn.role === "user" ? "我" : "Arxiver"}
                      {turn.role === "assistant" && cleanText ? (
                        <button
                          type="button"
                          className="icon-btn ov-copy"
                          title="复制回答"
                          onClick={() => void navigator.clipboard.writeText(cleanText)}
                        >
                          <Icon name="copy" small />
                        </button>
                      ) : null}
                    </div>
                    {turn.role === "user" ? (
                      <div className="msg-content">{turn.text}</div>
                    ) : (
                      <>
                        {turn.toolStatus ? (
                          <div className="ov-tool-status">
                            {turn.streaming && turn.toolStatus.startsWith("正在")
                              ? <span className="ov-spinner" />
                              : <Icon name="check" small />}
                            <span>{turn.toolStatus}</span>
                          </div>
                        ) : null}
                        {turn.reasoning ? (
                          <details className="ov-thinking">
                            <summary>思考过程</summary>
                            <pre>{turn.reasoning}</pre>
                          </details>
                        ) : null}
                        {cleanText ? (
                          <div className="msg-content ai-md">
                            <Markdown text={cleanText} onCite={() => undefined} />
                          </div>
                        ) : null}
                        {turnCommands.length > 0 ? (
                          <div className="ov-edits">
                            <div className="ov-edits-count">{turnCommands.length} 个修改建议</div>
                            {turnCommands.map((command) => (
                              <OverleafEditBlock
                                key={command.id}
                                command={command}
                                fileContent={fileContentFor(command.file)}
                                applying={applyingId === command.id}
                                cjkWarning={cjkWarningFor(command)}
                                onApply={(item) => void applyEdit(item)}
                                onReject={rejectEdit}
                                onUndo={(item) => void undoEdit(item)}
                                onPreview={(item) => void previewEdit(item)}
                              />
                            ))}
                          </div>
                        ) : null}
                        {turn.error ? <div className="ai-error">{turn.error}</div> : null}
                        {turn.streaming && !cleanText ? <span className="typing"><i /><i /><i /></span> : null}
                        {turn.usage ? (
                          <div className="ov-usage">
                            {turn.usage.prompt_tokens} prompt · {turn.usage.completion_tokens} completion
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {contextFiles.length > 0 ? (
            <div className="ov-session">
              <div className="ov-session-head">
                <span>已加入会话 {contextFiles.length} 个文件 · 约 {estimateTokens(contextChars).toLocaleString()} tokens</span>
                <button type="button" className="btn btn-ghost" onClick={clearSession}>清空</button>
              </div>
              <div className="ov-session-chips">
                {contextFiles.map((file) => (
                  <span className="ov-chip" key={file.path} title={file.path}>
                    <span className="ov-chip-name">{file.path}</span>
                    <button
                      type="button"
                      className="ov-chip-x"
                      title="从本次会话移除"
                      onClick={() => removeFromSession(file.path)}
                    >
                      <Icon name="x" small />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="ai-composer">
            <form
              className="composer-box"
              onSubmit={(event) => { event.preventDefault(); void send(); }}
            >
              <button
                type="button"
                className="ov-composer-model"
                title="当前模型，点击打开 AI 设置"
                onClick={onOpenSettings}
              >
                <Icon name="sparkle" small />
                <span>{target.model || "未配置模型"}</span>
              </button>
              <textarea
                rows={2}
                placeholder="问关于这篇论文的问题…（Enter 发送，Shift+Enter 换行）"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onKeyDown}
              />
              <div className="composer-row">
                <span className="ov-status" title={status}>{status || "修改需你确认后写入"}</span>
                <span className="od-fill" />
                {busy ? (
                  <button type="button" className="send-btn" title="停止" onClick={(event) => { event.preventDefault(); stop(); }}>
                    <Icon name="x" small />
                  </button>
                ) : (
                  <button type="submit" className="send-btn" aria-label="发送" disabled={!input.trim() || syncing}>
                    <Icon name="arrow-up" small />
                  </button>
                )}
              </div>
            </form>
          </div>
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
