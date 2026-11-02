// 「顺便问」锚点：把正文里命中这些原文片段的位置包成可点击的虚线下划线。
// 选中的文字来自渲染后的 DOM（软换行是空白），所以按「空白折叠」后的文本匹配，再映射回原文下标。

export interface QuoteMark { id: string; text: string; title?: string }

const SKIP_TAGS = new Set(["code", "pre", "script", "style"]);

interface Span { start: number; end: number; mark: QuoteMark }

function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = true;  // 开头的空白丢掉
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

function markTextNode(node: any, marks: { mark: QuoteMark; needle: string }[]): any[] | null {
  const value = String(node.value || "");
  if (!value) { return null; }
  const { norm, map } = normalizeWithMap(value);
  if (!norm) { return null; }
  const spans: Span[] = [];
  for (const { mark, needle } of marks) {
    let from = 0;
    while (from <= norm.length - needle.length) {
      const at = norm.indexOf(needle, from);
      if (at < 0) { break; }
      const start = map[at];
      const end = map[at + needle.length - 1] + 1;
      if (!spans.some((s) => start < s.end && end > s.start)) { spans.push({ start, end, mark }); }
      from = at + needle.length;
    }
  }
  if (!spans.length) { return null; }
  spans.sort((a, b) => a.start - b.start);
  const out: any[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor) { out.push({ type: "text", value: value.slice(cursor, s.start) }); }
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["btw-anchor"], dataBtw: s.mark.id, title: s.mark.title || "顺便问过" },
      children: [{ type: "text", value: value.slice(s.start, s.end) }]
    });
    cursor = s.end;
  }
  if (cursor < value.length) { out.push({ type: "text", value: value.slice(cursor) }); }
  return out;
}

export function rehypeBtwMarks(marks: QuoteMark[]) {
  const list = marks
    .map((mark) => ({ mark, needle: normalizeWithMap(String(mark.text || "")).norm }))
    .filter((x) => x.needle.length >= 2);
  return (tree: any): void => {
    if (!list.length) { return; }
    const walk = (node: any): void => {
      if (!node || !Array.isArray(node.children)) { return; }
      if (node.type === "element" && SKIP_TAGS.has(node.tagName)) { return; }
      const next: any[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          const replaced = markTextNode(child, list);
          if (replaced) { next.push(...replaced); continue; }
        } else { walk(child); }
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}
