"""Generate a table of contents (outline) for a PDF.

Prints a JSON object to stdout::

    {"source": "bookmarks" | "heuristic" | "none",
     "items": [{"level": 1, "title": "Introduction", "page": 3}, ...]}

If the PDF has embedded bookmarks they are returned as-is. Otherwise a light
offline heuristic extracts headings from the text: lines that are larger than
the body font, or bold and look like headings (numbered sections, known section
names, short title-like lines), with filtering for captions, references and
equations. Runs on the embedded interpreter, so the bundled ``site-packages`` is
put on ``sys.path`` here.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "site-packages")
if SITE not in sys.path:
    sys.path.insert(0, SITE)

# "1 Introduction", "2.1 Method", "3.2.1 Details"
NUMBERED = re.compile(r"^\s*(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+(\S.*)$")
# "A Appendix", "A1. Proof", "B.2 Lemma", "C1.2 ..."
APPENDIX = re.compile(r"^\s*([A-Z]\d?(?:\.\d{1,2}){0,3})[.)]?\s+([A-Za-z].*)$")
KNOWN = re.compile(
    r"^\s*(abstract|introduction|related works?|background|preliminaries|"
    r"motivation|method(?:s|ology)?|approach|materials? and methods?|"
    r"system (?:overview|design|architecture)|implementation|"
    r"experiments?(?: and results?)?|evaluation|results?(?: and discussion)?|"
    r"discussion|conclusions?(?: and future work)?|future work|"
    r"references|bibliography|acknowledg(?:e)?ments?|appendix(?:\s+[A-Z])?)\b",
    re.I,
)
# unnumbered sections that are almost always real (accepted without a size bump)
STRONG = re.compile(
    r"^\s*(abstract|introduction|related works?|references|bibliography|"
    r"acknowledg(?:e)?ments?|conclusions?(?: and future work)?|future work|appendix)\b",
    re.I,
)
CAPTION = re.compile(
    r"^\s*(fig(?:ure)?|tab(?:le)?|algorithm|listing|eq(?:uation)?)\s*[.:]?\s*\d",
    re.I,
)
REF_ENTRY = re.compile(r"^\s*\[?\d{1,3}[\].]\s+[A-Z][A-Za-z\-]+,\s")

_LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi",
    "\ufb04": "ffl", "\ufb05": "ft", "\ufb06": "st",
}


def _norm_title(text):
    text = text.replace("\u00ad", "")
    for src, dst in _LIGATURES.items():
        text = text.replace(src, dst)
    return re.sub(r"\s+", " ", text).strip()


def bookmarks(doc):
    out = []
    for level, title, page in doc.get_toc(simple=True):
        title = _norm_title(title or "")
        if not title:
            continue
        out.append({"level": max(1, int(level)), "title": title, "page": max(1, int(page))})
    return out


def _is_known_section(text, size, body_size):
    m = KNOWN.match(text)
    if not m:
        return False
    # the line must be (almost) just the section name, not a sentence starting with it
    if len(re.findall(r"[A-Za-z]+", _norm_title(text)[m.end():])) > 1:
        return False
    # weak markers ("Results", "Experiments", ...) also need to stand out in size,
    # otherwise they are run-in bold paragraphs
    return bool(STRONG.match(text)) or size >= body_size + 0.4


def _looks_like_heading(text, numbered, body_size, size, first_page, known):
    t = text.strip()
    if not t or len(t) > 110:
        return False
    if CAPTION.match(t) or REF_ENTRY.match(t):
        return False
    if numbered:
        # a numbered heading is usually short and not an ordinary sentence
        return not (t.endswith(".") and len(t) > 70)
    # unnumbered headings essentially never end with sentence punctuation
    if t.endswith((".", ",", ";", ":", "?", "!")):
        return False
    if known:
        return len(re.findall(r"[A-Za-z]", t)) <= 40
    if first_page:
        # on page 1 only accept well-known section names (avoid title/authors/affiliation)
        return False
    words = re.findall(r"[A-Za-z][A-Za-z\-]+", t)
    if len(words) < 2:
        return False
    letters = [c for c in t if c.isalpha()]
    if letters and all(c.isupper() for c in letters) and len(letters) >= 3:
        return True
    if sum(1 for w in words if w[0].isupper()) >= max(1, len(words) - 1) and size >= body_size + 0.4:
        return True
    return False


def heuristic(doc):
    lines = []
    weight = {}
    for pno in range(doc.page_count):
        data = doc[pno].get_text("dict")
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                size = max(s.get("size", 0) for s in spans)
                bold = any(s.get("flags", 0) & 16 for s in spans)
                bbox = line.get("bbox", [0, 0, 0, 0])
                page = doc[pno]
                lines.append({
                    "page": pno + 1, "text": text, "size": size, "bold": bold,
                    "y": bbox[1], "h": page.rect.height or 0,
                })
                for s in spans:
                    st = s.get("text", "").strip()
                    if st:
                        key = round(s.get("size", 0), 1)
                        weight[key] = weight.get(key, 0) + len(st)
    if not lines:
        return []

    body_size = max(weight.items(), key=lambda kv: kv[1])[0] if weight else 0.0

    items = []
    last_level = 0
    for ln in lines:
        text, size, bold, page = ln["text"], ln["size"], ln["bold"], ln["page"]
        m = NUMBERED.match(text) or APPENDIX.match(text)
        num = m.group(1) if m else None
        known = m is None and _is_known_section(text, size, body_size)
        larger = size >= body_size + 0.8
        boldish = bold and size >= body_size - 0.2
        if not (larger or boldish or known):
            continue
        # a paper title is much larger than any heading
        if page == 1 and size >= body_size + 5:
            continue
        if not _looks_like_heading(text, bool(num), body_size, size, page == 1, known):
            continue
        if num:
            level = min(3, num.count(".") + 1)
        elif known:
            level = 1
        else:
            # unnumbered headings (bold paragraph titles, ALL CAPS) nest under the last section
            level = min(3, last_level + 1) if last_level else 1
        last_level = level
        height = ln.get("h") or 0
        anchor = round(min(1.0, max(0.0, ln["y"] / height)), 4) if height else 0.0
        items.append({"level": level, "title": _norm_title(text), "page": page, "anchor": anchor})

    if not items:
        return []
    # keep the PDF's own reading order (block order): sorting by x/y would
    # interleave two-column layouts incorrectly
    seen = set()
    out = []
    for it in items:
        key = (it["page"], it["title"])
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print(json.dumps({"source": "none", "items": []}))
        return 1
    path = sys.argv[1]
    try:
        import fitz

        with fitz.open(path) as doc:
            marks = bookmarks(doc)
            if marks:
                print(json.dumps({"source": "bookmarks", "items": marks}, ensure_ascii=False))
                return 0
            items = heuristic(doc)
            source = "heuristic" if items else "none"
            print(json.dumps({"source": source, "items": items}, ensure_ascii=False))
            return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"source": "error", "error": str(exc), "items": []}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
