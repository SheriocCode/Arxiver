"""Extract per-page text from a PDF.

Prints a JSON array ``[{"page": 1, "text": "..."}, ...]`` to stdout.
Uses the bundled PyMuPDF (fitz); falls back to pdfminer if unavailable.
Runs on the embedded interpreter (engine/runtime/python.exe), so we put the
bundled ``site-packages`` on ``sys.path`` ourselves (the embeddable distribution
uses a ``._pth`` file).
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "site-packages")
if SITE not in sys.path:
    sys.path.insert(0, SITE)


def extract_fitz(path):
    import fitz  # PyMuPDF

    pages = []
    with fitz.open(path) as doc:
        for index, page in enumerate(doc):
            pages.append({"page": index + 1, "text": page.get_text("text").strip()})
    return pages


def extract_pdfminer(path):
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer

    pages = []
    for index, layout in enumerate(extract_pages(path)):
        parts = [el.get_text() for el in layout if isinstance(el, LTTextContainer)]
        pages.append({"page": index + 1, "text": "".join(parts).strip()})
    return pages


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print("[]")
        return 1
    path = sys.argv[1]
    try:
        pages = extract_fitz(path)
    except Exception:
        pages = extract_pdfminer(path)
    sys.stdout.write(json.dumps(pages, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
