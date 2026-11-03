// 「顺便问」锚点：把正文里命中这些原文片段的位置包成可点击的虚线下划线。
// 选中的文字来自渲染后的 DOM（软换行是空白、可能跨越 <strong>/<em> 等内联节点），
// 所以按「空白折叠」后的整段文本匹配，再映射回各个文本节点——跨节点的选段也能标上。

export interface QuoteMark { id: string; text: string; title?: string }

const SKIP_TAGS = new Set(["code", "pre", "script", "style"]);
// 这些是块级容器：文本节点按"最内层块"收集，避免同一个段落被父/子重复处理
const BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "dd", "dt", "figcaption"]);

interface CharRef { node: any; index: number }

function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) { norm += " "; map.push(i); prevSpace = true; }
    } else {
      norm += ch; map.push(i); prevSpace = false;
    }
  }
  while (norm.endsWith(" ")) { norm = norm.slice(0, -1); map.pop(); }
  return { norm, map };
}

// 收集一个块里所有内联文本节点（跳过代码块和嵌套块，它们各自处理）
function inlineTextNodes(el: any): any[] {
  const out: any[] = [];
  const walk = (node: any): void => {
    for (const child of node.children || []) {
      if (child.type === "text") { out.push(child); continue; }
      if (child.type !== "element") { continue; }
      if (SKIP_TAGS.has(child.tagName) || BLOCK_TAGS.has(child.tagName)) { continue; }
      walk(child);
    }
  };
  walk(el);
  return out;
}

function spanFor(mark: QuoteMark): any {
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["btw-anchor"], dataBtw: mark.id, title: mark.title || "顺便问过" },
    children: []
  };
}

interface Match { id: number; start: number; end: number; mark: QuoteMark }

// 在一个块元素内部做跨节点的标记
function markBlock(el: any, marks: { mark: QuoteMark; needle: string }[]): void {
  const nodes = inlineTextNodes(el);
  if (!nodes.length) { return; }

  // 把整块的文本拼起来，并记录每个字符来自哪个节点 / 哪个下标
  const refs: CharRef[] = [];
  let flat = "";
  let prevSpace = true;
  for (const node of nodes) {
    const value = String(node.value || "");
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (/\s/.test(ch)) {
        if (!prevSpace) { flat += " "; refs.push({ node, index: i }); prevSpace = true; }
        continue;
      }
      flat += ch; refs.push({ node, index: i }); prevSpace = false;
    }
  }
  if (!flat) { return; }

  const matches: Match[] = [];
  marks.forEach(({ mark, needle }, id) => {
    if (!needle) { return; }
    let from = 0;
    while (from <= flat.length - needle.length) {
      const at = flat.indexOf(needle, from);
      if (at < 0) { break; }
      const start = at;
      const end = at + needle.length;
      if (!matches.some((m) => start < m.end && end > m.start)) {
        matches.push({ id, start, end, mark });
      }
      from = at + needle.length;
    }
  });
  if (!matches.length) { return; }
  matches.sort((a, b) => a.start - b.start);

  // 每个字符属于哪一段（-1 = 普通文本）
  const owner: number[] = new Array(flat.length).fill(-1);
  matches.forEach((m, i) => { for (let k = m.start; k < m.end; k++) { owner[k] = i; } });
  const ownerByNode = new Map<any, Int32Array>();
  for (const node of nodes) {
    ownerByNode.set(node, new Int32Array(String(node.value || "").length).fill(-1));
  }
  refs.forEach((ref, flatIndex) => {
    const arr = ownerByNode.get(ref.node);
    if (arr) { arr[ref.index] = owner[flatIndex]; }
  });

  // 重建子节点：普通文本原样，命中区间包进 span（可跨多个原节点）
  const out: any[] = [];
  let open: { el: any; match: number } | null = null;
  const flush = (): void => { if (open) { out.push(open.el); open = null; } };

  for (const node of nodes) {
    const value = String(node.value || "");
    const own = ownerByNode.get(node)!;
    let run = "";
    for (let i = 0; i < value.length; i++) {
      const idx = own[i];
      if (idx < 0) {
        if (open) { flush(); }
        run += value[i];
        continue;
      }
      if (run) { out.push({ type: "text", value: run }); run = ""; }
      if (!open || open.match !== idx) {
        flush();
        open = { el: spanFor(matches[idx].mark), match: idx };
      }
      open.el.children.push({ type: "text", value: value[i] });
    }
    if (run) { out.push({ type: "text", value: run }); }
  }
  flush();

  el.children = out;
}

function walkBlocks(node: any, marks: { mark: QuoteMark; needle: string }[]): void {
  if (!node || !Array.isArray(node.children)) { return; }
  for (const child of node.children) {
    if (child.type !== "element") { continue; }
    if (SKIP_TAGS.has(child.tagName)) { continue; }
    if (BLOCK_TAGS.has(child.tagName)) { markBlock(child, marks); }
    walkBlocks(child, marks);
  }
}

export function rehypeBtwMarks(marks: QuoteMark[]) {
  const list = marks
    .map((mark) => ({ mark, needle: normalizeWithMap(String(mark.text || "")).norm }))
    .filter((x) => x.needle.length >= 2);
  return (tree: any): void => {
    if (!list.length) { return; }
    walkBlocks(tree, list);
  };
}
