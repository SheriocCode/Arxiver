import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { AppConfig, AppInfo } from "../../shared/types";
import { IconDefs, Icon } from "./components/Icons";
import AppBackground from "./components/AppBackground";
import TitleBar from "./components/TitleBar";
import Rail from "./components/Rail";
import Sidebar from "./components/Sidebar";
import ListPane from "./components/ListPane";
import DetailPanel from "./components/DetailPanel";
import Viewer, { type ViewerHandle } from "./components/Viewer";
import SettingsView from "./components/SettingsView";
import NewItemModal from "./components/NewItemModal";
import LogsView from "./components/LogsView";
import SplashScreen from "./components/SplashScreen";
import { useLibrary, type Section } from "./state/useLibrary";
import { useSettings } from "./state/settings";
import type { TranslationDoneInfo } from "./viewer/engine";

interface OpenDoc {
  id: string;
  name: string;
  activeKey: string;
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "doc">("library");
  const [docs, setDocs] = useState<OpenDoc[]>([]);
  const [activeDocId, setActiveDocId] = useState("");
  const [aiSelection, setAiSelection] = useState<{ text: string; page: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [logCat, setLogCat] = useState("tlog");
  const [logStatus, setLogStatus] = useState("all");
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabListOpen, setTabListOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const viewerRefs = useRef<Map<string, ViewerHandle>>(new Map());
  const lib = useLibrary();
  const { settings, update: updateSettings } = useSettings();
  const libRef = useRef(lib);
  libRef.current = lib;
  useEffect(() => {
    const off = window.api.onAgentEvent((e) => { if (e.type === "library_changed") { void libRef.current.refresh(); } });
    return off;
  }, []);

  const histRef = useRef<Section[]>(["collections"]);
  const [histIdx, setHistIdx] = useState(0);
  const navigate = useCallback((s: Section) => {
    lib.setSection(s);
    if (s === "tags") {
      const first = Object.keys(lib.tagCounts).sort()[0];
      if (first) { lib.setTag(first); lib.setCollId("all"); }
    } else {
      if (lib.tag) { lib.setTag(""); }
      if (s === "collections") { lib.setCollId("all"); }
    }
    const h = histRef.current.slice(0, histIdx + 1);
    if (h[h.length - 1] !== s) { h.push(s); }
    histRef.current = h;
    setHistIdx(h.length - 1);
  }, [lib, histIdx]);
  const goBack = useCallback(() => {
    setHistIdx((i) => { const ni = Math.max(0, i - 1); lib.setSection(histRef.current[ni]); return ni; });
  }, [lib]);
  const goForward = useCallback(() => {
    setHistIdx((i) => { const ni = Math.min(histRef.current.length - 1, i + 1); lib.setSection(histRef.current[ni]); return ni; });
  }, [lib]);

  useEffect(() => {
    void (async () => {
      setConfig(await window.api.getConfig());
      setInfo(await window.api.appInfo());
    })();
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--detail-w", detailOpen ? "372px" : "0px");
  }, [detailOpen]);

  useEffect(() => {
    lib.setTab(settings.defaultTab);
    // apply the default tab only on mount / when the setting changes, not on every doc switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.defaultTab]);

  // Tabs shrink to a minimum width, then the strip clips and an "all tabs" button appears.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) { return; }
    const update = (): void => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setTabsOverflow(overflow);
      if (!overflow) { setTabListOpen(false); }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [docs]);

  // Keep the active tab in view within the clipped strip.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) { return; }
    const tab = el.querySelector<HTMLElement>(".tb-tab.active");
    if (!tab) { return; }
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < el.scrollLeft) { el.scrollLeft = left; }
    else if (right > el.scrollLeft + el.clientWidth) { el.scrollLeft = right - el.clientWidth; }
  }, [activeDocId, activeTab, docs]);

  // Close the tab list when clicking outside it.
  useEffect(() => {
    if (!tabListOpen) { return; }
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) { setTabListOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [tabListOpen]);

  // Each open document owns its own mounted viewer (see the render below), so opening
  // a tab just adds it; the viewer loads its own source and translation.
  const openDoc = useCallback((doc: { id: string; title: string; read: boolean; translations?: { cacheKey: string }[] }) => {
    if (!doc) { return; }
    if (!doc.read) { void lib.update(doc.id, { read: true }); }
    lib.select(doc.id);
    const key = (doc.translations && doc.translations[0]?.cacheKey) || "";
    setDocs((prev) => (prev.find((d) => d.id === doc.id) ? prev : [...prev, { id: doc.id, name: doc.title || "文档", activeKey: key }]));
    setActiveDocId(doc.id);
    setActiveTab("doc");
    void lib.recordOpen(doc.id);
  }, [lib]);

  const activateDoc = useCallback((id: string) => {
    lib.select(id);
    setActiveDocId(id);
    setActiveTab("doc");
    void lib.recordOpen(id);
  }, [lib]);

  const closeDoc = useCallback((id: string) => {
    viewerRefs.current.delete(id);
    const remaining = docs.filter((d) => d.id !== id);
    setDocs(remaining);
    if (id !== activeDocId) { return; }
    const idx = docs.findIndex((d) => d.id === id);
    const neighbor = remaining[Math.min(idx, remaining.length - 1)] || null;
    if (neighbor) { lib.select(neighbor.id); setActiveDocId(neighbor.id); void lib.recordOpen(neighbor.id); }
    else { setActiveDocId(""); setActiveTab("library"); }
  }, [docs, activeDocId, lib]);

  const openDocById = useCallback((id: string) => {
    const doc = lib.documents.find((d) => d.id === id);
    if (doc) { openDoc(doc); }
  }, [lib, openDoc]);

  const selectTranslation = useCallback((key: string) => {
    setDocs((prev) => prev.map((d) => (d.id === activeDocId ? { ...d, activeKey: key } : d)));
  }, [activeDocId]);

  const askSelection = useCallback((text: string, page: number) => {
    if (!activeDocId) { return; }
    lib.select(activeDocId);
    lib.setTab("ai");
    setDetailOpen(true);
    setAiSelection({ text, page });
  }, [activeDocId, lib]);

  const citeJump = useCallback((docId: string, page: number) => {
    const target = docId || activeDocId;
    if (!target) { return; }
    if (target === activeDocId) { viewerRefs.current.get(target)?.goToPage(page); return; }
    const doc = lib.documents.find((d) => d.id === target);
    if (!doc) { return; }
    openDoc(doc);
    let tries = 0;
    const tryJump = (): void => {
      const v = viewerRefs.current.get(target);
      if (v) { v.goToPage(page); return; }
      if (tries++ < 12) { window.setTimeout(tryJump, 150); }
    };
    window.setTimeout(tryJump, 150);
  }, [activeDocId, lib, openDoc]);

  // Fires when any document's translation finishes, even one that is not currently
  // displayed, so its result still gets registered in the library.
  const onTranslationDone = useCallback((info: TranslationDoneInfo) => {
    const p = info.params;
    setDocs((prev) => prev.map((d) => (d.id === info.docId ? { ...d, activeKey: info.cacheKey } : d)));
    void window.api.libraryAddTranslation(info.docId, {
      cacheKey: info.cacheKey,
      target_lang: p.target_lang || "zh-CN",
      service: p.service || "openai",
      model: p.model || "",
      output_variant: p.output_variant || "dual",
      pages: p.pages || "",
      created_at: Date.now() / 1000,
      name: info.resultName
    }).then(() => lib.refresh());
  }, [lib]);

  const importFile = useCallback(async () => {
    const picked = await window.api.pickFile();
    if (!picked) { return; }
    const doc = await window.api.libraryAdd({ filePath: picked.filePath, name: picked.name });
    await lib.refresh();
    lib.select(doc.id);
    setNewOpen(false);
  }, [lib]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      document.documentElement.style.setProperty("--sidebar-w", next ? "0px" : "268px");
      return next;
    });
  }, []);

  const closeReader = useCallback(() => { if (activeDocId) { closeDoc(activeDocId); } }, [activeDocId, closeDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (e.key === "/" && !/input|textarea|select/.test(tag)) {
        e.preventDefault();
        (document.querySelector(".side-search input") as HTMLInputElement | null)?.focus();
      }
      if (e.key === "Escape") {
        if (settingsOpen) { setSettingsOpen(false); }
        else if (newOpen) { setNewOpen(false); }
        else if (activeTab === "doc") { setActiveTab("library"); }
        else if (lib.section === "logs") { lib.setSection("collections"); }
        else { setDetailOpen(false); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, newOpen, activeTab, lib, closeReader]);

  return (
    <>
      <IconDefs />
      {settings.backgroundEnabled && settings.backgroundFile && <AppBackground file={settings.backgroundFile} />}
      <div className="window">
        <TitleBar
          section={lib.section}
          canBack={histIdx > 0}
          canForward={histIdx < histRef.current.length - 1}
          onBack={goBack}
          onForward={goForward}
          onToggleSidebar={toggleSidebar}
          onNavigate={navigate}
          onSettings={() => setSettingsOpen(true)}
        />
        <div className={"app" + (detailOpen ? " detail-open" : "") + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
          <Rail section={lib.section} onChange={navigate} onSettings={() => setSettingsOpen(true)} />
          <Sidebar
            lib={lib}
            onOpenDoc={openDocById}
            showCounts={settings.showCounts}
            logCat={logCat}
            setLogCat={setLogCat}
            logStatus={logStatus}
            setLogStatus={setLogStatus}
          />

          <div className="main-area">
            <div className="tabbar">
              <button className={"tb-tab tb-tab-lib" + (activeTab === "library" ? " active" : "")} onClick={() => setActiveTab("library")}>
                <Icon name="book" small /> 文库
              </button>
              <div className="tb-strip" ref={stripRef}>
                {docs.map((d) => (
                  <div key={d.id} className={"tb-tab" + (activeTab === "doc" && activeDocId === d.id ? " active" : "")} onClick={() => activateDoc(d.id)}>
                    <Icon name="file" small />
                    <span className="tb-tab-name">{d.name}</span>
                    <button className="tb-tab-close" title="关闭" onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}><Icon name="x" small /></button>
                  </div>
                ))}
              </div>
              <div className={"tb-more-wrap" + (tabsOverflow ? "" : " is-hidden")} ref={moreRef}>
                <button className={"tb-more" + (tabListOpen ? " active" : "")} title="所有标签页" onClick={() => setTabListOpen((o) => !o)}>
                  <Icon name="chev-down" small />
                </button>
                {tabListOpen && (
                  <div className="tb-list">
                    {docs.map((d) => (
                      <div key={d.id} className={"tb-list-item" + (activeTab === "doc" && activeDocId === d.id ? " active" : "")} onClick={() => { activateDoc(d.id); setTabListOpen(false); }}>
                        <Icon name="file" small />
                        <span className="tb-tab-name">{d.name}</span>
                        <button className="tb-tab-close" title="关闭" onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}><Icon name="x" small /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="tb-tabs-right">
                {detailOpen && lib.selected &&
                  ([["info", "file", "信息"], ["notes", "note", "笔记"], ["tags", "tag", "标签"], ["ai", "arxiver", "Arxiver"]] as const)
                    .filter(([id]) => id !== "ai" || settings.aiEnabled)
                    .map(([id, ic, label]) => (
                      <button key={id} className={"tb-viewtab" + (lib.tab === id ? " active" : "")} onClick={() => { lib.setTab(id); lib.setEditMode(false); }}>
                        <Icon name={ic} small /> {label}
                      </button>
                    ))}
                <button
                  className="tb-viewtab tb-detail-toggle"
                  title={detailOpen ? "收起详情面板" : "展开详情面板"}
                  onClick={() => setDetailOpen((o) => !o)}
                >
                  <Icon name={detailOpen ? "chev-right" : "chev-left"} small />
                </button>
              </div>
            </div>
            <div className="main-body">
              <ListPane
                lib={lib}
                onAddDocument={() => setNewOpen(true)}
                showUnread={settings.showUnread}
                onOpenDoc={openDocById}
              />
              <DetailPanel
                lib={lib}
                onOpen={openDoc}
                settings={settings}
                aiSelection={aiSelection}
                onCite={citeJump}
                onClearSelection={() => setAiSelection(null)}
                openDocs={docs.map((d) => ({ id: d.id, name: d.name }))}
              />
              {lib.section === "logs" && <LogsView logKey={logCat} logStatus={logStatus} onClose={() => lib.setSection("collections")} />}
              <div className="reader-overlay" hidden={activeTab !== "doc"}>
                {docs.map((d) => (
                  <Viewer
                    key={d.id}
                    ref={(h) => { if (h) { viewerRefs.current.set(d.id, h); } else { viewerRefs.current.delete(d.id); } }}
                    docId={d.id}
                    visible={activeDocId === d.id}
                    config={config}
                    onClose={closeReader}
                    translations={lib.documents.find((x) => x.id === d.id)?.translations || []}
                    activeKey={d.activeKey}
                    showBlocksTranslating={settings.showBlocksTranslating}
                    showBlocksTranslation={settings.showBlocksTranslation}
                    onSelectTranslation={selectTranslation}
                    onAskSelection={askSelection}
                    onTranslationDone={onTranslationDone}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {settingsOpen && (
        <SettingsView
          config={config}
          info={info}
          settings={settings}
          updateSettings={updateSettings}
          onSaved={setConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {newOpen && (
        <NewItemModal
          collections={lib.collections}
          defaultCollection={["all", "recent", "unfiled", "duplicates", "trash"].includes(lib.collId) ? "" : lib.collId}
          onClose={() => setNewOpen(false)}
          onImportFile={importFile}
          onCreated={async (doc) => { await lib.refresh(); lib.select(doc.id); setNewOpen(false); }}
        />
      )}

      {settings.splashEnabled && <SplashScreen />}
    </>
  );
}
