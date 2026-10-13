import type { JSX } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

const CITE = /\[\[cite:([0-9a-fA-F]*)#(\d+)\]\]/g;
const CARD = /\[\[card:(\d+)\]\]/g;

export function Markdown({ text, onCite, onCard }: {
  text: string;
  onCite: (docId: string, page: number) => void;
  onCard?: (n: number) => void;
}): JSX.Element {
  const prepared = String(text || "")
    .replace(CITE, (_m, id: string, page: string) => `[第 ${page} 页](cite:${id}#${page})`)
    // 外部检索结果的卡片引用（[[card:N]]）→ 可点击的胶囊，点了跳到那张卡片
    .replace(CARD, (_m, n: string) => `[卡片 ${n}](card:${n})`);

  const components: Components = {
    a({ href, children }) {
      const m = href ? /^cite:([0-9a-fA-F]*)#(\d+)$/.exec(href) : null;
      if (m) {
        const page = parseInt(m[2], 10);
        return <button type="button" className="cite-chip" onClick={() => onCite(m[1], page)}>{children}</button>;
      }
      const c = href ? /^card:(\d+)$/.exec(href) : null;
      if (c) {
        return <button type="button" className="cite-chip card-chip" title="跳到这张检索卡片" onClick={() => onCard?.(parseInt(c[1], 10))}>{children}</button>;
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
