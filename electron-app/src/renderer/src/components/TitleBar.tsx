import { useEffect, useRef, useState, type JSX } from "react";
import { Icon } from "./Icons";
import type { Section } from "../state/useLibrary";

const SECTION_LABEL: Record<Section, string> = {
  collections: "文献库",
  tags: "标签",
  recent: "最近",
  overleaf: "Overleaf",
  logs: "日志"
};

const SECTION_ICON: Record<Section, string> = {
  collections: "folder",
  tags: "tag",
  recent: "clock",
  overleaf: "leaf",
  logs: "log"
};

export default function TitleBar({
  section,
  canBack,
  canForward,
  onBack,
  onForward,
  onToggleSidebar,
  onNavigate,
  onSettings,
  update,
  onUpdate,
  onMenuOpenChange
}: {
  section: Section;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onToggleSidebar: () => void;
  onNavigate: (s: Section) => void;
  onSettings: () => void;
  update?: { label: string; state: string } | null;
  onUpdate?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 嵌入式 Overleaf 页面是独立的 WebContentsView，会盖住渲染端的下拉菜单；
  // 菜单打开时让 App 暂时把网页视图藏起来。
  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
  }, [menuOpen, onMenuOpenChange]);

  useEffect(() => {
    if (!menuOpen) { return; }
    const onDoc = (e: MouseEvent): void => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenuOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div className="titlebar">
      <div className="tb-left">
        <button className="tb-btn" title="后退" disabled={!canBack} onClick={onBack}><Icon name="chev-left" small /></button>
        <button className="tb-btn" title="前进" disabled={!canForward} onClick={onForward}><Icon name="chev-right" small /></button>
        <button className="tb-btn" title="折叠/展开侧栏" onClick={onToggleSidebar}><Icon name="panel-left" small /></button>
        <div className="tb-menu" ref={menuRef}>
          <button className="tb-menu-btn" onClick={() => setMenuOpen((o) => !o)}>
            {SECTION_LABEL[section]} <Icon name="chev-down" small />
          </button>
          {menuOpen && (
            <div className="tb-dropdown">
              {(["collections", "tags", "recent", "overleaf", "logs"] as Section[]).map((s) => (
                <button key={s} className={section === s ? "is-active" : ""} onClick={() => { onNavigate(s); setMenuOpen(false); }}>
                  <Icon name={SECTION_ICON[s]} small />
                  {SECTION_LABEL[s]}
                </button>
              ))}
              <div className="tb-sep" />
              <button onClick={() => { onSettings(); setMenuOpen(false); }}><Icon name="settings" small /> 设置</button>
            </div>
          )}
        </div>
      </div>
      <div className="titlebar-drag" />
      {update && (
        <button className={"tb-update " + update.state} title="打开更新设置" onClick={onUpdate}>
          <Icon name="arrow-up" small /> {update.label}
        </button>
      )}
    </div>
  );
}
