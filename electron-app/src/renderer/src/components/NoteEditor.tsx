import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Icon } from "./Icons";
import { Markdown } from "../lib/markdown";

// 笔记编辑器：侧栏内全屏。
//   · 顶部格式工具条：粗体 / 斜体 / 标题 / 列表 / 引用 / 代码 / 公式 / 链接（选中即包裹）
//   · 左侧（窄面板时改为上方）是 Markdown 源码，右侧/下方是**实时预览**，边写边看效果
//   · 面板够宽时并排，窄的时候上下分栏（用容器查询切换）

type Block = (el: HTMLTextAreaElement, text: string, setText: (v: string) => void) => void;

// 在选区两侧包一层（没有选中就插入占位文字）
const wrap = (before: string, after: string, placeholder: string): Block => (el, text, setText) => {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const selected = text.slice(start, end) || placeholder;
  const next = text.slice(0, start) + before + selected + after + text.slice(end);
  setText(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = start + before.length;
    el.selectionEnd = start + before.length + selected.length;
  });
};

// 在行首加前缀（标题 / 列表 / 引用）
const prefix = (mark: string): Block => (el, text, setText) => {
  const start = el.selectionStart ?? 0;
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const next = text.slice(0, lineStart) + mark + text.slice(lineStart);
  setText(next);
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + mark.length;
    el.selectionStart = el.selectionEnd = pos;
  });
};

const TOOLS: { label: string; title: string; run: Block }[] = [
  { label: "B", title: "粗体（Ctrl+B）", run: wrap("**", "**", "粗体") },
  { label: "I", title: "斜体（Ctrl+I）", run: wrap("*", "*", "斜体") },
  { label: "H", title: "标题", run: prefix("## ") },
  { label: "•", title: "无序列表", run: prefix("- ") },
  { label: "1.", title: "有序列表", run: prefix("1. ") },
  { label: "❝", title: "引用", run: prefix("> ") },
  { label: "</>", title: "行内代码", run: wrap("`", "`", "code") },
  { label: "∑", title: "行内公式", run: wrap("$", "$", "E=mc^2") },
  { label: "∑∑", title: "块级公式", run: wrap("\n$$\n", "\n$$\n", "a^2+b^2=c^2") },
  { label: "🔗", title: "链接", run: wrap("[", "](https://)", "链接文字") }
];

export default function NoteEditor({ initial, isNew, onSave, onCancel, onCite }: {
  initial: string;
  isNew: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onCite?: (docId: string, page: number, quote?: string) => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(true);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const canSave = useMemo(() => text.trim().length > 0, [text]);

  useEffect(() => { areaRef.current?.focus(); }, []);

  const save = (): void => { if (canSave) { onSave(text.trim()); } };

  const run = (tool: Block): void => {
    const el = areaRef.current;
    if (!el) { return; }
    tool(el, text, (v) => setText(v));
  };

  return (
    <div className="note-focus">
      <header className="note-focus-head">
        <Icon name="note" small />
        <span className="note-focus-title">{isNew ? "新建笔记" : "编辑笔记"}</span>
        <span className="od-fill" />
        <button type="button" className="btn btn-ghost" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
          {preview ? "隐藏预览" : "显示预览"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>保存</button>
      </header>

      <div className="note-format-bar" role="toolbar" aria-label="格式">
        {TOOLS.map((t) => (
          <button key={t.label} type="button" className="note-format-btn" title={t.title} onClick={() => run(t.run)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className={"note-edit-area" + (preview ? " has-preview" : "")}>
        <textarea
          ref={areaRef}
          className="note-source"
          value={text}
          spellCheck={false}
          placeholder={"在这里写笔记，支持 Markdown：\n## 标题\n**粗体**、*斜体*、`代码`、- 列表、> 引用\n行内公式 $a^2+b^2$，块级公式用 $$ 包起来"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); run(TOOLS[0].run); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") { e.preventDefault(); run(TOOLS[1].run); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            else if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              setText(text.slice(0, start) + "  " + text.slice(el.selectionEnd));
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
            }
          }}
        />
        {preview ? (
          <div className="note-preview">
            {text.trim()
              ? <Markdown text={text} onCite={(id, page, quote) => onCite?.(id, page, quote)} />
              : <div className="note-preview-empty">预览区 · 输入内容后在这里看到渲染效果</div>}
          </div>
        ) : null}
      </div>

      <footer className="note-focus-foot">
        <span className="note-hint">Ctrl/⌘ + B 粗体 · Ctrl/⌘ + I 斜体 · Tab 缩进</span>
        <span className="od-fill" />
        <span className="note-hint">Ctrl / ⌘ + Enter 保存</span>
      </footer>
    </div>
  );
}
