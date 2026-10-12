import type { JSX } from "react";
import { Icon } from "./Icons";
import type { Section } from "../state/useLibrary";

const ITEMS: { id: Section; label: string; ic: string }[] = [
  { id: "collections", label: "文献库", ic: "folder" },
  { id: "tags", label: "标签", ic: "tag" },
  { id: "recent", label: "最近", ic: "clock" },
  { id: "logs", label: "日志", ic: "log" }
];

export default function Rail({
  section,
  onChange,
  onSettings
}: {
  section: Section;
  onChange: (s: Section) => void;
  onSettings: () => void;
}): JSX.Element {
  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail-nav">
        {ITEMS.map((item, index) => (
          <div key={item.id} style={{ display: "contents" }}>
            {index === 3 && <div className="rail-divider" role="separator" aria-hidden="true" />}
            <button
              className={"rail-btn" + (section === item.id ? " is-active" : "")}
              title={item.label}
              onClick={() => onChange(item.id)}
            >
              <Icon name={item.ic} />
            </button>
          </div>
        ))}
      </div>
      <div className="rail-spacer" />
      <button className="rail-btn" title="设置" onClick={onSettings}>
        <Icon name="settings" />
      </button>
    </nav>
  );
}
