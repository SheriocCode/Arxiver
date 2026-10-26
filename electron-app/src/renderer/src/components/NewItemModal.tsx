import { useEffect, useState, type JSX } from "react";
import type { LibraryDoc } from "../../../shared/types";

export default function NewItemModal({
  defaultCollection,
  onClose,
  onCreated,
  onImportFile
}: {
  defaultCollection: string;
  onClose: () => void;
  onCreated: (doc: LibraryDoc) => void;
  onImportFile: (collectionId: string) => Promise<void>;
}): JSX.Element {
  const [ident, setIdent] = useState("");
  const [identErr, setIdentErr] = useState("");
  const [importing, setImporting] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const busy = importing || fileBusy;

  // 下载 PDF / 解析元数据的阶段提示来自主进程
  useEffect(() => window.api.onLibraryProgress((p) => setProgress(p.done ? "" : p.text)), []);

  async function importIdent(): Promise<void> {
    const value = ident.trim();
    if (!value || busy) { return; }
    setImporting(true);
    setIdentErr("");
    setProgress("正在连接…");
    try {
      const res = await window.api.libraryImportByIdentifier(value, defaultCollection ? [defaultCollection] : []);
      if (!res.ok || !res.doc) { setIdentErr(res.error || "导入失败"); return; }
      onCreated(res.doc);
    } catch (e) {
      setIdentErr((e as Error)?.message || "导入失败");
    } finally {
      setImporting(false);
      setProgress("");
    }
  }

  async function importLocal(): Promise<void> {
    if (busy) { return; }
    setFileBusy(true);
    setProgress("正在读取 PDF…");
    try {
      await onImportFile(defaultCollection);
    } finally {
      setFileBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="modal-root" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <div className="modal" role="dialog" aria-label="新建文献">
        <div className="modal-head">
          <h2>新建文献</h2>
          <button className="icon-btn" title="关闭" onClick={onClose}><svg className="icon icon-sm" aria-hidden="true"><use href="#i-x" /></svg></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>
              按链接导入（arXiv / DOI）
              <span className="help" aria-hidden="true">?
                <span className="help-pop">
                  元信息取自 <b>arXiv</b> / <b>CrossRef</b> 官方接口（不是爬页面）。<br />
                  可粘贴：arXiv 链接、arXiv 编号（如 2401.12345）、DOI、或 https://doi.org/… 链接。<br />
                  arXiv 会顺带下载 PDF；DOI 只导入元信息（出版社 PDF 需订阅）。
                </span>
              </span>
            </label>
            <div className="ident-row">
              <input
                value={ident}
                autoFocus
                placeholder="粘贴 arXiv 链接 / 编号（如 2401.12345）/ DOI"
                onChange={(e) => { setIdent(e.target.value); if (identErr) { setIdentErr(""); } }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void importIdent(); } }}
              />
              <button type="button" className="btn btn-primary" disabled={busy || !ident.trim()} onClick={() => { void importIdent(); }}>
                {importing ? "导入中…" : "获取并导入"}
              </button>
            </div>
            {busy ? (
              <span className="import-note">
                <span className="spinner" />
                {progress || (importing ? "正在获取元信息…" : "正在导入 PDF…")}
              </span>
            ) : null}
            <span className={"error" + (identErr ? " is-on" : "")}>{identErr}</span>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" style={{ marginRight: "auto" }} disabled={busy} onClick={() => { void importLocal(); }}>
            <svg className="icon icon-sm" aria-hidden="true"><use href="#i-plus" /></svg> {fileBusy ? "导入中…" : "导入 PDF 文件…"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
