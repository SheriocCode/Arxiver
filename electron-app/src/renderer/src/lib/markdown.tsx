import type { JSX } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

// [[cite:docId#page]] 或 [[cite:docId#page|原文片段]]（片段用于在 PDF 文本层里定位并高亮）
const CITE = /\[\[cite:([0-9a-fA-F]*)#(\d+)(?:\|([^\]]*))?\]\]/g;
const CARD = /\[\[card:(\d+)\]\]/g;

// 引用胶囊里展示的段落预览：太长就截断，完整内容放在 title 里
function quotePreview(quote: string, max = 64): string {
  const s = quote.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

// 放进 Markdown 链接目标里：encodeURIComponent 不会转义 ()| 这些会截断链接的字符，补一下
function encodeQuote(quote: string): string {
  return encodeURIComponent(quote).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\|/g, "%7C");
}

// 注意：react-markdown 还会把链接目标里的 | 再编码成 %7C，所以两种写法都要认。
function parseCiteHref(href: string | undefined): { docId: string; page: number; quote: string } | null {
  if (!href || !href.startsWith("cite:")) { return null; }
  const rest = href.slice(5);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) { return null; }
  const docId = rest.slice(0, hash);
  if (!/^[0-9a-fA-F]*$/.test(docId)) { return null; }
  const m = /^(\d+)(?:(?:\||%7C|%7c)(.*))?$/.exec(rest.slice(hash + 1));
  if (!m) { return null; }
  let quote = m[2] || "";
  try { quote = m[2] ? decodeURIComponent(m[2]) : ""; } catch { /* 保持原样 */ }
  return { docId, page: parseInt(m[1], 10), quote: quote.replace(/\s+/g, " ").trim() };
}

export function Markdown({ text, onCite, onCard }: {
  text: string;
  onCite: (docId: string, page: number, quote?: string) => void;
  onCard?: (n: number) => void;
}): JSX.Element {
  const prepared = String(text || "")
    .replace(CITE, (_m, id: string, page: string, quote?: string) => {
      const q = String(quote || "").replace(/\s+/g, " ").trim();
      const href = `cite:${id}#${page}${q ? "|" + encodeQuote(q) : ""}`;
      return `[第 ${page} 页](${href})`;
    })
    // 外部检索结果的卡片引用（[[card:N]]）→ 可点击的胶囊，点了跳到那张卡片
    .replace(CARD, (_m, n: string) => `[卡片 ${n}](card:${n})`);

  const components: Components = {
    a({ href, children }) {
      const cite = parseCiteHref(href);
      if (cite) {
        const { docId, page, quote } = cite;
        if (!quote) {
          return <button type="button" className="cite-chip" title={`跳到第 ${page} 页`} onClick={() => onCite(docId, page)}>{children}</button>;
        }
        return (
          <button
            type="button"
            className="cite-chip has-quote"
            title={`跳到第 ${page} 页并高亮：${quote}`}
            onClick={() => onCite(docId, page, quote)}
          >
            <span className="cite-page">第 {page} 页</span>
            <span className="cite-quote">“{quotePreview(quote)}”</span>
          </button>
        );
      }
      const c = href ? /^card:(\d+)$/.exec(href) : null;
      if (c) {
        return <button type="button" className="cite-chip card-chip" title="跳到这张检索卡片" onClick={() => onCard?.(parseInt(c[1], 10))}>{children}</button>;
      }
      // 内部链接解析失败时也不能交给系统打开（会弹「无法打开此 cite 链接」）
      if (href && (href.startsWith("cite:") || href.startsWith("card:"))) {
        return <span className="cite-chip">{children}</span>;
      }
      return <a href={href} onClick={(e) => { e.preventDefault(); if (href) { void window.api.openExternal(href); } }}>{children}</a>;
    }
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
      urlTransform={(url) => (url.startsWith("cite:") || url.startsWith("card:") ? url : defaultUrlTransform(url))}
    >
      {prepared}
    </ReactMarkdown>
  );
}
