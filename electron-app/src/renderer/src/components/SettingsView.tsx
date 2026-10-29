import { useCallback, useEffect, useState, type JSX } from "react";
import type { AiConnection, AiConnectionTestResult, AppConfig, AppInfo, LocalModelInfo, LocalModelProgress, LocalModelStatus, ModelSourceTest, UpdateStatus } from "../../../shared/types";
import { translationConnection } from "../../../shared/ai";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";
import { ACCENTS, PAGE_THEMES, type AppSettings } from "../state/settings";
import { Markdown } from "../lib/markdown";
import SystemPanel from "./SystemPanel";

const SECTIONS = [
  { id: "model", name: "翻译", icon: "settings" },
  { id: "ai", name: "AI 服务", icon: "message" },
  { id: "models", name: "本地模型", icon: "layers" },
  { id: "general", name: "通用", icon: "settings" },
  { id: "appearance", name: "外观", icon: "sparkle" },
  { id: "shortcuts", name: "快捷键", icon: "terminal" },
  { id: "runtime", name: "运行状态", icon: "chart" },
  { id: "about", name: "关于", icon: "book" }
];

export default function SettingsView({
  config,
  info,
  settings,
  updateSettings,
  onSaved,
  onClose,
  initialSection
}: {
  config: AppConfig | null;
  info: AppInfo | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onSaved: (c: AppConfig) => void;
  onClose: () => void;
  initialSection?: string;
}): JSX.Element {
  const [section, setSection] = useState(initialSection || "model");
  const [form, setForm] = useState<Partial<AppConfig>>({});
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null);
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [modelProgress, setModelProgress] = useState<Record<string, LocalModelProgress>>({});
  const [sourceChoice, setSourceChoice] = useState<Record<string, string>>(() => settings.modelSources || {});
  const [sourceTests, setSourceTests] = useState<Record<string, ModelSourceTest & { loading?: boolean }>>({});
  const [sourceOpen, setSourceOpen] = useState<Record<string, boolean>>({});
  const [connTests, setConnTests] = useState<Record<string, AiConnectionTestResult & { loading?: boolean }>>({});
  const [newConnId, setNewConnId] = useState("");
  const loadModels = useCallback(() => { void window.api.modelsList().then(setModels); }, []);

  // 新增连接后滚到卡片并聚焦名称，多个连接时不会“加了但看不见”。
  useEffect(() => {
    if (!newConnId) { return; }
    const input = document.querySelector<HTMLInputElement>(`[data-conn-id="${newConnId}"] .ai-conn-name`);
    input?.scrollIntoView({ block: "nearest" });
    input?.focus();
    setNewConnId("");
  }, [newConnId]);

  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdate);
    return window.api.onUpdateStatus((s) => setUpdate(s));
  }, []);

  useEffect(() => {
    if (section === "model") {
      void window.api.localStatus().then(setLocalStatus);
      loadModels();
    }
    if (section !== "models") { return; }
    // 用户可能在文件管理器里直接删模型；停留在本页时定时重新检测，
    // 不要一直显示“已安装”。
    const refresh = (): void => {
      loadModels();
      void window.api.localStatus().then(setLocalStatus);
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [section, loadModels]);

  useEffect(() => {
    return window.api.onModelProgress((p) => {
      setModelProgress((prev) => ({ ...prev, [p.id]: p }));
      if (p.state === "done" || p.state === "error" || p.state === "cancelled") {
        loadModels();
        void window.api.localStatus().then(setLocalStatus);
      }
    });
  }, [loadModels]);

  function updateText(u: UpdateStatus | null): string {
    if (!u) { return ""; }
    switch (u.state) {
      case "unsupported": return "开发模式不支持自动更新";
      case "checking": return "正在检查更新…";
      case "available": return `发现新版本 ${u.version}，可下载`;
      case "none": return "已是最新版本";
      case "downloading": return `正在下载… ${u.percent || 0}%`;
      case "ready": return `新版本 ${u.version} 已就绪，重启安装`;
      case "error": return `更新失败：${u.error || ""}`;
      default: return "";
    }
  }

  useEffect(() => {
    if (config) {
      setForm({
        ...config,
        ai_connections: (config.ai_connections || []).map((item) => ({ ...item }))
      });
      setConnTests({});
    }
  }, [config]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setHint("");
  };
  const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  // config 里的字段都由底部保存；其他设置项是即时保存的。
  const configSection = section === "model" || section === "ai";
  const dirty = !!(config && form.ai_connections && JSON.stringify(form) !== JSON.stringify(config));
  const showFooter = configSection || dirty;
  const connections = form.ai_connections || [];
  const translationConn = translationConnection(form);
  const searchProvider: AppConfig["search_provider"] =
    form.search_provider === "bocha" ? "bocha" : form.search_provider === "deepseek" ? "deepseek" : "tavily";
  const translationChoice = (form.translate_mode || "local") === "local"
    ? "local"
    : (translationConn?.id || "unconfigured");
  const searchChoice = !form.search_enabled ? "off" : searchProvider;
  const inputStyle = { height: 34, minWidth: 240, background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", color: "var(--text)", padding: "0 10px", outline: "none" } as const;

  function connectionReady(connection?: AiConnection): boolean {
    return !!(connection && String(connection.baseUrl || "").trim() && String(connection.apiKey || "").trim() && String(connection.model || "").trim());
  }

  function connectionLabel(connection: AiConnection): string {
    return `${connection.name} · ${String(connection.model || "").trim() || "未设置模型"}`;
  }

  function connectionMissing(connection?: AiConnection): string {
    if (!connection) { return "连接"; }
    return [
      !String(connection.baseUrl || "").trim() ? "接口地址" : "",
      !String(connection.apiKey || "").trim() ? "API Key" : "",
      !String(connection.model || "").trim() ? "模型" : ""
    ].filter(Boolean).join("、") || "配置";
  }

  function connectionStatus(connection: AiConnection): string {
    const missing = [
      !String(connection.baseUrl || "").trim() ? "地址" : "",
      !String(connection.apiKey || "").trim() ? "Key" : "",
      !String(connection.model || "").trim() ? "模型" : ""
    ].filter(Boolean);
    return missing.length ? `缺 ${missing.join(" / ")}` : "";
  }

  function updateConnection(id: string, patch: Partial<AiConnection>): void {
    setForm((f) => ({
      ...f,
      ai_connections: (f.ai_connections || []).map((item) => (item.id === id ? { ...item, ...patch } : item))
    }));
    setHint("");
    setConnTests((prev) => {
      if (!prev[id]) { return prev; }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function addConnection(): void {
    const id = "custom-" + Date.now().toString(36);
    setForm((f) => ({
      ...f,
      ai_connections: [
        ...(f.ai_connections || []),
        { id, name: "自定义接口", baseUrl: "", apiKey: "", model: "" }
      ]
    }));
    setHint("");
    setNewConnId(id);
  }

  function removeConnection(id: string): void {
    setForm((f) => {
      const list = (f.ai_connections || []).filter((item) => item.id !== id);
      if (!list.length) { return f; }
      const fallback = list[0].id;
      const keep = (value?: string): string => (!value || value === id ? fallback : value);
      return {
        ...f,
        ai_connections: list,
        translate_connection: keep(f.translate_connection),
        chat_connection: keep(f.chat_connection),
        // 留空表示跟随文献助手
        overleaf_connection: f.overleaf_connection === id ? "" : f.overleaf_connection
      };
    });
    setHint("");
  }

  async function testConnection(id: string): Promise<void> {
    const connection = connections.find((item) => item.id === id);
    setConnTests((prev) => ({ ...prev, [id]: { ok: false, message: "", loading: true } }));
    try {
      const result = await window.api.aiTestConnection({
        baseUrl: connection?.baseUrl || "",
        apiKey: connection?.apiKey || ""
      });
      setConnTests((prev) => ({ ...prev, [id]: result }));
    } catch (error) {
      setConnTests((prev) => ({
        ...prev,
        [id]: { ok: false, message: (error as Error)?.message || String(error) }
      }));
    }
  }

  function fmtSize(n: number): string {
    if (!n) { return "0 B"; }
    if (n >= 1024 ** 3) { return (n / 1024 ** 3).toFixed(2) + " GB"; }
    if (n >= 1024 ** 2) { return Math.round(n / 1024 ** 2) + " MB"; }
    return Math.round(n / 1024) + " KB";
  }

  function modelStatus(id: LocalModelInfo["id"]): LocalModelInfo | undefined {
    return models.find((m) => m.id === id);
  }

  function chooseSource(id: string, url: string): void {
    setSourceChoice((prev) => {
      const next = { ...prev, [id]: url };
      updateSettings({ modelSources: next });
      return next;
    });
  }

  function fmtSpeed(bps: number): string {
    if (!bps) { return "-"; }
    if (bps >= 1024 * 1024) { return (bps / 1024 / 1024).toFixed(1) + " MB/s"; }
    return Math.max(1, Math.round(bps / 1024)) + " KB/s";
  }

  function shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch { return url; }
  }

  async function testSource(url: string): Promise<void> {
    setSourceTests((prev) => ({ ...prev, [url]: { ok: false, latencyMs: 0, speedBps: 0, bytes: 0, loading: true } }));
    try {
      const res = await window.api.modelTestSource(url);
      setSourceTests((prev) => ({ ...prev, [url]: res }));
    } catch (err) {
      setSourceTests((prev) => ({ ...prev, [url]: { ok: false, latencyMs: 0, speedBps: 0, bytes: 0, error: err instanceof Error ? err.message : String(err) } }));
    }
  }

  async function testAllSources(m: LocalModelInfo): Promise<void> {
    await Promise.all(m.sources.map((s) => testSource(s.url)));
  }

  async function removeModel(id: LocalModelInfo["id"]): Promise<void> {
    await window.api.modelRemove(id);
    loadModels();
    void window.api.localStatus().then(setLocalStatus);
  }

  async function save(): Promise<void> {
    if (saving) { return; }
    setSaving(true);
    try {
      const saved = await window.api.setConfig(form);
      onSaved(saved);
      setHint("已保存");
      setTimeout(() => setHint(""), 2000);
    } catch (error) {
      setHint("保存失败：" + ((error as Error)?.message || String(error)));
    } finally {
      setSaving(false);
    }
  }

  function requestClose(): void {
    if (dirty && !window.confirm("有未保存的设置，确定关闭吗？")) { return; }
    onClose();
  }

  async function pickBackground(): Promise<void> {
    const picked = await window.api.backgroundPick();
    if (!picked) { return; }
    updateSettings({ backgroundFile: picked.name, backgroundEnabled: true });
  }

  async function clearBackground(): Promise<void> {
    await window.api.backgroundClear();
    updateSettings({ backgroundFile: "", backgroundEnabled: false });
  }

  return (
    <div className="modal-root" onMouseDown={(e) => { if (e.target === e.currentTarget) { requestClose(); } }}>
      <div className="settings-modal" role="dialog" aria-label="设置">
        <div className="settings-side">
          <img className="settings-logo" src="icons/wordmark.svg" alt="Arxiver" />
          <div className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={section === s.id ? "is-active" : ""} onClick={() => setSection(s.id)}>
                <Icon name={s.icon} small /><span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="settings-main">
          <div className="settings-head">
            <h2>{cur.name}</h2>
            <button className="icon-btn" title="关闭" onClick={requestClose}><Icon name="x" small /></button>
          </div>
          <div className="settings-body">
            {section === "model" && (
              <>
                <Group title="翻译方式">
                  <Row
                    label="翻译方式"
                    desc={(form.translate_mode || "local") === "remote"
                      ? translationConn
                        ? connectionReady(translationConn)
                          ? "使用 AI 服务里已配置的连接和模型"
                          : "当前连接不可用，请先补全配置"
                        : "还没有可用的 AI 连接"
                      : connections.length
                        ? "本地模型离线运行，不产生费用、不需要 API Key"
                        : "本地模型离线运行；在线翻译需先在 AI 服务配置连接"}
                  >
                    <select
                      value={translationChoice}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "local") {
                          set("translate_mode", "local");
                        } else if (value !== "unconfigured") {
                          setForm((f) => ({ ...f, translate_mode: "remote", translate_connection: value }));
                        }
                      }}
                    >
                      <option value="local">本地模型（HY-MT）</option>
                      {connections.map((item) => <option key={item.id} value={item.id}>{connectionLabel(item)}</option>)}
                      {translationChoice === "unconfigured" ? <option value="unconfigured" disabled>AI 连接未配置</option> : null}
                    </select>
                  </Row>
                  {(form.translate_mode || "local") === "remote" && !connectionReady(translationConn) ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f0857b", fontSize: 12, padding: "2px 0 6px" }}>
                      <span style={{ flex: 1 }}>
                        {translationConn ? `「${translationConn.name}」还缺 ${connectionMissing(translationConn)}。` : "还没有可用的 AI 连接。"}
                      </span>
                      <button type="button" className="btn btn-ghost" onClick={() => setSection("ai")}>去配置</button>
                    </div>
                  ) : null}
                  {modelStatus("layout") && !modelStatus("layout")!.installed && (
                    <Row label="版面识别模型" desc="翻译前需要先下载（约 72 MB）；使用在线接口也需要本机做版面识别">
                      <button className="btn btn-primary" onClick={() => setSection("models")}>去下载</button>
                    </Row>
                  )}
                  {(form.translate_mode || "local") === "local" && modelStatus("translate") && !modelStatus("translate")!.installed && (
                    <Row label="本地翻译模型" desc="本地模式需要先下载（约 1.1 GB）；改用在线接口则无需下载">
                      <button className="btn btn-primary" onClick={() => setSection("models")}>去下载</button>
                    </Row>
                  )}
                  {(form.translate_mode || "local") === "local" && (
                    <Row label="本地模型" desc={localStatus ? (localStatus.available ? "已就绪：HY-MT（llama.cpp 运行）" : localStatus.reason) : "正在检测…"}>
                      <input style={inputStyle} placeholder="留空使用内置模型，或填写 .gguf 路径" value={form.local_model || ""} onChange={(e) => set("local_model", e.target.value)} />
                    </Row>
                  )}
                  {(form.translate_mode || "local") === "local" && (
                    <Row label="GPU 层数" desc={modelStatus("gpu")?.installed
                      ? "默认 99（自动上 GPU；无显卡或显存不足会自动退回 CPU）。填 0 可强制纯 CPU"
                      : "默认 99；先在「本地模型」安装 GPU 加速包才会用显卡，否则用 CPU"}>
                      <input type="number" min={0} max={999} style={{ ...inputStyle, minWidth: 100 }} value={form.local_gpu_layers ?? 99} onChange={(e) => set("local_gpu_layers", parseInt(e.target.value, 10) || 0)} />
                    </Row>
                  )}
                  {(form.translate_mode || "local") === "local" && (
                    <Row label="额外参数" desc="透传给 llama-server 的参数（换用其它 GGUF 时可用）">
                      <input style={inputStyle} placeholder="例如 --override-kv tokenizer.ggml.eos_token_id=int:120020" value={form.local_extra_args || ""} onChange={(e) => set("local_extra_args", e.target.value)} />
                    </Row>
                  )}
                </Group>
                <Group title="翻译参数">
                  <Row label="线程"><input type="number" min={1} max={32} style={{ ...inputStyle, minWidth: 90 }} value={form.threads || 4} onChange={(e) => set("threads", parseInt(e.target.value, 10) || 4)} /></Row>
                  <Row label="超时（秒）"><input type="number" min={60} style={{ ...inputStyle, minWidth: 100 }} value={form.timeout || 3600} onChange={(e) => set("timeout", parseInt(e.target.value, 10) || 3600)} /></Row>
                  <Row label="默认源语言">
                    <select value={form.source_lang || "en"} onChange={(e) => set("source_lang", e.target.value)}>{LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                  </Row>
                  <Row label="默认目标语言">
                    <select value={form.target_lang || "zh-CN"} onChange={(e) => set("target_lang", e.target.value)}>{LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                  </Row>
                </Group>
              </>
            )}

            {section === "models" && (
              <>
                <Group title="按需下载">
                  {models.map((m) => {
                    const pr = modelProgress[m.id];
                    const busy = pr && (pr.state === "downloading" || pr.state === "verifying");
                    const chosen = m.sources.some((s) => s.url === sourceChoice[m.id]) ? sourceChoice[m.id] : (m.sources[0]?.url || "");
                    const chosenLabel = m.sources.find((s) => s.url === chosen)?.label || "默认";
                    return (
                      <div className="model-card" key={m.id}>
                        <div className="model-head">
                          <div className="model-info">
                            <div className="model-name">
                              {m.name}
                              <span className="model-size">{fmtSize(m.size)}</span>
                              {m.requiredFor === "all" && <span className="model-tag">翻译必需</span>}
                              {m.requiredFor === "local" && <span className="model-tag">仅本地模式</span>}
                              {m.requiredFor === "accel" && <span className="model-tag">本地加速</span>}
                            </div>
                            <div className="model-desc">{m.description}</div>
                          </div>
                          <span className={"model-state" + (m.installed ? " is-ok" : "")}>
                            {m.source === "custom" ? "自定义路径" : m.installed ? "已安装" : "未安装"}
                          </span>
                        </div>
                        {m.installed ? (
                          <div className="model-path" title={m.path}>
                            <Icon name="folder" small />
                            <span>{m.path}</span>
                          </div>
                        ) : null}
                        {busy && (
                          <div className="model-progress">
                            <div className="model-progress-bar"><i style={{ width: `${Math.round(pr.percent)}%` }} /></div>
                            <span>{pr.state === "verifying" ? "校验中…" : `下载中 ${Math.round(pr.percent)}% · ${fmtSize(pr.received)} / ${fmtSize(pr.total || m.size)}`}</span>
                          </div>
                        )}
                        <div className="model-sources">
                          <button
                            type="button"
                            className="model-sources-toggle"
                            aria-expanded={!!sourceOpen[m.id]}
                            onClick={() => setSourceOpen((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                          >
                            <span>下载源</span>
                            <span className="model-source-current">{chosenLabel}</span>
                            <Icon name={sourceOpen[m.id] ? "chev-down" : "chev-right"} small />
                          </button>
                          {sourceOpen[m.id] && (
                            <div className="model-sources-body">
                              <div className="model-sources-head">
                                <span>选择下载源</span>
                                <button type="button" className="model-link" onClick={() => { void testAllSources(m); }}>全部测速</button>
                              </div>
                              {m.sources.map((s) => {
                                const t = sourceTests[s.url];
                                const active = chosen === s.url;
                                return (
                                  <div className={"model-source" + (active ? " is-active" : "")} key={s.url}>
                                    <label>
                                      <input type="radio" name={"ms-" + m.id} checked={active} onChange={() => chooseSource(m.id, s.url)} />
                                      <span className="model-source-label">{s.label}</span>
                                      <span className="model-source-url" title={s.url}>{shortUrl(s.url)}</span>
                                    </label>
                                    <button type="button" className="model-link" disabled={t?.loading} onClick={() => { void testSource(s.url); }}>
                                      {t?.loading ? "测速中…" : "测速"}
                                    </button>
                                    {t && !t.loading && (t.ok
                                      ? <span className="model-test is-ok">{Math.round(t.latencyMs)} ms · {fmtSpeed(t.speedBps)}</span>
                                      : <span className="model-test is-bad">{t.error || "失败"}</span>)}
                                    <button type="button" className="icon-btn model-copy" title="复制下载地址" onClick={() => { void navigator.clipboard.writeText(s.url).catch(() => undefined); }}><Icon name="copy" small /></button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="model-actions">
                          {m.installed && !busy ? (
                            <button type="button" className="model-link" onClick={() => { void window.api.modelsReveal(m.id); }}>打开目录</button>
                          ) : null}
                          {busy ? (
                            <button className="btn" onClick={() => { void window.api.modelCancel(m.id); }}>取消下载</button>
                          ) : m.installed && (m.source === "managed" || m.source === "cache") ? (
                            <button className="btn" onClick={() => { void removeModel(m.id); }}>删除</button>
                          ) : m.installed ? (
                            <span className="model-hint">使用自定义路径，不在应用内管理</span>
                          ) : (
                            <button className="btn btn-primary" onClick={() => { void window.api.modelDownload(m.id, chosen || undefined); }}>下载</button>
                          )}
                          {pr?.state === "error" && <span className="model-error">下载失败：{pr.error || "未知错误"}</span>}
                          {pr?.state === "cancelled" && <span className="model-error">已取消</span>}
                          {!m.installed && m.id === "translate" && (form.translate_mode || "local") !== "local" && (
                            <span className="model-hint">当前使用在线接口，可以不下载</span>
                          )}
                          {!m.installed && m.id === "gpu" && (
                            <span className="model-hint">未安装时本地翻译使用 CPU 运行</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </Group>
                <div className="model-foot">下载完成后会校验文件完整性，校验通过才会启用。</div>
              </>
            )}

            {section === "general" && (
              <>
                <Group title="常规">
                  <Row label="默认打开视图" desc="选择文献后默认显示的标签页">
                    <select value={settings.defaultTab} onChange={(e) => updateSettings({ defaultTab: e.target.value as AppSettings["defaultTab"] })}>
                      <option value="info">信息</option><option value="notes">笔记</option><option value="tags">标签</option><option value="ai">AI 助手</option>
                    </select>
                  </Row>
                  <Row label="显示分类计数" desc="在侧栏每个分类后显示条目数量"><Switch on={settings.showCounts} onToggle={() => updateSettings({ showCounts: !settings.showCounts })} /></Row>
                  <Row label="显示未读标记" desc="在文献列表中标出未读条目"><Switch on={settings.showUnread} onToggle={() => updateSettings({ showUnread: !settings.showUnread })} /></Row>
                  <Row label="自动抓取元数据" desc="通过 DOI 自动补全标题、作者与来源"><Switch on={settings.fetchMeta} onToggle={() => updateSettings({ fetchMeta: !settings.fetchMeta })} /></Row>
                </Group>
                <Group title="引用格式">
                  <Row label="包含 DOI" desc="复制引用时附带 DOI 与标识符"><Switch on={settings.citeDoi} onToggle={() => updateSettings({ citeDoi: !settings.citeDoi })} /></Row>
                </Group>
              </>
            )}

            {section === "appearance" && (
              <>
                <Group title="主题">
                  <Row label="强调色" desc="用于选中态、链接与主要操作">
                    <div className="accent-swatches">
                      {(Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]).map((k) => (
                        <button key={k} className="swatch" aria-pressed={settings.accent === k} title={k}
                          style={{ background: ACCENTS[k].a }} onClick={() => updateSettings({ accent: k })} />
                      ))}
                    </div>
                  </Row>
                </Group>
                <Group title="PDF 页面">
                  <Row label="页面背景" desc="所有文档共用同一配色；也可以在阅读器工具栏的色块按钮里切换">
                    <select value={settings.pageTheme} onChange={(e) => updateSettings({ pageTheme: e.target.value as AppSettings["pageTheme"] })}>
                      {PAGE_THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                  </Row>
                </Group>
                <Group title="显示">
                  <Row label="减少动态效果" desc="关闭界面过渡与动效"><Switch on={settings.reduceMotion} onToggle={() => updateSettings({ reduceMotion: !settings.reduceMotion })} /></Row>
                </Group>
                <Group title="译文块框">
                  <Row label="翻译时显示块框" desc="翻译过程中在对照视图标出文本块（点击块框查看原文 / 译文）">
                    <Switch on={settings.showBlocksTranslating} onToggle={() => updateSettings({ showBlocksTranslating: !settings.showBlocksTranslating })} />
                  </Row>
                  <Row label="查看译文时显示块框" desc="打开已翻译文件时是否标出文本块">
                    <Switch on={settings.showBlocksTranslation} onToggle={() => updateSettings({ showBlocksTranslation: !settings.showBlocksTranslation })} />
                  </Row>
                </Group>
                <Group title="界面背景">
                  <Row label="显示背景" desc="在界面底层显示自定义图片或视频（面板会变半透明以露出背景）">
                    <Switch on={settings.backgroundEnabled} onToggle={() => updateSettings({ backgroundEnabled: !settings.backgroundEnabled })} />
                  </Row>
                  <Row label="背景文件" desc={settings.backgroundFile ? `当前：${settings.backgroundFile}` : "支持图片（png / jpg / webp / gif）与视频（mp4 / webm）"}>
                    <div className="set-inline">
                      <button className="btn" onClick={() => { void pickBackground(); }}><Icon name="layers" small /> 选择…</button>
                      {settings.backgroundFile && <button className="btn btn-ghost" onClick={() => { void clearBackground(); }}>清除</button>}
                    </div>
                  </Row>
                  <Row label="背景不透明度" desc="调低可压暗背景，让前景文字更清晰">
                    <div className="set-inline">
                      <input
                        className="set-range"
                        type="range"
                        min={10}
                        max={100}
                        step={1}
                        value={Math.round(settings.backgroundOpacity * 100)}
                        onChange={(e) => updateSettings({ backgroundOpacity: parseInt(e.target.value, 10) / 100 })}
                      />
                      <span className="set-range-val">{Math.round(settings.backgroundOpacity * 100)}%</span>
                    </div>
                  </Row>
                </Group>
              </>
            )}

            {section === "ai" && (
              <>
                <Group title="连接">
                  <div className="ai-conn-list">
                    {connections.map((item) => {
                      const test = connTests[item.id];
                      return (
                        <div className="ai-conn" key={item.id} data-conn-id={item.id}>
                          <div className="ai-conn-grid">
                            <span className="ai-conn-label">名称</span>
                            <input
                              className="ai-conn-input"
                              aria-label="连接名称"
                              value={item.name}
                              placeholder="连接名称"
                              onChange={(e) => updateConnection(item.id, { name: e.target.value })}
                            />
                            <span className="ai-conn-label">模型</span>
                            <input
                              className="ai-conn-input"
                              aria-label="模型"
                              value={item.model}
                              placeholder="模型"
                              onChange={(e) => updateConnection(item.id, { model: e.target.value })}
                            />
                            <span className="ai-conn-label">地址</span>
                            <input
                              className="ai-conn-input"
                              aria-label="接口地址"
                              value={item.baseUrl}
                              placeholder="https://api.deepseek.com"
                              onChange={(e) => updateConnection(item.id, { baseUrl: e.target.value })}
                            />
                            <span className="ai-conn-label">密钥</span>
                            <input
                              className="ai-conn-input"
                              type="password"
                              aria-label="API Key"
                              value={item.apiKey}
                              placeholder="sk-…"
                              onChange={(e) => updateConnection(item.id, { apiKey: e.target.value })}
                            />
                          </div>
                          <div className="ai-conn-foot">
                            {connectionStatus(item) ? <span className="ai-conn-status">{connectionStatus(item)}</span> : null}
                            <span className="ai-conn-spacer" />
                            <button
                              type="button"
                              className={"ai-conn-test" + (test && !test.loading ? (test.ok ? " is-ok" : " is-bad") : "")}
                              title={test && !test.loading
                                ? `${test.ok ? "连接正常" : "测试失败"}：${test.message}${test.latencyMs ? ` · ${test.latencyMs}ms` : ""}`
                                : "测试连接"}
                              disabled={test?.loading}
                              onClick={() => void testConnection(item.id)}
                            >
                              {test?.loading
                                ? <span className="ov-spinner" />
                                : test
                                  ? (test.ok ? <><Icon name="check" small /> 正常</> : <><Icon name="x" small /> 失败</>)
                                  : "测试"}
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title={connections.length <= 1 ? "至少保留一个连接" : "删除连接"}
                              disabled={connections.length <= 1}
                              onClick={() => removeConnection(item.id)}
                            >
                              <Icon name="trash" small />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button type="button" className="ai-conn-add" onClick={addConnection}>
                    <Icon name="plus" small /> 添加连接
                  </button>
                  <div className="ai-conn-hint">支持 OpenAI 兼容接口</div>
                </Group>

                <Group title="用途">
                  <Row label="文献助手">
                    <select value={form.chat_connection || ""} onChange={(e) => set("chat_connection", e.target.value)}>
                      {connections.map((item) => <option key={item.id} value={item.id}>{connectionLabel(item)}</option>)}
                    </select>
                  </Row>
                  <Row label="Overleaf">
                    <select value={form.overleaf_connection || ""} onChange={(e) => set("overleaf_connection", e.target.value)}>
                      <option value="">跟随文献助手</option>
                      {connections.map((item) => <option key={item.id} value={item.id}>{connectionLabel(item)}</option>)}
                    </select>
                  </Row>
                  <Row label="联网搜索">
                    <select
                      value={searchChoice}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "off") {
                          set("search_enabled", false);
                        } else {
                          setForm((f) => ({ ...f, search_enabled: true, search_provider: value as AppConfig["search_provider"] }));
                        }
                      }}
                    >
                      <option value="off">关闭</option>
                      <option value="tavily">Tavily</option>
                      <option value="bocha">博查</option>
                      <option value="deepseek">DeepSeek</option>
                    </select>
                  </Row>
                  {form.search_enabled && searchProvider !== "deepseek" ? (
                    <Row
                      label={searchProvider === "bocha" ? "博查 API Key" : "Tavily API Key"}
                      desc={searchProvider === "bocha"
                        ? <>在 <ExtLink href="https://open.bochaai.com/">博查官网</ExtLink> 获取</>
                        : <>在 <ExtLink href="https://app.tavily.com/">Tavily 官网</ExtLink> 获取</>}
                    >
                      <input
                        type="password"
                        style={inputStyle}
                        value={searchProvider === "bocha" ? (form.search_key_bocha || "") : (form.search_key_tavily || "")}
                        onChange={(e) => set(searchProvider === "bocha" ? "search_key_bocha" : "search_key_tavily", e.target.value)}
                      />
                    </Row>
                  ) : null}
                </Group>

              </>
            )}

            {section === "shortcuts" && (
              <Group title="快捷键">
                <dl className="kbd-list">
                  <dt>聚焦搜索</dt><dd>/</dd>
                  <dt>切换详情标签</dt><dd>← / →</dd>
                  <dt>PDF 翻页</dt><dd>PageUp / PageDown</dd>
                  <dt>关闭面板</dt><dd>Esc</dd>
                </dl>
              </Group>
            )}

            {section === "runtime" && <SystemPanel />}

            {section === "about" && (
              <Group title="">
                <div className="about-card">
                  <img className="about-logo" src="icons/logo.svg" alt="" />
                  <div className="od-fill">
                    <img className="about-word" src="icons/wordmark.svg" alt="Arxiver" />
                    <p>应用 v{info?.version || "—"} · 引擎 {info?.engineVersion || "?"}</p>
                    <p>数据：{info?.userData || ""}</p>
                    <p>缓存：{info?.profile || ""}</p>
                  </div>
                </div>
                <div className="about-update">
                  <span className="about-update-text">{updateText(update)}</span>
                  {update?.state === "available" && <button className="btn btn-primary" onClick={() => { void window.api.downloadUpdate(); }}>下载更新</button>}
                  {update?.state === "ready" && <button className="btn btn-primary" onClick={() => { void window.api.installUpdate(); }}>重启并安装</button>}
                  {(update?.state !== "downloading" && update?.state !== "ready") && (
                    <button className="btn" onClick={() => { void window.api.checkUpdate(); }}>检查更新</button>
                  )}
                </div>
                {update?.notes && (
                  <div className="about-notes">
                    <div className="about-notes-title">更新内容{update.version ? ` · v${update.version}` : ""}</div>
                    <Markdown text={update.notes} onCite={() => undefined} />
                  </div>
                )}
              </Group>
            )}
          </div>
          {showFooter ? (
            <div className="settings-footer">
              <span className={"settings-save-state" + (dirty ? " is-dirty" : "")}>
                {dirty
                  ? (hint.startsWith("保存失败") ? hint : "有未保存的修改")
                  : (hint || "所有更改已保存")}
              </span>
              <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? "保存中…" : "保存设置"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="set-group">
      {title && <div className="set-group-title">{title}</div>}
      {children}
    </div>
  );
}

/** 说明文字里的外链（官网 / 订阅页）：统一样式，点击交给系统浏览器打开 */
function ExtLink({ href, children }: { href: string; children: React.ReactNode }): JSX.Element {
  return (
    <a
      className="set-link"
      href={href}
      title={`在浏览器打开 ${href}`}
      onClick={(e) => { e.preventDefault(); void window.api.openExternal(href); }}
    >
      {children}
      <Icon name="external" small />
    </a>
  );
}

function Row({ label, desc, children }: { label: string; desc?: React.ReactNode; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <span className="set-copy">
        <span className="set-label">{label}</span>
        {desc && <span className="set-desc">{desc}</span>}
      </span>
      {children}
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }): JSX.Element {
  return <button type="button" className="switch" role="switch" aria-checked={on} onClick={onToggle} />;
}
