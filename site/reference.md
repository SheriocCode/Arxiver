---
layout: doc
nav: reference
title: 参考 — Arxiver
description: Arxiver 架构、数据、构建与发布参考。
toc:
  - title: 工作原理
    id: arch
  - title: 组成
    id: layout
  - title: 数据格式
    id: data
  - title: Arxiver 助手
    id: agent
  - title: 联网搜索与读正文
    id: websearch
  - title: 更新与发布
    id: release
  - title: 构建
    id: build
  - title: 第三方许可
    id: license
---

## 工作原理 {#arch}

Electron 桌面应用：渲染进程（React）负责界面与 PDF.js 渲染，主进程负责文库/存储，并调用内嵌的本地翻译引擎（Python，内置离线翻译模型）与独立配置的在线接口（Arxiver 助手）。

~~~
导入 PDF ─▶ 文库 storage/<docId>/paper.pdf
打开 ─▶ 渲染进程用 PDF.js 渲染原文 / 译文（对照）
点翻译 ─▶ 主进程调用内嵌引擎（engine/）─▶ 内置本地翻译模型（离线；也可切换在线接口）
        └▶ 生成 dual/mono PDF + blocks.jsonl，落盘到 storage/<docId>/
Arxiver ─▶ 主进程检索 storage/*/text.json（BM25）；联网时再走搜索服务商（Tavily / 博查）+ 读正文
        └▶ 调用（独立配置的）在线接口流式作答（function calling；写操作先请用户批准）
~~~

## 组成 {#layout}

| 目录 | 说明 |
| --- | --- |
| `electron-app/src/main/` | 主进程：引擎调度、本地翻译服务（`localmodel`）、文库/存储、Agent（模型 + 工具 + 审批）、自动更新 |
| `electron-app/src/renderer/src/` | 渲染进程：React 组件、`styles.css`、PDF 阅读器引擎、Arxiver 面板 |
| `electron-app/src/preload/`、`src/shared/` | `window.api`（IPC）与共享类型 |
| `electron-app/engine/` | 本机翻译引擎（Python）：源码进 git；运行时/模型（llama.cpp、HY-MT gguf、python 运行时）不进 git |
| `icons/`、`site/`→`docs/` | 品牌资源与文档站 |

## 数据格式 {#data}

数据都在用户目录 `%APPDATA%\Arxiver\`：`storage/index.json`（文库元数据）、
`storage/<docId>/`（`paper.pdf`、`<cacheKey>.dual.pdf`、`<cacheKey>.mono.pdf`、`<cacheKey>.blocks.jsonl`、
`text.json`）、`storage/conversations/`（Arxiver 会话）、`config.json`（设置，含联网搜索的服务商与 API Key）、
`logs/app.log`（运行日志）。详见[文档](../guide.html#storage)。

## Arxiver 助手 {#agent}

- **模型**：OpenAI 兼容 `chat/completions`（流式、function calling、usage），读取 `config.json` 中的 `chat_*` 配置（与翻译接口分离）；一轮提问最多 8 次工具往返（`MAX_ROUNDS`）。
- **只读工具**：`list_library`（含分类 / 标签）、`list_collections`、`search_library`（整库 BM25）、`search_in_document`、`read_document`（按页读 `text.json`）。
- **写入工具**：`update_metadata`、`apply_tags`、`set_flags`、`move_to_trash`、`restore_from_trash`、`add_to_collection`、`remove_from_collection`、`rename_collection`、`delete_collection`、`import_paper`、`add_note`、`delete_note` —— 一律先弹确认卡片（批准 / 修改 / 拒绝）。分类名 / 标签名对不上时，工具返回相近候选让模型自己纠正，而不是让用户去核对拼写。
- **联网工具**：`search_web`、`fetch_url`（见下一节）。
- **智能路由**：当前文章为默认上下文，跨文献 / 整库问题自动检索；信息不足时追问。
- **检索卡片**：`search_web` 的结果带会话全局编号（`cardBase` + 序号 = `idx`），推给界面渲染成卡片；历史消息里每张卡片压成一行摘要（`#N 标题（site · year）`），模型用 `[[card:N]]` 指代，界面渲染为可点击胶囊（滚动到对应卡片并高亮）；本地文献用 `[[cite:<docId>#<page>]]`。
- **进度事件**：长耗时工具（`import_paper` / `fetch_url`）通过 `progress` 回调上报阶段，界面显示转圈 + 阶段 + 已用秒数。

## 联网搜索与读正文 {#websearch}

相关配置（`config.json`）：`search_enabled`（总开关，默认 `false`）、`search_provider`（`tavily` | `bocha`）、
`search_key_tavily` / `search_key_bocha`（两家 Key 各自保存）、`search_scope`（`academic` | `web`）。
开关关闭时联网工具不暴露给模型；`search_web` 需要**当前服务商**有 Key，`fetch_url` 只要有开关（没 Key 就用本机抓取）。
不再调用 arXiv / OpenAlex 的检索接口（曾受 IP 限流）。

### 聚合搜索（`search_web` → `searchWeb()`）

- **查询扇出**：模型给出 1~4 条**英文**受控检索式（可带会议名 / 年份 / `site:` 限定），并行请求，去重后统一排序。
- **归一化**：两家结果都收敛成 `RawHit{title,url,content,date}`，之后共用清洗：
  - 标题剥掉 arXiv 的 `[2509.15459]` 前缀；博查另外剥站点后缀（`… – arxiv` / `… | researchgate`）；
  - 摘要优先从 `Abstract:` 之后截取——arXiv 摘要页常混入 arXivLabs / Announce Type / Subjects / Cite as 等样板，抽不到就留空，不显示噪声；
  - arXiv 编号先看 URL、取不到再从正文里找（`arXiv:…` 写法）；DOI **只从 URL 里识别**（防从摘要里误抓别人的 DOI）。两者决定条目能否一键导入；
  - 去重键：DOI → arXiv 编号 → 归一化 URL（去 `utm_*` / 锚点 / `www`）。
- **排序**：`tier = 学术域名(1) + 带标识符(1)`，同 tier 按年份降序。学术白名单含 arXiv / ar5iv / OpenReview / NeurIPS / CVF / ECVA / PMLR / ACL / AAAI / IJCAI / ACM / IEEE / Springer / ScienceDirect / Nature / Science / PubMed / bioRxiv 等。
- **Tavily**：`POST /search`，`search_depth=basic`、`include_usage`、`include_published_date`；学术时带 `include_domains` + `include_domains_mode`（`prefer` 加权 / `restrict` 限定），`time_range` 透传；用量取 `usage.credits`。
- **博查**：`POST /v1/web-search`，`summary=true`（长摘要比 `snippet` 完整）、`count`、`freshness`（`day/week/month/year` → `oneDay/oneWeek/oneMonth/oneYear`）；字段映射 `name→title`、`summary || snippet→content`、`datePublished || dateLastCrawled→date`。它**没有域名参数、没有 extract、也不返回 credits**，所以 `academic + restrict` 由本地白名单兜底（`prefer` 本来就只是排序加权）。
- **失败处理**：401/403 → Key 无效、432/433 → 额度用尽、429 → 频繁；所有查询都失败且无结果时抛出错误交给模型，让它如实说明，而不是编造论文。

### 读正文（`fetch_url` → `readPage()`）

预算默认 8000 字（`max_chars` 限 2000~20000），两条路径：

1. **Tavily extract**（配了 Tavily Key 时优先）：`POST /extract`，带上 `query` 让服务端挑相关段落（`chunks_per_source=4`），1 credit / 5 个 URL，超时 25s；返回文本只做长度收敛。
2. **本机抓取**（没配 Key 或 extract 失败）：`fetchPageText()`
   - 只允许 `http` / `https`；拒绝 `localhost`、`*.local` / `*.internal`、IPv4 私网（`10.` / `127.` / `192.168.` / `172.16-31.` / `169.254.` / `0.` / CGNAT）与 IPv6 私网，**DNS 解析后再校验一次**（防内网域名与 DNS 重绑定）；
   - 手动跟随跳转、最多 4 跳、**每一跳重新校验**；单跳 20s 超时；响应体最大 3MB；
   - `application/pdf` → 落临时文件后调 `engine/extract_text.py`（PyMuPDF）逐页抽文本；HTML → 去 `script/style` / 标签、还原实体、取 `<title>`；其它按纯文本；
   - 再本地挑段落 `pickPassages()`：按空行切段（>40 字），用 `agent/text.ts` 的 `tokenize` 算与 query 的词重合度打分、轻微偏好靠前段落，拼到预算为止，段间用 `---`。

读到的内容一方面以 `read` 事件推给界面（「已读正文」行：站点 · 字数，悬停看途径与完整链接），另一方面作为工具结果回给模型。主进程日志（`websearch:` 前缀）记录每条检索式命中数、`<服务商> 合计 N 条，用量 X credits，耗时 Yms`、`读取 <域名>（<途径>，N 字，Yms）`。

> Key 以明文存于 `config.json`（仅本机、不进 git）；对外只发检索式与要读的 URL，本地文献内容不外发。

### 导入

`import_paper` 与「新建文献」共用 `importPaper.ts`：接受 arXiv 编号 / DOI / arXiv abs 页 / PDF 直链，页面里会找 `citation_pdf_url`；下载后经 `engine/pdfmeta.py` 与 `enrich.ts` 补全标题 / 作者 / 年份 / 期刊 / DOI 再落库，全程通过 `progress` 回调报阶段（查询元信息 → 下载 PDF → 补全元数据）。

## 更新与发布 {#release}

- 本地打包：`powershell -File tools/build.ps1`（`electron-builder` NSIS，产出安装包、`.exe.blockmap`、`latest.yml` 于 `electron-app/dist/`）。
- 发布：`powershell -File tools/publish.ps1 -Version X.Y.Z`（提交版本、打 tag 并上传到 GitHub Release）。
- 更新：`electron-updater` 读取 `latest.yml`，差量下载（只下变化块）；引擎文件未变不会重下。
- 引擎版本记于 `electron-app/engine/VERSION`；引擎有实质更新时 bump 并在 changelog 注明。

## 构建 {#build}

~~~powershell
cd electron-app
npm install
npm run dev        # 开发运行
npm run typecheck  # tsc（node + web）
npm run build      # electron-vite 构建
npm run dist       # 打包安装包（electron-builder）
~~~

仓库根 `tools/`：`build.ps1`（本地打包）、`publish.ps1`（发布，先打包）、`build-docs.ps1`（文档站 `site/` → `docs/`）、`fetch-llm.ps1`（下载 llama.cpp 运行时与 HY-MT 模型）。

## 第三方许可 {#license}

- **PDF.js**（Mozilla，Apache-2.0）：PDF 渲染与文本层。
- **HY-MT**（腾讯混元，Apache-2.0）：随应用分发的本地翻译模型。
- **llama.cpp**（MIT）：本地翻译推理运行时。
- **ONNX Runtime**（MIT，含 DirectML 执行后端）：版面识别。
- **BabelDOC / PyMuPDF**（AGPL-3.0）：随引擎分发的翻译引擎与文本抽取。
- **KaTeX**（MIT）、**react-markdown / remark / rehype**（MIT）：Arxiver 回答渲染。
- 图标集移植自 **Lucide**（ISC）。
