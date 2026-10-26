import { useCallback, useEffect, useState, type JSX } from "react";
import type { AppConfig, AppInfo, LocalModelInfo, LocalModelProgress, LocalModelStatus, ModelSourceTest, UpdateStatus } from "../../../shared/types";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";
import { ACCENTS, PAGE_THEMES, type AppSettings } from "../state/settings";
import { Markdown } from "../lib/markdown";
import SystemPanel from "./SystemPanel";

const SECTIONS = [
  { id: "model", name: "翻译引擎", icon: "settings" },
  { id: "models", name: "本地模型", icon: "layers" },
  { id: "general", name: "通用", icon: "settings" },
  { id: "appearance", name: "外观", icon: "sparkle" },
  { id: "citation", name: "引用", icon: "copy" },
  { id: "ai", name: "AI 助手", icon: "message" },
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
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null);
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [modelProgress, setModelProgress] = useState<Record<string, LocalModelProgress>>({});
  const [sourceChoice, setSourceChoice] = useState<Record<string, string>>(() => settings.modelSources || {});
  const [sourceTests, setSourceTests] = useState<Record<string, ModelSourceTest & { loading?: boolean }>>({});
  const [sourceOpen, setSourceOpen] = useState<Record<string, boolean>>({});
  const [modelDir, setModelDir] = useState("");
  const loadModels = useCallback(() => { void window.api.modelsList().then(setModels); }, []);

  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdate);
    return window.api.onUpdateStatus((s) => setUpdate(s));
  }, []);

  useEffect(() => {
    if (section === "model") {
      void window.api.localStatus().then(setLocalStatus);
      loadModels();
    }
    if (section === "models") {
      loadModels();
      void window.api.modelsDir().then(setModelDir);
      void window.api.localStatus().then(setLocalStatus);
    }
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
        translate_mode: config.translate_mode, service: config.service,
        translate_base_url: config.translate_base_url, translate_api_key: config.translate_api_key,
        translate_model: config.translate_model, local_model: config.local_model, local_gpu_layers: config.local_gpu_layers,
        local_extra_args: config.local_extra_args,
        chat_base_url: config.chat_base_url, chat_api_key: config.chat_api_key, chat_model: config.chat_model,
        search_enabled: config.search_enabled, search_provider: config.search_provider,
        search_key_tavily: config.search_key_tavily, search_key_bocha: config.search_key_bocha,
        search_key_deepseek: config.search_key_deepseek,
        search_scope: config.search_scope,
        threads: config.threads, timeout: config.timeout, source_lang: config.source_lang, target_lang: config.target_lang
      });
    }
  }, [config]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const searchProvider: AppConfig["search_provider"] =
    form.search_provider === "bocha" ? "bocha" : form.search_provider === "deepseek" ? "deepseek" : "tavily";
  const searchKeyField: "search_key_tavily" | "search_key_bocha" | "search_key_deepseek" =
    searchProvider === "bocha" ? "search_key_bocha" : searchProvider === "deepseek" ? "search_key_deepseek" : "search_key_tavily";
  const searchKeyValue = form[searchKeyField] || "";
  const searchProviderName = { tavily: "Tavily", bocha: "博查", deepseek: "DeepSeek" }[searchProvider];
  const inputStyle = { height: 34, minWidth: 240, background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", color: "var(--text)", padding: "0 10px", outline: "none" } as const;

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
    const saved = await window.api.setConfig(form);
    onSaved(saved);
    setHint("已保存");
    setTimeout(() => setHint(""), 2000);
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
    <div className="modal-root" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
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
            <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" small /></button>
          </div>
          <div className="settings-body">
            {section === "model" && (
              <>
                <Group title="翻译方式">
                  <Row label="翻译引擎" desc="本地模型离线运行、不产生费用；在线接口需要 API 密钥">
                    <select value={form.translate_mode || "local"} onChange={(e) => set("translate_mode", e.target.value as AppConfig["translate_mode"])}>
                      <option value="local">本地模型（HY-MT）</option>
                      <option value="remote">在线接口</option>
                    </select>
                  </Row>
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
                {(form.translate_mode || "local") === "remote" && (
                  <Group title="在线接口">
                    <Row label="接口地址"><input style={inputStyle} value={form.translate_base_url || ""} onChange={(e) => set("translate_base_url", e.target.value)} /></Row>
                    <Row label="API 密钥" desc={<>默认服务商是 DeepSeek：在 <ExtLink href="https://platform.deepseek.com/">DeepSeek 官网</ExtLink> 创建 API Key 并订阅额度；换别家就改上面的接口地址与模型</>}><input type="password" style={inputStyle} value={form.translate_api_key || ""} onChange={(e) => set("translate_api_key", e.target.value)} /></Row>
                    <Row label="模型"><input style={inputStyle} value={form.translate_model || ""} onChange={(e) => set("translate_model", e.target.value)} /></Row>
                    <Row label="默认服务"><input style={inputStyle} value={form.service || ""} onChange={(e) => set("service", e.target.value)} /></Row>
                  </Group>
                )}
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
                <div className="modal-foot" style={{ border: 0, padding: "4px 0" }}>
                  <span style={{ marginRight: "auto", color: "var(--faint)", fontSize: 12 }}>{hint}</span>
                  <button className="btn btn-primary" onClick={save}>保存设置</button>
                </div>
              </>
            )}

            {section === "models" && (
              <>
                <Group title="按需下载">
                  <div className="model-dir">
                    <span>保存位置</span>
                    <code title={modelDir}>{modelDir || "…"}</code>
                    <button type="button" className="model-link" disabled={!modelDir} onClick={() => { void window.api.openPath(modelDir); }}>打开目录</button>
                  </div>
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
                <Group title="启动与背景">
                  <Row label="开屏动画" desc="启动时播放一段开屏动画">
                    <Switch on={settings.splashEnabled} onToggle={() => updateSettings({ splashEnabled: !settings.splashEnabled })} />
                  </Row>
                  <Row label="界面背景" desc="在界面底层显示自定义图片或视频（面板会变半透明以露出背景）">
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

            {section === "citation" && (
              <Group title="引用格式">
                <Row label="包含 DOI" desc="复制引用时附带 DOI 与标识符"><Switch on={settings.citeDoi} onToggle={() => updateSettings({ citeDoi: !settings.citeDoi })} /></Row>
              </Group>
            )}

            {section === "ai" && (
              <>
                <Group title="对话接口">
                  <Row label="接口地址" desc="AI 助手使用的 OpenAI 兼容接口，与翻译引擎相互独立"><input style={inputStyle} value={form.chat_base_url || ""} onChange={(e) => set("chat_base_url", e.target.value)} /></Row>
                  <Row label="API 密钥" desc={<>默认用 DeepSeek（deepseek-chat）：在 <ExtLink href="https://platform.deepseek.com/">DeepSeek 官网</ExtLink> 创建 API Key 并订阅额度</>}><input type="password" style={inputStyle} value={form.chat_api_key || ""} onChange={(e) => set("chat_api_key", e.target.value)} /></Row>
                  <Row label="模型" desc="图片提问需要模型支持视觉输入（如 DeepSeek 的 deepseek-flash）；纯文本模型收到图片会报错"><input style={inputStyle} value={form.chat_model || ""} onChange={(e) => set("chat_model", e.target.value)} /></Row>
                  <div className="modal-foot" style={{ border: 0, padding: "4px 0" }}>
                    <span style={{ marginRight: "auto", color: "var(--faint)", fontSize: 12 }}>{hint}</span>
                    <button className="btn btn-primary" onClick={save}>保存设置</button>
                  </div>
                </Group>
                <Group title="联网搜索">
                  <Row label="启用联网搜索" desc="允许 AI 搜索文库外的论文与资料；只发送检索式，不上传本地文献内容。默认关闭">
                    <Switch on={!!form.search_enabled} onToggle={() => set("search_enabled", !form.search_enabled)} />
                  </Row>
                  <Row label="搜索服务商" desc="Tavily：学术结果稳、域名加权更细；博查：国内网络友好、返回摘要更完整；DeepSeek：自研搜索，国内直连、长摘要 + 权威性排序（可在各家之间随时切换对比）">
                    <select value={searchProvider} onChange={(e) => set("search_provider", e.target.value as AppConfig["search_provider"])} disabled={!form.search_enabled}>
                      <option value="tavily">Tavily</option>
                      <option value="bocha">博查（Bocha）</option>
                      <option value="deepseek">DeepSeek</option>
                    </select>
                  </Row>
                  {searchProvider === "bocha" ? (
                    <Row label="博查 API Key" desc={<>在 <ExtLink href="https://open.bochaai.com/">博查官网</ExtLink> 控制台获取（Bearer sk-…）</>}>
                      <input type="password" style={inputStyle} value={form.search_key_bocha || ""} onChange={(e) => set("search_key_bocha", e.target.value)} />
                    </Row>
                  ) : searchProvider === "deepseek" ? (
                    <Row label="DeepSeek API Key" desc={<>在 <ExtLink href="https://platform.deepseek.com/">DeepSeek 官网</ExtLink> 创建（可与对话接口用同一把）；搜索 ¥5 / 1000 次，账号级 5 QPS。读正文兜底也用它</>}>
                      <input type="password" style={inputStyle} value={form.search_key_deepseek || ""} onChange={(e) => set("search_key_deepseek", e.target.value)} />
                    </Row>
                  ) : (
                    <Row label="Tavily API Key" desc={<>在 <ExtLink href="https://app.tavily.com/">Tavily 官网</ExtLink> 注册后获取；每次提问约消耗 3~6 credits（免费额度 1000/月）。读正文优先用它</>}>
                      <input type="password" style={inputStyle} value={form.search_key_tavily || ""} onChange={(e) => set("search_key_tavily", e.target.value)} />
                    </Row>
                  )}
                  <Row label="检索范围" desc="学术优先会对 arXiv / 会议 / 期刊等域名加权（不排他），也可切换到全网">
                    <select value={form.search_scope || "academic"} onChange={(e) => set("search_scope", e.target.value as AppConfig["search_scope"])} disabled={!form.search_enabled}>
                      <option value="academic">学术优先</option>
                      <option value="web">全网</option>
                    </select>
                  </Row>
                  {form.search_enabled && !searchKeyValue ? (
                    <div style={{ color: "var(--danger)", fontSize: 12 }}>还没填 {searchProviderName} API Key，联网搜索不会生效。</div>
                  ) : null}
                  <div className="modal-foot" style={{ border: 0, padding: "4px 0" }}>
                    <span style={{ marginRight: "auto", color: "var(--faint)", fontSize: 12 }}>{hint}</span>
                    <button className="btn btn-primary" onClick={save}>保存设置</button>
                  </div>
                </Group>
                <Group title="AI 助手">
                  <Row label="启用 AI 助手" desc="在详情栏显示 AI 标签页"><Switch on={settings.aiEnabled} onToggle={() => updateSettings({ aiEnabled: !settings.aiEnabled })} /></Row>
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
