import { useMemo, type JSX } from "react";
import type { ReplaceCommand } from "../../../shared/overleaf-replace";
import { buildFlexibleRegex } from "../../../shared/overleaf-replace";
import { Icon } from "./Icons";

interface Props {
  command: ReplaceCommand;
  fileContent?: string;
  applying?: boolean;
  cjkWarning?: string;
  onApply: (command: ReplaceCommand) => void;
  onReject: (command: ReplaceCommand) => void;
  onUndo: (command: ReplaceCommand) => void;
  onPreview: (command: ReplaceCommand) => void;
}

function oneLine(value: string, max = 160): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function inspectMatch(content: string, search: string, isRegex: boolean): { valid: boolean; matchCount: number; error?: string } {
  try {
    const regex = isRegex ? new RegExp(search, "g") : buildFlexibleRegex(search);
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      count++;
      if (!match[0].length) { regex.lastIndex++; }
    }
    if (!count) { return { valid: false, matchCount: 0, error: "当前文件里没有找到匹配内容" }; }
    if (count > 10) { return { valid: false, matchCount: count, error: `匹配次数过多（${count} 次）` }; }
    return { valid: true, matchCount: count };
  } catch (error) {
    return { valid: false, matchCount: 0, error: error instanceof Error ? error.message : "匹配校验失败" };
  }
}

export default function OverleafEditBlock({
  command, fileContent, applying, cjkWarning, onApply, onReject, onUndo, onPreview
}: Props): JSX.Element {
  const isCreate = command.commandType === "create";
  const isInsert = command.commandType === "insert";
  const pending = command.status === "pending";
  const applied = command.status === "applied" || command.status === "accepted";
  const rejected = command.status === "rejected";
  const failed = command.status === "error";

  const match = useMemo(() => {
    if (isCreate || command.status !== "pending" || typeof fileContent !== "string") { return null; }
    return inspectMatch(fileContent, command.search, command.isRegex);
  }, [isCreate, command.status, command.search, command.isRegex, fileContent]);

  const canApply = isCreate || (match?.valid ?? true);

  return (
    <div className={"ov-edit" + (applied ? " is-applied" : rejected ? " is-rejected" : failed ? " is-error" : "")}>
      <div className="ov-edit-head">
        <Icon name={isCreate ? "plus" : "file"} small />
        <span className="ov-edit-file" title={command.file}>{command.file}</span>
        <span className="ov-edit-kind">
          {isCreate ? "新建" : isInsert ? "插入" : "替换"}
          {command.isRegex ? " · 正则" : ""}
        </span>
        {match ? <span className={"ov-edit-match" + (match.valid ? "" : " is-bad")}>{match.matchCount} 处</span> : null}
        <span className="ov-edit-state">
          {applied ? "已应用" : rejected ? "已拒绝" : failed ? "错误" : "待确认"}
        </span>
      </div>

      <div className="ov-edit-body">
        {isCreate ? (
          <pre className="ov-edit-new">{command.replace || "(空文件)"}</pre>
        ) : isInsert ? (
          <>
            {command.insertAnchor?.after ? (
              <div className="ov-edit-row">
                <span className="ov-edit-tag">AFTER</span>
                <pre className="ov-edit-anchor">{oneLine(command.insertAnchor.after, 400)}</pre>
              </div>
            ) : null}
            {command.insertAnchor?.before ? (
              <div className="ov-edit-row">
                <span className="ov-edit-tag">BEFORE</span>
                <pre className="ov-edit-anchor">{oneLine(command.insertAnchor.before, 400)}</pre>
              </div>
            ) : null}
            <pre className="ov-edit-new">{command.replace || "(空)"}</pre>
          </>
        ) : (
          <>
            <pre className="ov-edit-old">{command.search}</pre>
            <pre className="ov-edit-new">{command.replace || "(删除)"}</pre>
          </>
        )}
        {cjkWarning ? <div className="ov-edit-warning">{cjkWarning}</div> : null}
        {command.errorMessage ? <div className="ov-edit-error">{command.errorMessage}</div> : null}
        {match && !match.valid ? <div className="ov-edit-error">{match.error}</div> : null}
      </div>

      <div className="ov-edit-actions">
        {pending ? (
          <>
            {!isCreate ? (
              <button type="button" className="btn btn-ghost" disabled={applying} onClick={() => onPreview(command)}>
                <Icon name="search" small /> 定位
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" disabled={applying} onClick={() => onReject(command)}>
              <Icon name="x" small /> 拒绝
            </button>
            <button type="button" className="btn btn-primary" disabled={applying || !canApply} onClick={() => onApply(command)}>
              <Icon name="check" small /> {applying ? "处理中…" : isCreate ? "创建" : "应用"}
            </button>
          </>
        ) : applied ? (
          <>
            <span className="ov-edit-note">修改已写入 Overleaf，可在编辑器里继续调整。</span>
            {!isCreate ? (
              <button type="button" className="btn btn-ghost" disabled={applying} onClick={() => onUndo(command)}>
                <Icon name="rotate-left" small /> 撤销应用
              </button>
            ) : null}
          </>
        ) : rejected ? (
          <button type="button" className="btn btn-ghost" disabled={applying} onClick={() => onUndo(command)}>
            <Icon name="rotate-left" small /> 恢复为候选
          </button>
        ) : (
          <span className="ov-edit-note">该修改块已失效。</span>
        )}
      </div>
    </div>
  );
}
