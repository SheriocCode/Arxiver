import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { AppConfig, AppInfo } from "../../shared/types";
import { IconDefs, Icon } from "./components/Icons";
import TitleBar from "./components/TitleBar";
import Rail from "./components/Rail";
import Sidebar from "./components/Sidebar";
import ListPane from "./components/ListPane";
import DetailPanel from "./components/DetailPanel";
import Viewer, { type ViewerHandle } from "./components/Viewer";
import SettingsView from "./components/SettingsView";
import NewItemModal from "./components/NewItemModal";
import LogsView from "./components/LogsView";
import { useLibrary, type Section } from "./state/useLibrary";
import { useSettings } from "./state/settings";
import type { ViewerStatus } from "./viewer/engine";

interface OpenDoc {
  id: string;
  name: string;
  activeKey: string;
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
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
  const viewerRef = useRef<ViewerHandle>(null);
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

  const loadDoc = useCallback(async (entry: OpenDoc) => {
    const data = await window.api.libraryOpen(entry.id);
    if (!data.bytes) { alert("源文件缺失"); return; }
    const sourceBytes = new Uint8Array(data.bytes);
    const doc = lib.documents.find((d) => d.id === entry.id);
    const key = entry.activeKey || (doc?.translations && doc.translations[0]?.cacheKey) || "";
    await lib.recordOpen(entry.id);
    setTimeout(async () => {
      await viewerRef.current?.openSource({ bytes: sourceBytes, name: data.name, sourceUrl: data.sourceUrl, docId: entry.id }, false);
      if (key) {
        const tb = await window.api.readTranslation(entry.id, key, "mono");
        if (tb && tb.length) { await viewerRef.current?.loadTranslation(new Uint8Array(tb), entry.id, key); }
      }
    }, 30);
  }, [lib]);

  const openDoc = useCallback((doc: { id: string; title: string; read: boolean; translations?: { cacheKey: string }[] }) => {
    if (!doc) { return; }
    if (!doc.read) { void lib.update(doc.id, { read: true }); }
    lib.select(doc.id);
    const key = (doc.translations && doc.translations[0]?.cacheKey) || "";
    const existing = docs.find((d) => d.id === doc.id);
    const entry: OpenDoc = existing ? { ...existing } : { id: doc.id, name: doc.title || "文档", activeKey: key };
    if (!existing) { setDocs((prev) => [...prev, entry]); }
    setActiveDocId(doc.id);
    setActiveTab("doc");
    void loadDoc(entry);
  }, [lib, docs, loadDoc]);

  const activateDoc = useCallback((id: string) => {
    const entry = docs.find((d) => d.id === id);
    if (!entry) { return; }
    lib.select(id);
    setActiveDocId(id);
    setActiveTab("doc");
    void loadDoc(entry);
  }, [docs, loadDoc, lib]);

  const closeDoc = useCallback((id: string) => {
    if (id !== activeDocId) { setDocs((prev) => prev.filter((d) => d.id !== id)); return; }
    const idx = docs.findIndex((d) => d.id === id);
    const next = docs.filter((d) => d.id !== id);
    setDocs(next);
    const neighbor = next[Math.min(idx, next.length - 1)] || null;
    if (neighbor) { lib.select(neighbor.id); setActiveDocId(neighbor.id); void loadDoc(neighbor); }
    else { setActiveDocId(""); setActiveTab("library"); viewerRef.current?.reset(); }
  }, [docs, activeDocId, loadDoc, lib]);

  const openDocById = useCallback((id: string) => {
    const doc = lib.documents.find((d) => d.id === id);
    if (doc) { openDoc(doc); }
  }, [lib, openDoc]);

  const selectTranslation = useCallback(async (key: string) => {
    setDocs((prev) => prev.map((d) => (d.id === activeDocId ? { ...d, activeKey: key } : d)));
    const tb = await window.api.readTranslation(activeDocId, key, "mono");
    if (tb && tb.length) { await viewerRef.current?.loadTranslation(new Uint8Array(tb), activeDocId, key); }
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
    if (target === activeDocId) { viewerRef.current?.goToPage(page); return; }
    const doc = lib.documents.find((d) => d.id === target);
    if (!doc) { return; }
    openDoc(doc);
    setTimeout(() => viewerRef.current?.goToPage(page), 800);
  }, [activeDocId, lib, openDoc]);

  const registeredKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!status || status.phase !== "done" || status.running || !status.cacheKey || !activeDocId) { return; }
    const key = status.cacheKey;
    if (registeredKeys.current.has(key)) { return; }
    registeredKeys.current.add(key);
    setDocs((prev) => prev.map((d) => (d.id === activeDocId ? { ...d, activeKey: key } : d)));
    void window.api.libraryAddTranslation(activeDocId, {
      cacheKey: key,
      target_lang: status.targetLang || config?.target_lang || "zh-CN",
      service: config?.translate_mode === "local" ? "local" : config?.service || "openai",
      model: config?.translate_mode === "local" ? "hy-mt" : config?.translate_model || "",
      output_variant: config?.output_variant || "dual",
      pages: status.pages || "",
      created_at: Date.now() / 1000,
      name: status.resultName
    }).then(() => lib.refresh());
  }, [status, activeDocId, config, lib]);

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

  const hasSource = !!status?.hasSource;
  const activeKey = docs.find((d) => d.id === activeDocId)?.activeKey || "";
  const currentDoc = lib.documents.find((d) => d.id === activeDocId);
  const translations = currentDoc?.translations || [];

  return (
    <>
      <IconDefs />
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
              <button className={"tb-tab" + (activeTab === "library" ? " active" : "")} onClick={() => setActiveTab("library")}>
                <Icon name="book" small /> 文库
              </button>
              {docs.map((d) => (
                <div key={d.id} className={"tb-tab" + (activeTab === "doc" && activeDocId === d.id ? " active" : "")} onClick={() => activateDoc(d.id)}>
                  <Icon name="file" small />
                  <span className="tb-tab-name">{d.name}</span>
                  <button className="tb-tab-close" title="关闭" onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}><Icon name="x" small /></button>
                </div>
              ))}
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
                <Viewer
                  ref={viewerRef}
                  config={config}
                  onStatus={setStatus}
                  onClose={closeReader}
                  translations={translations}
                  activeKey={activeKey}
                  onSelectTranslation={selectTranslation}
                  onAskSelection={askSelection}
                />
                {activeTab === "doc" && !hasSource && <div className="maybe-empty" />}
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
    </>
  );
}
