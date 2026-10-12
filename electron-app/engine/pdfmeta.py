"""读取 PDF 自带元信息，并尝试从首页文本里找出 arXiv 编号 / DOI。

供本地导入时自动补全元数据使用：main 进程拿到结果后，
若有 arXiv/DOI 就再走官方接口取更完整的元信息。
用法：python pdfmeta.py <pdf 路径>   → 输出 JSON
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "site-packages")
if SITE not in sys.path:
    sys.path.insert(0, SITE)

import fitz

ARXIV = re.compile(r"arXiv[:\s]*([a-z-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(v\d+)?", re.I)
DOI = re.compile(r'\b(10\.\d{4,9}/[^\s"<>)]+)', re.I)


def main() -> None:
    out = {"title": "", "author": "", "arxivId": "", "doi": ""}
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        doc = fitz.open(path)
    except Exception:
        print(json.dumps(out, ensure_ascii=False))
        return

    try:
        meta = doc.metadata or {}
        out["title"] = (meta.get("title") or "").strip()
        out["author"] = (meta.get("author") or "").strip()
    except Exception:
        pass

    text = ""
    try:
        text = doc[0].get_text() or ""
    except Exception:
        pass

    m = ARXIV.search(text)
    if m:
        out["arxivId"] = m.group(1) + (m.group(2) or "")
    d = DOI.search(text)
    if d:
        out["doi"] = d.group(1).rstrip(".,;)]")

    print(json.dumps(out, ensure_ascii=False))


main()
