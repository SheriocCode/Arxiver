import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration, EditorView, ViewPlugin, drawSelection, keymap, placeholder as cmPlaceholder,
  type DecorationSet, type ViewUpdate
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Icon } from "./Icons";
import { Markdown } from "../lib/markdown";

// 笔记编辑器：侧栏内全屏，Obsidian 式的 Live Preview（块级/行级即时渲染）。
//   · 没有编辑的地方是渲染后的富文本（`**粗体**` 显示成粗体，标记隐藏）
//   · 光标所在的那一行才展开原始标记，方便直接改语法
//   · 语法不完整（比如只剩一个 *）时不会被识别成强调，自然就显示成普通文本
//   · 公式 / 表格这种排版复杂的，右侧（窄面板时下方）有实时预览

const MARKER_NODES = new Set(["EmphasisMark", "CodeMark", "LinkMark", "StrikethroughMark", "HeaderMark"]);

const STYLE_NODES: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-code",
  Strikethrough: "cm-strike",
  Link: "cm-link",
  Blockquote: "cm-quote",
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6"
};

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  // 光标落在哪些行：这些行展开原始 Markdown 标记
  const cursorLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) { cursorLines.add(n); }
  }
  const onCursorLine = (pos: number): boolean => cursorLines.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const cls = STYLE_NODES[node.name];
        if (cls) {
          ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          return;
        }
        if (!onCursorLine(node.from)) {
          // 只隐藏标记本身，内容保持原样
          if (MARKER_NODES.has(node.name)) {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
            return;
          }
          // 链接的 URL 也算标记：`[文字](链接)` 里只保留文字
          if (node.name === "URL" && node.node.parent?.type.name === "Link") {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
        }
      }
    });
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.decorations = buildDecorations(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

// 工具条动作：包裹选区 / 行首加标记
type Action = (view: EditorView) => void;

const wrap = (before: string, after: string, placeholder: string): Action => (view) => {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || placeholder;
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length }
  });
  view.focus();
};

const prefix = (mark: string): Action => (view) => {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: line.from, insert: mark },
    selection: { anchor: from + mark.length }
  });
  view.focus();
};

const TOOLS: { label: string; title: string; run: Action }[] = [
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
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [text, setText] = useState(initial);
  // 预览单独做 150ms 防抖：长笔记（含大量公式）不至于每敲一个字就重排一次
  const [previewText, setPreviewText] = useState(initial);
  const [preview, setPreview] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setPreviewText(text), 150);
    return () => window.clearTimeout(t);
  }, [text]);
  const canSave = useMemo(() => text.trim().length > 0, [text]);

  const save = (): void => {
    const value = viewRef.current?.state.doc.toString() ?? text;
    if (value.trim()) { onSave(value.trim()); }
  };
  // Ctrl+Enter 的 keymap 需要拿到最新的 save 闭包
  const saveRef = useRef<() => void>(save);
  saveRef.current = save;

  // 建编辑器（只建一次；内容由 CodeMirror 自己维护）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) { return; }
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, addKeymap: false }),
      livePreview,
      cmPlaceholder("在这里写笔记，支持 Markdown：## 标题、**粗体**、- 列表、$公式$"),
      keymap.of([
        {
          key: "Mod-b", preventDefault: true, run: (view) => { wrap("**", "**", "粗体")(view); return true; }
        },
        {
          key: "Mod-i", preventDefault: true, run: (view) => { wrap("*", "*", "斜体")(view); return true; }
        },
        {
          key: "Mod-Enter", preventDefault: true, run: () => { saveRef.current?.(); return true; }
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) { setText(u.state.doc.toString()); }
      })
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: initial, extensions }),
      parent: host
    });
    viewRef.current = view;
    view.focus();
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <button
            key={t.label}
            type="button"
            className="note-format-btn"
            title={t.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { const v = viewRef.current; if (v) { t.run(v); } }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={"note-edit-area" + (preview ? " has-preview" : "")}>
        <div className="note-cm" ref={hostRef} />
        {preview ? (
          <div className="note-preview">
            {previewText.trim()
              ? <Markdown text={previewText} onCite={(id, page, quote) => onCite?.(id, page, quote)} />
              : <div className="note-preview-empty">预览区 · 输入内容后在这里看到渲染效果</div>}
          </div>
        ) : null}
      </div>

      <footer className="note-focus-foot">
        <span className="note-hint">光标所在行会显示 Markdown 标记，其它位置按富文本渲染</span>
        <span className="od-fill" />
        <span className="note-hint">Ctrl / ⌘ + Enter 保存</span>
      </footer>
    </div>
  );
}
