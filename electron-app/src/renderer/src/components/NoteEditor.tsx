import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Icon } from "./Icons";
import { Markdown } from "../lib/markdown";

// 笔记编辑器：侧栏内全屏 + 块级"即时渲染"。
// 正文按空行切块，每块先用 Markdown 渲染；点某一块就把它变成可编辑的文本框，
// 失焦后又渲染回去——比直接编辑 Markdown 源码直观，也不用引入富文本引擎
// （公式、表格、代码仍然按原样保存成 Markdown）。

function splitBlocks(md: string): string[] {
  const text = String(md || "").replace(/\r\n/g, "\n");
  if (!text.trim()) { return [""]; }
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; }
    if (!fence && !line.trim()) {
      if (cur.length) { out.push(cur.join("\n")); cur = []; }
      continue;
    }
    cur.push(line);
  }
  if (cur.length) { out.push(cur.join("\n")); }
  return out.length ? out : [""];
}

export default function NoteEditor({ initial, isNew, onSave, onCancel, onCite }: {
  initial: string;
  isNew: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onCite?: (docId: string, page: number, quote?: string) => void;
}): JSX.Element {
  const initialBlocks = useMemo(() => splitBlocks(initial), [initial]);
  const [blocks, setBlocks] = useState<string[]>(initialBlocks);
  const [active, setActive] = useState<number>(isNew ? 0 : -1);
  // 「继续写」要落到最后一块：等 blocks 更新完再按最终长度定位（失焦时可能刚拆过块）
  const [wantLast, setWantLast] = useState(false);
  const [mode, setMode] = useState<"live" | "source">("live");
  // 源码模式单独存一份原文，避免来回切模式把空行/缩进改写掉
  const [source, setSource] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const text = useMemo(
    () => (mode === "source" ? source : blocks.filter((b) => b.trim()).join("\n\n")),
    [mode, source, blocks]
  );

  // 编辑框跟着内容长高
  useEffect(() => {
    const el = areaRef.current;
    if (!el) { return; }
    el.style.height = "auto";
    el.style.height = Math.max(56, Math.min(el.scrollHeight, 460)) + "px";
  }, [active, blocks, mode]);

  useEffect(() => { if (active >= 0) { areaRef.current?.focus(); } }, [active]);

  const setBlock = (i: number, value: string): void => {
    setBlocks((prev) => {
      const next = prev.slice();
      next[i] = value;
      return next;
    });
  };

  useEffect(() => {
    if (!wantLast) { return; }
    setActive(blocks.length - 1);
    setWantLast(false);
    window.setTimeout(() => {
      const el = bodyRef.current;
      if (el) { el.scrollTop = el.scrollHeight; }
    }, 30);
  }, [wantLast, blocks.length]);

  const addBlock = (): void => {
    setBlocks((prev) => [...prev, ""]);
    setWantLast(true);
  };

  const save = (): void => {
    if (!text.trim()) { return; }
    onSave(text.trim());
  };

  return (
    <div className="note-focus">
      <header className="note-focus-head">
        <Icon name="note" small />
        <span className="note-focus-title">{isNew ? "新建笔记" : "编辑笔记"}</span>
        <span className="od-fill" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (mode === "live") { setSource(text); setActive(-1); setMode("source"); }
            else { setBlocks(splitBlocks(source)); setActive(-1); setMode("live"); }
          }}
        >
          {mode === "live" ? "Markdown 源码" : "即时渲染"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={save}>保存</button>
      </header>

      <div
        className="note-focus-body"
        ref={bodyRef}
        onKeyDown={(e) => {
          if (e.key === "Escape" && active >= 0) { e.stopPropagation(); setActive(-1); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        }}
      >
        {mode === "source" ? (
          <textarea
            ref={areaRef}
            className="note-source"
            value={blocks.join("\n\n")}
            spellCheck={false}
            placeholder="用 Markdown 写笔记…"
            onChange={(e) => setBlocks(splitBlocks(e.target.value))}
          />
        ) : (
          <>
            {blocks.map((b, i) => (
              i === active ? (
                <textarea
                  key={i}
                  ref={areaRef}
                  className="note-block-edit"
                  value={b}
                  spellCheck={false}
                  placeholder="写点什么…（支持 Markdown 与 $公式$）"
                  onChange={(e) => setBlock(i, e.target.value)}
                  onBlur={() => {
                    // 空行分隔的多段在失焦时拆成独立的块，下次就能逐段点击编辑
                    setBlocks((prev) => {
                      const parts = (prev[i] || "").split(/\n\s*\n/);
                      if (parts.length <= 1) { return prev; }
                      const next = prev.slice();
                      next.splice(i, 1, ...parts.map((p) => p.replace(/\s+$/, "")));
                      return next;
                    });
                    setActive((cur) => (cur === i ? -1 : cur));
                  }}
                />
              ) : (
                <div
                  key={i}
                  className={"note-block" + (b.trim() ? "" : " is-blank")}
                  onMouseDown={(e) => { e.preventDefault(); setActive(i); }}
                >
                  {b.trim()
                    ? <Markdown text={b} onCite={(id, page, quote) => onCite?.(id, page, quote)} />
                    : <span className="note-block-hint">点击开始写…</span>}
                </div>
              )
            ))}
            <button type="button" className="note-add-block" onClick={addBlock} title="在末尾继续写一段">
              <Icon name="plus" small /> 继续写
            </button>
          </>
        )}
      </div>

      <footer className="note-focus-foot">
        <span className="note-hint">点击任意段落即可编辑 · 支持 Markdown、$公式$ 与引用胶囊</span>
        <span className="od-fill" />
        <span className="note-hint">Ctrl / ⌘ + Enter 保存</span>
      </footer>
    </div>
  );
}
