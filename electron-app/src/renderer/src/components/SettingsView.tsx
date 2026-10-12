import { useEffect, useState, type JSX } from "react";
import type { AppConfig, AppInfo, LocalModelStatus, UpdateStatus } from "../../../shared/types";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";
import { ACCENTS, type AppSettings } from "../state/settings";

const SECTIONS = [
  { id: "model", name: "翻译引擎", icon: "settings" },
  { id: "general", name: "通用", icon: "settings" },
  { id: "appearance", name: "外观", icon: "sparkle" },
  { id: "citation", name: "引用", icon: "copy" },
  { id: "ai", name: "AI 助手", icon: "message" },
  { id: "sync", name: "同步与存储", icon: "globe" },
  { id: "shortcuts", name: "快捷键", icon: "terminal" },
  { id: "about", name: "关于", icon: "book" }
];

export default function SettingsView({
  config,
  info,
  settings,
  updateSettings,
  onSaved,
  onClose
}: {
  config: AppConfig | null;
  info: AppInfo | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onSaved: (c: AppConfig) => void;
  onClose: () => void;
}): JSX.Element {
  const [section, setSection] = useState("model");
  const [form, setForm] = useState<Partial<AppConfig>>({});
  const [hint, setHint] = useState("");
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null);

  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdate);
    return window.api.onUpdateStatus((s) => setUpdate(s));
  }, []);

  useEffect(() => {
    if (section === "model") {
      void window.api.localStatus().then(setLocalStatus);
    }
  }, [section]);

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
        threads: config.threads, timeout: config.timeout, source_lang: config.source_lang, target_lang: config.target_lang
      });
    }
  }, [config]);

  const set = (k: keyof AppConfig, v: string | number): void => setForm((f) => ({ ...f, [k]: v }));
  const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const inputStyle = { height: 34, minWidth: 240, background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", color: "var(--text)", padding: "0 10px", outline: "none" } as const;

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
                      <option value="local">本地模型（内置 HY-MT）</option>
                      <option value="remote">在线接口</option>
                    </select>
                  </Row>
                  {(form.translate_mode || "local") === "local" && (
                    <Row label="本地模型" desc={localStatus ? (localStatus.available ? "已就绪：内置 HY-MT（llama.cpp 运行）" : localStatus.reason) : "正在检测…"}>
                      <input style={inputStyle} placeholder="留空使用内置模型，或填写 .gguf 路径" value={form.local_model || ""} onChange={(e) => set("local_model", e.target.value)} />
                    </Row>
                  )}
                  {(form.translate_mode || "local") === "local" && (
                    <Row label="GPU 层数" desc="默认 99（自动上 GPU；无显卡或显存不足会自动退回 CPU）。填 0 可强制纯 CPU">
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
                    <Row label="API 密钥"><input type="password" style={inputStyle} value={form.translate_api_key || ""} onChange={(e) => set("translate_api_key", e.target.value)} /></Row>
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
                <Group title="编辑">
                  <Row label="自动保存笔记" desc="停止输入后自动保存当前笔记"><Switch on={settings.autoSave} onToggle={() => updateSettings({ autoSave: !settings.autoSave })} /></Row>
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
                <Group title="显示">
                  <Row label="减少动态效果" desc="关闭界面过渡与动效"><Switch on={settings.reduceMotion} onToggle={() => updateSettings({ reduceMotion: !settings.reduceMotion })} /></Row>
                  <Row label="PDF 默认缩放" desc="信息页 PDF 预览的初始缩放比例">
                    <select value={settings.pdfZoom} onChange={(e) => updateSettings({ pdfZoom: e.target.value as AppSettings["pdfZoom"] })}>
                      <option value="fit">适应宽度</option><option value="1">100%</option><option value="1.25">125%</option>
                    </select>
                  </Row>
                </Group>
                <Group title="译文块框">
                  <Row label="翻译时显示块框" desc="翻译过程中在对照视图标出文本块（悬停可查看原文 / 译文）">
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
                    <input
                      className="set-range"
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={Math.round(settings.backgroundOpacity * 100)}
                      onChange={(e) => updateSettings({ backgroundOpacity: parseInt(e.target.value, 10) / 100 })}
                    />
                  </Row>
                </Group>
              </>
            )}

            {section === "citation" && (
              <Group title="引用格式">
                <Row label="默认引用格式" desc="点击「复制引用」时生成的格式">
                  <select value={settings.citeFormat} onChange={(e) => updateSettings({ citeFormat: e.target.value as AppSettings["citeFormat"] })}>
                    <option value="apa">APA 7th</option><option value="gb">GB/T 7714</option><option value="mla">MLA 9th</option>
                  </select>
                </Row>
                <Row label="包含 DOI" desc="复制引用时附带 DOI 与标识符"><Switch on={settings.citeDoi} onToggle={() => updateSettings({ citeDoi: !settings.citeDoi })} /></Row>
                <Row label="导出格式" desc="导出文献库时的默认文件格式">
                  <select value={settings.exportFormat} onChange={(e) => updateSettings({ exportFormat: e.target.value as AppSettings["exportFormat"] })}>
                    <option value="bibtex">BibTeX</option><option value="ris">RIS</option><option value="csv">CSV</option>
                  </select>
                </Row>
              </Group>
            )}

            {section === "ai" && (
              <>
                <Group title="对话接口">
                  <Row label="接口地址" desc="AI 助手使用的 OpenAI 兼容接口，与翻译引擎相互独立"><input style={inputStyle} value={form.chat_base_url || ""} onChange={(e) => set("chat_base_url", e.target.value)} /></Row>
                  <Row label="API 密钥"><input type="password" style={inputStyle} value={form.chat_api_key || ""} onChange={(e) => set("chat_api_key", e.target.value)} /></Row>
                  <Row label="模型"><input style={inputStyle} value={form.chat_model || ""} onChange={(e) => set("chat_model", e.target.value)} /></Row>
                  <div className="modal-foot" style={{ border: 0, padding: "4px 0" }}>
                    <span style={{ marginRight: "auto", color: "var(--faint)", fontSize: 12 }}>{hint}</span>
                    <button className="btn btn-primary" onClick={save}>保存设置</button>
                  </div>
                </Group>
                <Group title="AI 助手">
                  <Row label="启用 AI 助手" desc="在详情栏显示 AI 标签页"><Switch on={settings.aiEnabled} onToggle={() => updateSettings({ aiEnabled: !settings.aiEnabled })} /></Row>
                  <Row label="模型" desc="选择回答问题时使用的模型">
                    <select value={settings.aiModel} onChange={(e) => updateSettings({ aiModel: e.target.value })}>
                      <option value="文献助手">文献助手</option><option value="文献助手 Pro">文献助手 Pro</option>
                    </select>
                  </Row>
                  <Row label="附带引用来源" desc="回答中标注所依据的文献位置"><Switch on={settings.aiSources} onToggle={() => updateSettings({ aiSources: !settings.aiSources })} /></Row>
                  <Row label="自动总结新条目" desc="添加文献后自动生成一段摘要"><Switch on={settings.autoSummary} onToggle={() => updateSettings({ autoSummary: !settings.autoSummary })} /></Row>
                </Group>
              </>
            )}

            {section === "sync" && (
              <>
                <Group title="账户"><Row label="当前账户" desc="研究员 · 个人文库" /></Group>
                <Group title="同步">
                  <Row label="自动同步" desc="在有改动时自动上传至云端"><Switch on={settings.autoSync} onToggle={() => updateSettings({ autoSync: !settings.autoSync })} /></Row>
                  <Row label="存储用量" desc="本地文库数据" />
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

            {section === "about" && (
              <Group title="">
                <div className="about-card">
                  <img className="about-logo" src="icons/logo.svg" alt="" />
                  <div className="od-fill">
                    <img className="about-word" src="icons/wordmark.svg" alt="Arxiver" />
                    <p>应用 v{info?.version || "—"} · 引擎 {info?.engineVersion || "?"}</p>
                    <p>{info?.userData || ""}</p>
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

function Row({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }): JSX.Element {
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
