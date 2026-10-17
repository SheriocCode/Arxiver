"""Functions that can be used for the most common use-cases for translate_engine.six"""

import asyncio
import io
import json
import os
import re
import sys
import tempfile
import time
import logging
from asyncio import CancelledError
from pathlib import Path
from string import Template
from typing import Any, BinaryIO, List, Optional, Dict

import numpy as np
import requests
import tqdm
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfexceptions import PDFValueError
from pdfminer.pdfinterp import PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfparser import PDFParser
from pymupdf import Document, Font

from translate_engine.converter import TranslateConverter
from translate_engine.doclayout import OnnxModel
from translate_engine.pdfinterp import PDFPageInterpreterEx

from translate_engine.config import ConfigManager
from babeldoc.assets.assets import get_font_and_metadata

NOTO_NAME = "noto"

logger = logging.getLogger(__name__)

noto_list = [
    "am",  # Amharic
    "ar",  # Arabic
    "bn",  # Bengali
    "bg",  # Bulgarian
    "chr",  # Cherokee
    "el",  # Greek
    "gu",  # Gujarati
    "iw",  # Hebrew
    "hi",  # Hindi
    "kn",  # Kannada
    "ml",  # Malayalam
    "mr",  # Marathi
    "ru",  # Russian
    "sr",  # Serbian
    "ta",  # Tamil
    "te",  # Telugu
    "th",  # Thai
    "ur",  # Urdu
    "uk",  # Ukrainian
]


def check_files(files: List[str]) -> List[str]:
    files = [
        f for f in files if not f.startswith("http://")
    ]  # exclude online files, http
    files = [
        f for f in files if not f.startswith("https://")
    ]  # exclude online files, https
    missing_files = [file for file in files if not os.path.exists(file)]
    return missing_files


def _atomic_write_bytes(path: str, data: bytes) -> None:
    tmp = path + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


def _write_partial_pdfs(doc_en, doc_zh, done_pages, partial_dir: str, state=None) -> None:
    """Write an incremental preview of the pages translated so far.

    ``done_pages`` is the list of translated page indices (document order).
    Produces ``partial-mono.pdf`` (translated pages only) and ``partial-dual.pdf``
    (original + translated interleaved per page) atomically.

    When ``state`` is provided, the accumulated mono/dual documents are reused and
    only newly finished pages are appended. Rebuilding the whole file on every page
    (re-insert + re-subset + re-compress every page each time) is O(n^2) and quickly
    dominates runtime on longer documents.
    """
    os.makedirs(partial_dir, exist_ok=True)

    if state is None:
        mono = Document()
        dual = Document()
        written = 0
    else:
        mono = state.get("mono")
        dual = state.get("dual")
        if mono is None or dual is None:
            mono = Document()
            dual = Document()
            state["mono"] = mono
            state["dual"] = dual
            state["written"] = 0
        written = state["written"]

    for index in done_pages[written:]:
        mono.insert_pdf(doc_zh, from_page=index, to_page=index)
        dual.insert_pdf(doc_en, from_page=index, to_page=index)
        dual.insert_pdf(doc_zh, from_page=index, to_page=index)
    if state is not None:
        state["written"] = len(done_pages)

    try:
        mono.subset_fonts(fallback=True)
    except Exception:  # noqa: BLE001 - best effort, only affects preview size
        pass
    _atomic_write_bytes(
        os.path.join(partial_dir, "partial-mono.pdf"),
        mono.tobytes(deflate=True, garbage=3, use_objstms=1),
    )

    try:
        dual.subset_fonts(fallback=True)
    except Exception:  # noqa: BLE001
        pass
    _atomic_write_bytes(
        os.path.join(partial_dir, "partial-dual.pdf"),
        dual.tobytes(deflate=True, garbage=3, use_objstms=1),
    )

    if state is None:
        mono.close()
        dual.close()


def translate_patch(
    inf: BinaryIO,
    pages: Optional[list[int]] = None,
    vfont: str = "",
    vchar: str = "",
    thread: int = 0,
    doc_zh: Document = None,
    lang_in: str = "",
    lang_out: str = "",
    service: str = "",
    noto_name: str = "",
    noto: Font = None,
    callback: object = None,
    cancellation_event: asyncio.Event = None,
    model: OnnxModel = None,
    envs: Dict = None,
    prompt: Template = None,
    ignore_cache: bool = False,
    on_page_done: object = None,
    on_page_progress: object = None,
    on_block: object = None,
    **kwarg: Any,
) -> None:
    rsrcmgr = PDFResourceManager()
    layout = {}
    device = TranslateConverter(
        rsrcmgr,
        vfont,
        vchar,
        thread,
        layout,
        lang_in,
        lang_out,
        service,
        noto_name,
        noto,
        envs,
        prompt,
        ignore_cache,
    )

    assert device is not None
    obj_patch = {}
    interpreter = PDFPageInterpreterEx(rsrcmgr, device, obj_patch)
    if pages:
        total_pages = len(pages)
    else:
        total_pages = doc_zh.page_count

    parser = PDFParser(inf)
    doc = PDFDocument(parser)
    with tqdm.tqdm(total=total_pages) as progress:
        for pageno, page in enumerate(PDFPage.create_pages(doc)):
            if cancellation_event and cancellation_event.is_set():
                raise CancelledError("task cancelled")
            if pages and (pageno not in pages):
                continue
            progress.update()
            if callback:
                callback(progress)
            page.pageno = pageno
            pix = doc_zh[page.pageno].get_pixmap()
            image = np.frombuffer(pix.samples, np.uint8).reshape(
                pix.height, pix.width, 3
            )[:, :, ::-1]
            page_layout = model.predict(image, imgsz=int(pix.height / 32) * 32)[0]
            # kdtree 是不可能 kdtree 的，不如直接渲染成图片，用空间换时间
            box = np.ones((pix.height, pix.width))
            h, w = box.shape
            vcls = ["abandon", "figure", "table", "isolate_formula", "formula_caption"]
            for i, d in enumerate(page_layout.boxes):
                if page_layout.names[int(d.cls)] not in vcls:
                    x0, y0, x1, y1 = d.xyxy.squeeze()
                    x0, y0, x1, y1 = (
                        np.clip(int(x0 - 1), 0, w - 1),
                        np.clip(int(h - y1 - 1), 0, h - 1),
                        np.clip(int(x1 + 1), 0, w - 1),
                        np.clip(int(h - y0 + 1), 0, h - 1),
                    )
                    box[y0:y1, x0:x1] = i + 2
            for i, d in enumerate(page_layout.boxes):
                if page_layout.names[int(d.cls)] in vcls:
                    x0, y0, x1, y1 = d.xyxy.squeeze()
                    x0, y0, x1, y1 = (
                        np.clip(int(x0 - 1), 0, w - 1),
                        np.clip(int(h - y1 - 1), 0, h - 1),
                        np.clip(int(x1 + 1), 0, w - 1),
                        np.clip(int(h - y0 + 1), 0, h - 1),
                    )
                    box[y0:y1, x0:x1] = 0
            layout[page.pageno] = box
            # 新建一个 xref 存放新指令流
            page.page_xref = doc_zh.get_new_xref()  # hack 插入页面的新 xref
            doc_zh.update_object(page.page_xref, "<<>>")
            doc_zh.update_stream(page.page_xref, b"")
            doc_zh[page.pageno].set_contents(page.page_xref)
            device.page_progress_cb = on_page_progress
            device.block_progress_cb = on_block
            device.current_page = pageno + 1
            try:
                print("ENGINE_PAGE_START %d" % (pageno + 1), flush=True)
            except Exception:
                pass
            interpreter.process_page(page)
            if doc_zh is not None:
                for obj_id in list(obj_patch.keys()):
                    doc_zh.update_stream(obj_id, obj_patch.pop(obj_id).encode())
            if on_page_done is not None:
                on_page_done(pageno)

    device.close()
    return obj_patch


def _subset_fonts_best_effort(doc: Document) -> None:
    """字体子集化只影响输出体积，任何失败都不该让整个翻译任务失败。

    PyMuPDF 的旧实现（``fallback=True``）假定 ``/DescendantFonts`` 是 ``"N 0 R"``
    这样的间接引用，遇到字体字典是内联对象的 PDF 会抛 ``ValueError``（见
    ``pymupdf.utils.get_old_widths``）；此时改用 MuPDF 原生实现，仍失败就保留原字体。
    """
    for kwargs in ({"fallback": True}, {}):
        try:
            doc.subset_fonts(**kwargs)
            return
        except Exception as exc:  # noqa: BLE001 - 只影响体积，绝不中断翻译
            logger.warning("font subsetting failed (%s): %s", kwargs or "mupdf", exc)


def translate_stream(
    stream: bytes,
    pages: Optional[list[int]] = None,
    lang_in: str = "",
    lang_out: str = "",
    service: str = "",
    thread: int = 0,
    vfont: str = "",
    vchar: str = "",
    callback: object = None,
    cancellation_event: asyncio.Event = None,
    model: OnnxModel = None,
    envs: Dict = None,
    prompt: Template = None,
    skip_subset_fonts: bool = False,
    ignore_cache: bool = False,
    partial_dir: str = "",
    events_dir: str = "",
    **kwarg: Any,
):
    font_list = [("tiro", None)]

    font_path = download_remote_fonts(lang_out.lower())
    noto_name = NOTO_NAME
    noto = Font(noto_name, font_path)
    font_list.append((noto_name, font_path))

    doc_en = Document(stream=stream)
    stream = io.BytesIO()
    doc_en.save(stream)
    doc_zh = Document(stream=stream)
    page_count = doc_zh.page_count
    # font_list = [("GoNotoKurrent-Regular.ttf", font_path), ("tiro", None)]
    font_id = {}
    for page in doc_zh:
        for font in font_list:
            font_id[font[0]] = page.insert_font(font[0], font[1])
    xreflen = doc_zh.xref_length()
    for xref in range(1, xreflen):
        for label in ["Resources/", ""]:  # 可能是基于 xobj 的 res
            try:  # xref 读写可能出错
                font_res = doc_zh.xref_get_key(xref, f"{label}Font")
                target_key_prefix = f"{label}Font/"
                if font_res[0] == "xref":
                    resource_xref_id = re.search("(\\d+) 0 R", font_res[1]).group(1)
                    xref = int(resource_xref_id)
                    font_res = ("dict", doc_zh.xref_object(xref))
                    target_key_prefix = ""

                if font_res[0] == "dict":
                    for font in font_list:
                        target_key = f"{target_key_prefix}{font[0]}"
                        font_exist = doc_zh.xref_get_key(xref, target_key)
                        if font_exist[0] == "null":
                            doc_zh.xref_set_key(
                                xref,
                                target_key,
                                f"{font_id[font[0]]} 0 R",
                            )
            except Exception:
                pass

    fp = io.BytesIO()

    doc_zh.save(fp)

    _page_progress_last = {}

    def on_page_progress(page, done, total):
        pct = int(done * 100 / total) if total else 100
        previous = _page_progress_last.get(page, -1)
        if done != total and pct - previous < 5:
            return
        _page_progress_last[page] = pct
        try:
            print("ENGINE_PAGE_PROGRESS %d %d %d" % (page, done, total), flush=True)
        except Exception:
            pass

    on_page_done = None
    if partial_dir:
        target_total = len(pages) if pages else page_count
        _partial_state = {"last": 0.0, "done": [], "written": 0, "mono": None, "dual": None}

        def on_page_done(pageno):
            _partial_state["done"].append(pageno)
            done = len(_partial_state["done"])
            now = time.time()
            # 每翻完一页就刷新一次预览（追加式写入，只补新页）；只保留 1 秒的写入下限，
            # 避免页面很快时把磁盘写爆。最后一页一定写。
            if done < target_total and (
                done - _partial_state["written"] < 1
                or now - _partial_state["last"] < 1.0
            ):
                return
            _partial_state["last"] = now
            try:
                _write_partial_pdfs(
                    doc_en, doc_zh, _partial_state["done"], partial_dir, _partial_state
                )
                print("ENGINE_PARTIAL %d %d" % (done, target_total), flush=True)
            except Exception as exc:  # noqa: BLE001 - preview must never break translation
                logger.debug("partial preview failed: %s", exc)

    def on_block(page, index, total, bbox, src, dst, vars_=None):
        try:
            print("ENGINE_BLOCK %d %d %d" % (page, index + 1, total), flush=True)
        except Exception:
            pass
        if not events_dir:
            return
        try:
            os.makedirs(events_dir, exist_ok=True)
            record = {
                "page": page,
                "index": index,
                "total": total,
                "bbox": [round(float(v), 2) for v in bbox],
                "src": src,
                "dst": dst,
            }
            # 片段里引用到的 {vN} / {{vN}} 才有意义：把公式文本一并记下来给块框面板用
            if vars_:
                used = set(re.findall(r"\{+\s*v\s*(\d+)", f"{src or ''} {dst or ''}"))
                picked = {
                    vid: vars_[int(vid)]
                    for vid in used
                    if int(vid) < len(vars_) and vars_[int(vid)]
                }
                if picked:
                    record["vars"] = picked
            with open(
                os.path.join(events_dir, "engine-events.jsonl"), "a", encoding="utf-8"
            ) as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001 - events must never break translation
            logger.debug("block event write failed: %s", exc)

    obj_patch: dict = translate_patch(fp, **locals())

    for obj_id, ops_new in obj_patch.items():
        # ops_old=doc_en.xref_stream(obj_id)
        # print(obj_id)
        # print(ops_old)
        # print(ops_new.encode())
        doc_zh.update_stream(obj_id, ops_new.encode())

    doc_en.insert_file(doc_zh)
    for id in range(page_count):
        doc_en.move_page(page_count + id, id * 2 + 1)
    if not skip_subset_fonts:
        _subset_fonts_best_effort(doc_zh)
        _subset_fonts_best_effort(doc_en)
    return (
        doc_zh.write(deflate=True, garbage=3, use_objstms=1),
        doc_en.write(deflate=True, garbage=3, use_objstms=1),
    )


def convert_to_pdfa(input_path, output_path):
    """
    Convert PDF to PDF/A format

    Args:
        input_path: Path to source PDF file
        output_path: Path to save PDF/A file
    """
    from pikepdf import Dictionary, Name, Pdf

    # Open the PDF file
    pdf = Pdf.open(input_path)

    # Add PDF/A conformance metadata
    metadata = {
        "pdfa_part": "2",
        "pdfa_conformance": "B",
        "title": pdf.docinfo.get("/Title", ""),
        "author": pdf.docinfo.get("/Author", ""),
        "creator": "PDF Math Translate",
    }

    with pdf.open_metadata() as meta:
        meta.load_from_docinfo(pdf.docinfo)
        meta["pdfaid:part"] = metadata["pdfa_part"]
        meta["pdfaid:conformance"] = metadata["pdfa_conformance"]

    # Create OutputIntent dictionary
    output_intent = Dictionary(
        {
            "/Type": Name("/OutputIntent"),
            "/S": Name("/GTS_PDFA1"),
            "/OutputConditionIdentifier": "sRGB IEC61966-2.1",
            "/RegistryName": "http://www.color.org",
            "/Info": "sRGB IEC61966-2.1",
        }
    )

    # Add output intent to PDF root
    if "/OutputIntents" not in pdf.Root:
        pdf.Root.OutputIntents = [output_intent]
    else:
        pdf.Root.OutputIntents.append(output_intent)

    # Save as PDF/A
    pdf.save(output_path, linearize=True)
    pdf.close()


def translate(
    files: list[str],
    output: str = "",
    pages: Optional[list[int]] = None,
    lang_in: str = "",
    lang_out: str = "",
    service: str = "",
    thread: int = 0,
    vfont: str = "",
    vchar: str = "",
    callback: object = None,
    compatible: bool = False,
    cancellation_event: asyncio.Event = None,
    model: OnnxModel = None,
    envs: Dict = None,
    prompt: Template = None,
    skip_subset_fonts: bool = False,
    ignore_cache: bool = False,
    partial_dir: str = "",
    events_dir: str = "",
    **kwarg: Any,
):
    if not files:
        raise PDFValueError("No files to process.")

    missing_files = check_files(files)

    if missing_files:
        print("The following files do not exist:", file=sys.stderr)
        for file in missing_files:
            print(f"  {file}", file=sys.stderr)
        raise PDFValueError("Some files do not exist.")

    result_files = []

    for file in files:
        if type(file) is str and (
            file.startswith("http://") or file.startswith("https://")
        ):
            print("Online files detected, downloading...")
            try:
                r = requests.get(file, allow_redirects=True)
                if r.status_code == 200:
                    with tempfile.NamedTemporaryFile(
                        suffix=".pdf", delete=False
                    ) as tmp_file:
                        print(f"Writing the file: {file}...")
                        tmp_file.write(r.content)
                        file = tmp_file.name
                else:
                    r.raise_for_status()
            except Exception as e:
                raise PDFValueError(
                    f"Errors occur in downloading the PDF file. Please check the link(s).\nError:\n{e}"
                )
        filename = os.path.splitext(os.path.basename(file))[0]

        # If the commandline has specified converting to PDF/A format
        # --compatible / -cp
        if compatible:
            with tempfile.NamedTemporaryFile(
                suffix="-pdfa.pdf", delete=False
            ) as tmp_pdfa:
                print(f"Converting {file} to PDF/A format...")
                convert_to_pdfa(file, tmp_pdfa.name)
                doc_raw = open(tmp_pdfa.name, "rb")
                os.unlink(tmp_pdfa.name)
        else:
            doc_raw = open(file, "rb")
        s_raw = doc_raw.read()
        doc_raw.close()

        temp_dir = Path(tempfile.gettempdir())
        file_path = Path(file)
        try:
            if file_path.exists() and file_path.resolve().is_relative_to(
                temp_dir.resolve()
            ):
                file_path.unlink(missing_ok=True)
                logger.debug(f"Cleaned temp file: {file_path}")
        except Exception as e:
            logger.warning(f"Failed to clean temp file {file_path}", exc_info=True)

        s_mono, s_dual = translate_stream(
            s_raw,
            **locals(),
        )
        file_mono = Path(output) / f"{filename}-mono.pdf"
        file_dual = Path(output) / f"{filename}-dual.pdf"
        doc_mono = open(file_mono, "wb")
        doc_dual = open(file_dual, "wb")
        doc_mono.write(s_mono)
        doc_dual.write(s_dual)
        doc_mono.close()
        doc_dual.close()
        result_files.append((str(file_mono), str(file_dual)))

    return result_files


def download_remote_fonts(lang: str):
    lang = lang.lower()
    LANG_NAME_MAP = {
        **{la: "GoNotoKurrent-Regular.ttf" for la in noto_list},
        **{
            la: f"SourceHanSerif{region}-Regular.ttf"
            for region, langs in {
                "CN": ["zh-cn", "zh-hans", "zh"],
                "TW": ["zh-tw", "zh-hant"],
                "JP": ["ja"],
                "KR": ["ko"],
            }.items()
            for la in langs
        },
    }
    font_name = LANG_NAME_MAP.get(lang, "GoNotoKurrent-Regular.ttf")

    # docker
    font_path = ConfigManager.get("NOTO_FONT_PATH", Path("/app", font_name).as_posix())
    if not Path(font_path).exists():
        font_path, _ = get_font_and_metadata(font_name)
        font_path = font_path.as_posix()

    logger.info(f"use font: {font_path}")

    return font_path
