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
Arxiver ─▶ 主进程检索 storage/*/text.json（BM25）+ 读正文，调用（独立配置的）在线接口流式作答
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
`text.json`）、`storage/conversations/`（Arxiver 会话）、`config.json`（设置）。详见[文档](../guide.html#storage)。

## Arxiver 助手 {#agent}

- **模型**：OpenAI 兼容 `chat/completions`（流式、function calling、usage），读取 `config.json` 中的 `chat_*` 配置（与翻译接口分离）。
- **只读工具**：`list_library`、`search_library`、`read_document`、`search_in_document`（基于 `text.json` 的 BM25）。
- **写入工具**：`update_metadata`、`apply_tags`、`set_flags`、`move_to_trash`、`restore_from_trash`、`add_to_collection` —— 均需用户在确认卡片中批准。
- **智能路由**：当前文章为默认上下文，跨文献/整库问题自动检索；信息不足时追问。

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
