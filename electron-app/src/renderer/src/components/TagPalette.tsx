import type { JSX } from "react";
import type { LibraryApi } from "../state/useLibrary";
import { TAG_PRESETS } from "../state/tagColors";

/** 标签配色弹层（侧栏标签圆点 / 标签管理面板共用） */
export default function TagPalette({ lib, tag, x, y, onClose }: {
  lib: LibraryApi;
  tag: string;
  x: number;
  y: number;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="ctx-menu tag-palette" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="tag-palette-head">标签颜色 · {tag}</div>
      <div className="tag-swatches">
        {TAG_PRESETS.map((c) => (
          <button
            key={c}
            className={"tag-swatch" + (lib.tagColors[tag] === c ? " is-on" : "")}
            style={{ background: c }}
            title={c}
            onClick={() => { void lib.setTagColor(tag, c); onClose(); }}
          />
        ))}
      </div>
      <label className="tag-palette-custom">
        <span>自定义颜色</span>
        <input
          type="color"
          value={lib.tagColors[tag]?.startsWith("#") ? lib.tagColors[tag] : "#8a8a8a"}
          onChange={(e) => { void lib.setTagColor(tag, e.target.value); }}
        />
      </label>
      <button className="tag-palette-clear" onClick={() => { void lib.setTagColor(tag, ""); onClose(); }}>清除颜色</button>
    </div>
  );
}
