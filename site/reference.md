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
Arxiver ─▶ 主进程检索 storage/*/text.json（BM25）；联网时再走搜索服务商（Tavily / 博查 / DeepSeek）+ 读正文
        └▶ 调用（独立配置的）在线接口流式作答（function calling；写操作先请用户批准）
~~~

## 组成 {#layout}

| 目录 | 说明 |
| --- | --- |
| `electron-app/src/main/` | 主进程：引擎调度、本地翻译服务（`localmodel`）、文库/存储、Agent（模型 + 工具 + 审批）、自动更新 |
| `electron-app/src/renderer/src/` | 渲染进程：React 组件、`styles.css`、PDF 阅读器引擎、Arxiver 面板 |
| `electron-app/src/preload/`、`src/shared/` | `window.api`（IPC）与共享类型 |
| `electron-app/engine/` | 本机翻译引擎（Python）：源码进 git；CPU 版 llama.cpp 与 python 运行时随安装包分发；GPU 加速包、HY-MT gguf 与版面识别 ONNX 按需下载 |
| `icons/`、`site/`→`docs/` | 品牌资源与文档站 |

## 数据格式 {#data}

数据都在**安装目录下的 `data\`**（例如 `E:\develop\Arxiver\data\`）：`storage/index.json`（文库元数据）、
`storage/<docId>/`（`paper.pdf`、`<cacheKey>.dual.pdf`、`<cacheKey>.mono.pdf`、`<cacheKey>.blocks.jsonl`、
`text.json`）、`storage/conversations/`（Arxiver 会话）、`config.json`（设置，含联网搜索的服务商与 API Key）、
`models/`（按需下载的模型）、`runtime/vulkan/`（GPU 加速包）、`home/.cache/babeldoc/`（引擎缓存）、`logs/app.log`（运行日志）。
Chromium 缓存 / LocalStorage / Cookies 仍在 `%APPDATA%\Arxiver\`（开发版 `Arxiver-dev`）；安装目录不可写时应用数据回退到该目录。详见[文档](../guide.html#storage)。

`<cacheKey>.blocks.jsonl` 每行是一个段落块（`page / index / bbox / src / dst`）。片段里出现公式占位符时还带
`vars`：页内编号 → 引擎从 PDF 字形抽出的公式文本（`{vN}` 与 `{{vN}}` 都认）；数学字体没有 Unicode 映射、抽不出内容时该键缺省，界面退回显示占位符。

## Arxiver 助手 {#agent}

- **模型**：OpenAI 兼容 `chat/completions`（流式、function calling、usage），读取 `config.json` 中的 `chat_*` 配置（与翻译接口分离）；一轮提问最多 8 次工具往返（`MAX_ROUNDS`）。
- **只读工具**：`list_library`（含分类 / 标签）、`list_collections`、`search_library`（整库 BM25）、`search_in_document`、`read_document`（按页读 `text.json`）。
- **写入工具**：`update_metadata`、`apply_tags`、`set_flags`、`move_to_trash`、`restore_from_trash`、`add_to_collection`、`remove_from_collection`、`rename_collection`、`delete_collection`、`import_paper`、`add_note`、`delete_note` —— 一律先弹确认卡片（批准 / 修改 / 拒绝）。分类名 / 标签名对不上时，工具返回相近候选让模型自己纠正，而不是让用户去核对拼写。
- **联网工具**：`search_web`、`fetch_url`（见下一节）。
- **图片输入**：`AgentChatRequest.images`（`dataUrl` + `page` + `anchor` + `text`）拼成 OpenAI 兼容内容块（`[{type:"text"},{type:"image_url"}]`），历史消息里的图片随 `history[].images` 一起回传（只有 user 消息允许带图）。阅读器里的区域截图是**自动进入**的：`root` 上的 `pointerdown` 先用 `elementsFromPoint` 找到所在页，再用 `textLines()` 按行判断落点是否在文字行内（仅 2px 容差）——在文字上就完全交给浏览器原生选区（不做任何锚点/终点干预），否则（图 / 空白，或按住 `Alt`）开始拖框；移动超过 4px 才创建遮罩（单纯点击不会闪），松开后选区保留、选框外侧出现小操作条（Arxiver 图标 = 添加到对话，× = 取消），可拖 8 个手柄缩放 / 拖框内移动 / 点空白或 `Esc` 取消，点图标才裁剪入队（页面不压暗）。裁剪时 `cropRegion()` 同时算 `anchor`（选区顶部在页面里的纵向比例）和 `regionText()`（与选区相交的文本层 span；几乎没字时补上相交段落的译文），一起写进提示词，供模型定位。粘贴/选文件走 `lib/images.ts` 统一压到最长边 1600px。`runChat()` 对 `api.deepseek.com` + `deepseek-chat/reasoner/coder` 直接拦截图片请求（这些模型会静默忽略图片），前端也会在输入框上方提前提示。裁剪时 `cropRegion()` 同时算 `anchor`（选区顶部在页面里的纵向比例）和 `regionText()`（与选区相交的文本层 span；几乎没字时补上相交段落的译文），一起写进提示词，供模型定位。粘贴/选文件走 `lib/images.ts` 统一压到最长边 1600px。`runChat()` 对 `api.deepseek.com` + `deepseek-chat/reasoner/coder` 直接拦截图片请求（这些模型会静默忽略图片），前端也会在输入框上方提前提示。
- **智能路由**：当前文章为默认上下文，跨文献 / 整库问题自动检索；信息不足时追问。
- **检索卡片**：`search_web` 的结果带会话全局编号（`cardBase` + 序号 = `idx`），推给界面渲染成卡片；历史消息里每张卡片压成一行摘要（`#N 标题（site · year）`），模型用 `[[card:N]]` 指代，界面渲染为可点击胶囊（滚动到对应卡片并高亮）；本地文献用 `[[cite:<docId>#<page>]]`。
- **进度事件**：长耗时工具（`import_paper` / `fetch_url`）通过 `progress` 回调上报阶段，界面显示转圈 + 阶段 + 已用秒数。

## 联网搜索与读正文 {#websearch}

相关配置（`config.json`）：`search_enabled`（总开关，默认 `false`）、`search_provider`（`tavily` | `bocha` | `deepseek`）、
`search_key_tavily` / `search_key_bocha` / `search_key_deepseek`（各家 Key 分别保存）、`search_scope`（`academic` | `web`）。
开关关闭时联网工具不暴露给模型；`search_web` 需要**当前服务商**有 Key，`fetch_url` 只要有开关（没 Key 就用本机抓取）。
每次请求都会把联网状态（未开启 / 已开启但当前服务商缺 Key / 可用）写进上下文（`webSearchState()`），
避免模型把「缺 Key」说成「没开启」，或在不可用时编造外部资料。
不再调用 arXiv / OpenAlex 的检索接口（曾受 IP 限流）。

### 聚合搜索（`search_web` → `searchWeb()`）

- **查询扇出**：模型给出 1~4 条**英文**受控检索式（可带会议名 / 年份 / `site:` 限定），并行请求（DeepSeek 并发限 2），去重后统一排序。
- **归一化**：各家结果都收敛成 `RawHit{title,url,content,date,site}`，之后共用清洗：
  - 标题剥掉 arXiv 的 `[2509.15459]` 前缀；博查另外剥站点后缀（`… – arxiv` / `… | researchgate`）；
  - 摘要优先从 `Abstract:` 之后截取——arXiv 摘要页常混入 arXivLabs / Announce Type / Subjects / Cite as 等样板，抽不到就留空，不显示噪声；
  - arXiv 编号先看 URL、取不到再从正文里找（`arXiv:…` 写法）；DOI **只从 URL 里识别**（防从摘要里误抓别人的 DOI）。两者决定条目能否一键导入；
  - 去重键：DOI → arXiv 编号 → 归一化 URL（去 `utm_*` / 锚点 / `www`）。
- **排序**：`tier = 学术域名(1) + 带标识符(1)`，同 tier 按年份降序。学术白名单含 arXiv / ar5iv / OpenReview / NeurIPS / CVF / ECVA / PMLR / ACL / AAAI / IJCAI / ACM / IEEE / Springer / ScienceDirect / Nature / Science / PubMed / bioRxiv 等。
- **Tavily**：`POST /search`，`search_depth=basic`、`include_usage`、`include_published_date`；学术时带 `include_domains` + `include_domains_mode`（`prefer` 加权 / `restrict` 限定），`time_range` 透传；用量取 `usage.credits`。
- **博查**：`POST /v1/web-search`，`summary=true`（长摘要比 `snippet` 完整）、`count`、`freshness`（`day/week/month/year` → `oneDay/oneWeek/oneMonth/oneYear`）；字段映射 `name→title`、`summary || snippet→content`、`datePublished || dateLastCrawled→date`。它**没有域名参数、没有 extract、也不返回 credits**，所以 `academic + restrict` 由本地白名单兜底（`prefer` 本来就只是排序加权）。
- **DeepSeek**：`POST https://api.deepseek.com/v1/tools/search`（Bearer 用 DeepSeek Key），`count`、`need_content=false`；字段映射 `summary || snippet→content`、`date→date`、`site_name→site`（本地认不出域名时用作 venue）。检索式按 **128 字符**预算截断（超长直接 400），时间范围转成 `after:YYYY-MM-DD`（比 day/week/month/year 更细）。它同样没有域名参数（`site:` 是 query 语法，26 个学术域名拼不进 128 字符），`academic + restrict` 也走本地白名单；**账号级 5 QPS**，所以四条查询限并发 2，408/429/5xx 等 800ms 重试一次；按请求计费（¥5 / 1000 次，无结果不计费），日志里记「N 次请求」而不是 credits。
- **失败处理**：401/403 → Key 无效、402 → 余额不足、432/433 → 额度用尽、429 → 频繁；所有查询都失败且无结果时抛出错误交给模型，让它如实说明，而不是编造论文。

### 读正文（`fetch_url` → `readPage()`）

预算默认 8000 字（`max_chars` 限 2000~20000），三条路径：

1. **Tavily extract**（配了 Tavily Key 时优先）：`POST /extract`，带上 `query` 让服务端挑相关段落（`chunks_per_source=4`），1 credit / 5 个 URL，超时 25s；返回文本只做长度收敛。
2. **DeepSeek Fetch**（配了 DeepSeek Key 且上一步没取到）：`POST https://api.deepseek.com/v1/tools/fetch`，直接返回 Markdown 正文（`title` + `content`），超时 30s；先走一次内网地址校验（不把 `localhost` / 内网 URL 发给服务商），取回的正文同样用 `pickPassages()` 按 query 挑段。它有域名级 QPS 且对无正文的页面返回 404，所以只作兜底。
3. **本机抓取**（没配 Key 或上面都失败）：`fetchPageText()`
   - 只允许 `http` / `https`；拒绝 `localhost`、`*.local` / `*.internal`、IPv4 私网（`10.` / `127.` / `192.168.` / `172.16-31.` / `169.254.` / `0.` / CGNAT）与 IPv6 私网，**DNS 解析后再校验一次**（防内网域名与 DNS 重绑定）；
   - 手动跟随跳转、最多 4 跳、**每一跳重新校验**；单跳 20s 超时；响应体最大 3MB；
   - `application/pdf` → 落临时文件后调 `engine/extract_text.py`（PyMuPDF）逐页抽文本；HTML → 去 `script/style` / 标签、还原实体、取 `<title>`；其它按纯文本；
   - 再本地挑段落 `pickPassages()`：按空行切段（>40 字），用 `agent/text.ts` 的 `tokenize` 算与 query 的词重合度打分、轻微偏好靠前段落，拼到预算为止，段间用 `---`。

读到的内容一方面以 `read` 事件推给界面（「已读正文」行：站点 · 字数，悬停看途径与完整链接），另一方面作为工具结果回给模型。主进程日志（`websearch:` 前缀）记录每条检索式命中数、`<服务商> 合计 N 条，用量 X credits / N 次请求，耗时 Yms`、`读取 <域名>（<途径>，N 字，Yms）`。

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

仓库根 `tools/`：`build.ps1`（本地打包）、`publish.ps1`（发布，先打包）、`build-docs.ps1`（文档站 `site/` → `docs/`）、`fetch-llm.ps1`（装配 CPU / Vulkan 运行时与 HY-MT 模型）。

## 第三方许可 {#license}

- **PDF.js**（Mozilla，Apache-2.0）：PDF 渲染与文本层。
- **HY-MT**（腾讯混元，Apache-2.0）：本地翻译模型，在应用内按需下载。
- **llama.cpp**（MIT）：本地翻译推理运行时。
- **ONNX Runtime**（MIT，含 DirectML 执行后端）：版面识别。
- **BabelDOC / PyMuPDF**（AGPL-3.0）：随引擎分发的翻译引擎与文本抽取。
- **KaTeX**（MIT）、**react-markdown / remark / rehype**（MIT）：Arxiver 回答渲染。
- 图标集移植自 **Lucide**（ISC）。
