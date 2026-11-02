import { useEffect, useRef, useState, type JSX } from "react";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration, EditorView, ViewPlugin, drawSelection, keymap, placeholder as cmPlaceholder,
  WidgetType, type DecorationSet, type ViewUpdate
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import katex from "katex";
import { Icon } from "./Icons";

// 笔记编辑器：侧栏内全屏，Obsidian 式的 Live Preview。
//   · 没在编辑的地方按富文本渲染（标记隐藏），光标所在行才展开 Markdown 标记
//   · 公式（$…$ / $$…$$）就地渲染成 KaTeX；光标进入该公式时恢复源码
//   · 语法不完整时解析不出强调/公式，原样显示，不会被"渲染"成别的东西

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

interface MathSpan { from: number; to: number; tex: string; display: boolean }

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) { super(); }
  eq(other: MathWidget): boolean { return other.tex === this.tex && other.display === this.display; }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math-inline";
    try {
      katex.render(this.tex, el, { displayMode: this.display, throwOnError: false });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }
  ignoreEvent(): boolean { return false; }
}

// 扫出正文里的公式（代码块/行内代码里的不算）
function collectMath(state: EditorState): MathSpan[] {
  const out: MathSpan[] = [];
  const doc = state.doc;
  const tree = syntaxTree(state);
  const inCode = (pos: number): boolean => {
    for (let n: any = tree.resolveInner(pos, 1); n; n = n.parent) {
      if (n.name === "InlineCode" || n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "CodeText") { return true; }
    }
    return false;
  };

  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    if (!inCode(line.from)) {
      // 单行 $$…$$
      const single = /^\s*\$\$(.+?)\$\$\s*$/.exec(line.text);
      if (single) {
        out.push({ from: line.from, to: line.to, tex: single[1].trim(), display: true });
        i++;
        continue;
      }
      // 多行 $$ … $$
      if (/^\s*\$\$\s*$/.test(line.text)) {
        let j = i + 1;
        while (j <= doc.lines && !/^\s*\$\$\s*$/.test(doc.line(j).text)) { j++; }
        if (j <= doc.lines) {
          const tex = [];
          for (let k = i + 1; k < j; k++) { tex.push(doc.line(k).text); }
          out.push({ from: line.from, to: doc.line(j).to, tex: tex.join("\n"), display: true });
          i = j + 1;
          continue;
        }
      }
      // 行内 $…$（不跨行、不匹配 $$）
      const re = /(?<![\\$])\$([^$\n]+?)\$(?!\$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line.text)) !== null) {
        const from = line.from + m.index;
        out.push({ from, to: from + m[0].length, tex: m[1], display: false });
      }
    }
    i++;
  }
  return out;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const touches = (from: number, to: number): boolean => sel.some((r) => r.from <= to && r.to >= from);

  // 光标落在哪些行：这些行展开原始 Markdown 标记
  const cursorLines = new Set<number>();
  for (const r of sel) {
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
          if (MARKER_NODES.has(node.name)) {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
            return;
          }
          // 链接只显示文字：隐藏 `[`、`](`、`)` 和 URL
          if (node.name === "URL" && node.node.parent?.type.name === "Link") {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
        }
      }
    });
  }

  // 公式：光标不在里面时渲染成 KaTeX
  for (const span of collectMath(state)) {
    if (touches(span.from, span.to)) { continue; }
    ranges.push(Decoration.replace({
      widget: new MathWidget(span.tex, span.display),
      block: span.display
    }).range(span.from, span.to));
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

// 工具条动作
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

export default function NoteEditor({ initial, isNew, onSave, onCancel }: {
  initial: string;
  isNew: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [text, setText] = useState(initial);
  const canSave = text.trim().length > 0;

  const save = (): void => {
    const value = viewRef.current?.state.doc.toString() ?? text;
    if (value.trim()) { onSave(value.trim()); }
  };
  const saveRef = useRef<() => void>(save);
  saveRef.current = save;

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
        { key: "Mod-b", preventDefault: true, run: (view) => { wrap("**", "**", "粗体")(view); return true; } },
        { key: "Mod-i", preventDefault: true, run: (view) => { wrap("*", "*", "斜体")(view); return true; } },
        { key: "Mod-Enter", preventDefault: true, run: () => { saveRef.current(); return true; } },
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

      <div className="note-edit-area">
        <div className="note-cm" ref={hostRef} />
      </div>

      <footer className="note-focus-foot">
        <span className="note-hint">光标所在行展开 Markdown 标记；公式会就地渲染，点进去可改源码</span>
        <span className="od-fill" />
        <span className="note-hint">Ctrl / ⌘ + Enter 保存</span>
      </footer>
    </div>
  );
}
