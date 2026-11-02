// 模型常把块级公式整行写成 $$...$$。remark-math 只认「$$ 独占一行」的块级公式，
// 这种写法会被判成**行内**公式，于是 \tag、\begin{aligned} 等只在 display 模式可用的命令
// 解析失败，rehype-katex 把整段源码用红色原样吐出来（AI 对话里「公式不渲染、变成红字」）。
// 这里把自成一行（可跨行）的 $$...$$ 规整成块级公式：$$ 各占一行；代码块里的 $$ 原样保留。
const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
const MATH_LINE = /(^[ \t]*(?:>[ \t]*)*)\$\$[ \t]*((?:(?!\$\$)[\s\S])*?)[ \t]*\$\$[ \t]*$/gm;

function normalizeSegment(text: string): string {
  return text.replace(MATH_LINE, (_match, indent: string, body: string) => {
    const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    // 空公式（$$$$）直接丢掉，别留下空行
    if (!lines.length) { return ""; }
    return `${indent}$$\n${indent}${lines.join("\n" + indent)}\n${indent}$$`;
  });
}

export function normalizeMath(text: string): string {
  // split 时奇数下标是被捕获的代码块，原样保留
  return text.split(FENCE).map((part, i) => (i % 2 === 1 ? part : normalizeSegment(part))).join("");
}
