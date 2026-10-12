import { useState, type JSX } from "react";
import type { LibraryCollection, LibraryDoc } from "../../../shared/types";

export default function NewItemModal({
  collections,
  defaultCollection,
  onClose,
  onCreated,
  onImportFile
}: {
  collections: LibraryCollection[];
  defaultCollection: string;
  onClose: () => void;
  onCreated: (doc: LibraryDoc) => void;
  onImportFile: (collectionId: string) => void;
}): JSX.Element {
  const [form, setForm] = useState({ title: "", authors: "", year: "", venue: "", type: "会议论文", tags: "" });
  const [coll, setColl] = useState(defaultCollection);
  const [invalid, setInvalid] = useState(false);
  const [ident, setIdent] = useState("");
  const [identErr, setIdentErr] = useState("");
  const [importing, setImporting] = useState(false);

  async function importIdent(): Promise<void> {
    const value = ident.trim();
    if (!value || importing) { return; }
    setImporting(true);
    setIdentErr("");
    const res = await window.api.libraryImportByIdentifier(value, coll ? [coll] : []);
    setImporting(false);
    if (!res.ok || !res.doc) { setIdentErr(res.error || "导入失败"); return; }
    onCreated(res.doc);
  }
  const set = (k: keyof typeof form, v: string): void => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === "title") { setInvalid(false); }
  };

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const title = form.title.trim();
    if (!title) { setInvalid(true); return; }
    const tags = form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const doc = await window.api.libraryAddManual({
      title,
      authors: form.authors.trim() || "未署名",
      year: form.year.trim() || String(new Date().getFullYear()),
      venue: form.venue.trim() || "未填写来源",
      type: form.type,
      tags,
      collections: coll ? [coll] : [],
      summary: "手动添加的条目：" + title,
      abstract: ""
    });
    onCreated(doc);
  }

  return (
    <div className="modal-root" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <div className="modal" role="dialog" aria-label="新建文献">
        <div className="modal-head">
          <h2>新建文献</h2>
          <button className="icon-btn" title="关闭" onClick={onClose}><svg className="icon icon-sm" aria-hidden="true"><use href="#i-x" /></svg></button>
        </div>
        <form onSubmit={submit}>
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
                  placeholder="粘贴 arXiv 链接 / 编号（如 2401.12345）/ DOI"
                  onChange={(e) => { setIdent(e.target.value); if (identErr) { setIdentErr(""); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void importIdent(); } }}
                />
                <button type="button" className="btn btn-primary" disabled={importing || !ident.trim()} onClick={() => { void importIdent(); }}>
                  {importing ? "获取中…" : "获取并导入"}
                </button>
              </div>
              <span className={"error" + (identErr ? " is-on" : "")}>{identErr}</span>
            </div>
            <div className="ident-sep" />
            <div className={"field" + (invalid ? " invalid" : "")}>
              <label>标题 <span className="req">*</span></label>
              <input value={form.title} autoFocus onChange={(e) => set("title", e.target.value)} />
              <span className="error">请填写标题</span>
            </div>
            <div className="field-row">
              <div className="field"><label>作者</label><input value={form.authors} onChange={(e) => set("authors", e.target.value)} /></div>
              <div className="field"><label>年份</label><input value={form.year} onChange={(e) => set("year", e.target.value)} /></div>
            </div>
            <div className="field-row">
              <div className="field"><label>来源 / 期刊</label><input value={form.venue} onChange={(e) => set("venue", e.target.value)} /></div>
              <div className="field">
                <label>类型</label>
                <select value={form.type} onChange={(e) => set("type", e.target.value)}>
                  <option>会议论文</option><option>期刊论文</option><option>预印本</option><option>学位论文</option><option>文档</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>分类</label>
              <select value={coll} onChange={(e) => setColl(e.target.value)}>
                <option value="">未分类</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>标签</label>
              <input value={form.tags} placeholder="用逗号分隔，如：Transformer, 注意力" onChange={(e) => set("tags", e.target.value)} />
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" style={{ marginRight: "auto" }} onClick={() => onImportFile(coll)}>
              <svg className="icon icon-sm" aria-hidden="true"><use href="#i-plus" /></svg> 导入 PDF 文件…
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary"><svg className="icon icon-sm" aria-hidden="true"><use href="#i-check" /></svg> 创建条目</button>
          </div>
        </form>
      </div>
    </div>
  );
}
