import { useEffect, useRef, useState, type JSX } from "react";
import { Icon } from "./Icons";
import { Markdown } from "../lib/markdown";

export interface BtwSeed {
  id: string;
  question: string;
  quote: string;
  history: { role: "user" | "assistant"; content: string }[];
  cardBase: number;
}

interface BtwTurn {
  role: "user" | "assistant";
  text: string;
  quote?: string;
  streaming?: boolean;
  error?: string;
  setup?: boolean;
  // 当前正在跑的工具名（顺便问窗口只展示一行状态，不做完整工具面板）
  tools?: string[];
}

interface Props {
  seed: BtwSeed;
  docId: string;
  docTitle: string;
  aiReady: boolean;
  onClose: () => void;
  onCite: (docId: string, page: number, quote?: string) => void;
  onCard?: (n: number) => void;
  onOpenSettings: () => void;
}

// 「顺便问一下」：独立小窗，不写入主对话。带上主对话最近的内容作为只读背景，
// 回答里的引用仍然可点击跳回 PDF。
export default function BtwPanel({
  seed, docId, docTitle, aiReady, onClose, onCite, onCard, onOpenSettings
}: Props): JSX.Element {
  const [turns, setTurns] = useState<BtwTurn[]>([]);
  const [input, setInput] = useState(seed.question);
  const [quote, setQuote] = useState(seed.quote);
  const [sending, setSending] = useState(false);
  const turnRef = useRef("");
  const turnsRef = useRef<BtwTurn[]>([]);
  turnsRef.current = turns;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) { el.scrollTop = el.scrollHeight; }
  }, [turns]);

  // 输入框随内容长高（与主输入框一致）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) { return; }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) { return; }
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function cancel(): void {
    if (turnRef.current) { void window.api.agentCancel(turnRef.current); }
  }

  function close(): void {
    cancel();
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") { return; }
      // 设置等模态框 / 图片灯箱在上层时，Esc 先关它
      if (document.querySelector(".modal-root") || document.querySelector(".img-lightbox")) { return; }
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窗口被卸载（切文献 / 关面板）时取消还在跑的请求，别让它在后台空转
  useEffect(() => () => { if (turnRef.current) { void window.api.agentCancel(turnRef.current); } }, []);

  useEffect(() => {
    const off = window.api.onAgentEvent((e) => {
      if (e.turnId !== turnRef.current) { return; }
      setTurns((prev) => {
        if (!prev.length) { return prev; }
        const next = prev.slice();
        const i = next.length - 1;
        const cur: BtwTurn = { ...next[i] };
        if (e.type === "delta" && e.text) { cur.text += e.text; }
        else if (e.type === "tool_call") { cur.tools = [...(cur.tools || []), e.name || ""]; }
        else if (e.type === "tool_result") {
          const tools = (cur.tools || []).slice();
          const at = tools.lastIndexOf(e.name || "");
          if (at >= 0) { tools.splice(at, 1); }
          cur.tools = tools;
        }
        else if (e.type === "confirmation") {
          // 小窗只适合问信息，不在这里做写操作（否则会一直等不到确认）
          void window.api.agentConfirm(e.confirmId || "", { approved: false });
          cur.text += "\n\n（「顺便问」窗口只用于补充信息，修改操作已忽略；需要修改请在主对话里进行。）";
        }
        else if (e.type === "error") { cur.error = e.error || "出错了"; cur.streaming = false; cur.tools = []; }
        else if (e.type === "done") { cur.streaming = false; cur.tools = []; }
        next[i] = cur;
        return next;
      });
      if (e.type === "done" || e.type === "error") { setSending(false); }
    });
    return off;
  }, []);

  function send(preset?: string): void {
    const q = (preset !== undefined ? preset : input).trim();
    if (!q || sending) { return; }
    const ctx = quote.trim();
    const shownQuote = ctx || undefined;
    const head = "【顺便问（btw）】这是主对话之外的补充小问题，不会保存到主对话。请结合上面的对话与当前文献简要回答；不要做外部检索，也不要执行修改操作。";
    const asked = ctx
      ? `${head}\n\n【用户选中的内容】\n“${ctx.slice(0, 4000)}”\n\n${q}`
      : `${head}\n\n${q}`;
    if (!aiReady) {
      setInput("");
      setTurns((prev) => [
        ...prev,
        { role: "user", text: q, quote: shownQuote },
        { role: "assistant", text: "", setup: true, error: "AI 助手还没配置对话模型：请在「设置 → AI 助手」里填写基础地址、API 密钥与模型。" }
      ]);
      return;
    }
    // 主对话（只读快照）+ 这个小窗里已经进行过的问答，一起作为背景
    const history = [
      ...seed.history,
      ...turnsRef.current
        .filter((t) => t.text.trim())
        .map((t) => ({ role: t.role, content: t.quote ? `【选中内容】${t.quote}\n\n${t.text}` : t.text }))
    ];
    setInput("");
    setQuote("");
    atBottomRef.current = true;
    setTurns((prev) => [...prev, { role: "user", text: q, quote: shownQuote }, { role: "assistant", text: "", streaming: true }]);
    setSending(true);
    const turnId = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    turnRef.current = turnId;
    void window.api.agentChat({
      turnId, scope: "library", docId, message: asked, history, cardBase: seed.cardBase
    }).catch((err) => {
      setSending(false);
      setTurns((prev) => {
        const next = prev.slice();
        const i = next.length - 1;
        next[i] = { ...next[i], streaming: false, error: String(err?.message || err) };
        return next;
      });
    });
  }

  function stop(): void {
    cancel();
    setSending(false);
    setTurns((prev) => {
      const next = prev.slice();
      const i = next.length - 1;
      if (next[i] && next[i].role === "assistant") { next[i] = { ...next[i], streaming: false, tools: [] }; }
      return next;
    });
  }

  // 从 `/btw 问题` 打开时直接发问；只带选中内容打开时把光标放进输入框
  useEffect(() => {
    if (seed.question.trim()) { send(seed.question); }
    else { inputRef.current?.focus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="btw-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) { close(); } }}>
      <div className="btw-panel" role="dialog" aria-label="顺便问一下">
        <div className="btw-head">
          <Icon name="message" small />
          <span className="btw-title">顺便问一下</span>
          <span className="btw-badge">不写入主对话</span>
          <span className="od-fill" />
          <button type="button" className="icon-btn" title="关闭" onClick={close}><Icon name="x" small /></button>
        </div>
        <div className="ai-scroll btw-scroll" ref={scrollRef} onScroll={onScroll}>
          {turns.length === 0 ? (
            <div className="btw-empty">
              <p>问一个小问题，不会打断或改动主对话。回答仍以《{docTitle}》为默认上下文。</p>
              <p>也可以选中主对话里的回答，再点「顺便问」。</p>
            </div>
          ) : null}
          {turns.map((t, i) => (
            <div key={i} className={"msg " + (t.role === "user" ? "msg-user" : "msg-assistant")}>
              <div className="msg-body">
                <div className="msg-role">{t.role === "user" ? "我" : "Arxiver"}</div>
                {t.role === "user" ? (
                  <>
                    {t.quote ? <div className="btw-quote-inline">“{t.quote}”</div> : null}
                    <div className="msg-content">{t.text}</div>
                  </>
                ) : (
                  <>
                    {t.text ? <div className="msg-content ai-md"><Markdown text={t.text} onCite={onCite} onCard={onCard} /></div> : null}
                    {t.error ? <div className="ai-error">{t.error}</div> : null}
                    {t.setup ? (
                      <div className="ai-setup">
                        <button type="button" className="btn btn-primary" onClick={onOpenSettings}><Icon name="settings" small /> 打开设置</button>
                      </div>
                    ) : null}
                    {t.tools && t.tools.length ? (
                      <div className="btw-running">
                        <span className="spinner" />
                        <span>正在读取 {t.tools[t.tools.length - 1]}…</span>
                      </div>
                    ) : null}
                    {t.streaming && !t.text ? <span className="typing"><i /><i /><i /></span> : null}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="btw-composer">
          {quote ? (
            <div className="btw-quote">
              <span className="btw-quote-text od-clamp-2">“{quote}”</span>
              <button type="button" className="ai-ref-x" title="移除引用" onClick={() => setQuote("")}><Icon name="x" small /></button>
            </div>
          ) : null}
          <form className="composer-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea
              ref={inputRef}
              rows={1}
              placeholder="顺便问问…（Enter 发送，Esc 关闭）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <div className="composer-row">
              <span className="btw-composer-hint">不保存到主对话</span>
              <span className="od-fill" />
              {sending
                ? <button type="button" className="send-btn" title="停止" onClick={(e) => { e.preventDefault(); stop(); }}><Icon name="x" small /></button>
                : <button type="submit" className="send-btn" aria-label="发送" disabled={!input.trim()}><Icon name="arrow-up" small /></button>}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
