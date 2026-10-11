import { useEffect, useState, type JSX } from "react";
import type { AppConfig, AppInfo, UpdateStatus } from "../../../shared/types";
import { Icon } from "./Icons";
import { LANGS } from "../lib/langs";
import { ACCENTS, type AppSettings } from "../state/settings";

const SECTIONS = [
  { id: "model", name: "模型接口", icon: "settings" },
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

  useEffect(() => {
    void window.api.getUpdateStatus().then(setUpdate);
    return window.api.onUpdateStatus((s) => setUpdate(s));
  }, []);

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
        openai_base_url: config.openai_base_url, openai_api_key: config.openai_api_key,
        openai_model: config.openai_model, service: config.service, threads: config.threads,
        timeout: config.timeout, source_lang: config.source_lang, target_lang: config.target_lang
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
                <div className="set-group">
                  <div className="set-group-title">模型接口</div>
                  <Row label="接口地址"><input style={inputStyle} value={form.openai_base_url || ""} onChange={(e) => set("openai_base_url", e.target.value)} /></Row>
                  <Row label="API 密钥"><input type="password" style={inputStyle} value={form.openai_api_key || ""} onChange={(e) => set("openai_api_key", e.target.value)} /></Row>
                  <Row label="模型"><input style={inputStyle} value={form.openai_model || ""} onChange={(e) => set("openai_model", e.target.value)} /></Row>
                  <Row label="默认服务"><input style={inputStyle} value={form.service || ""} onChange={(e) => set("service", e.target.value)} /></Row>
                  <Row label="线程"><input type="number" min={1} max={32} style={{ ...inputStyle, minWidth: 90 }} value={form.threads || 4} onChange={(e) => set("threads", parseInt(e.target.value, 10) || 4)} /></Row>
                  <Row label="超时（秒）"><input type="number" min={60} style={{ ...inputStyle, minWidth: 100 }} value={form.timeout || 3600} onChange={(e) => set("timeout", parseInt(e.target.value, 10) || 3600)} /></Row>
                  <Row label="默认源语言">
                    <select value={form.source_lang || "en"} onChange={(e) => set("source_lang", e.target.value)}>{LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                  </Row>
                  <Row label="默认目标语言">
                    <select value={form.target_lang || "zh-CN"} onChange={(e) => set("target_lang", e.target.value)}>{LANGS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                  </Row>
                </div>
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
