---
layout: doc
nav: guide
title: 文档 — Arxiver
description: Arxiver 桌面应用的安装、配置与使用文档。
toc:
  - title: 安装与启动
    id: install
  - title: 翻译引擎
    id: model
  - title: 导入与阅读
    id: read
  - title: 翻译
    id: translate
  - title: Arxiver 助手
    id: arxiver
  - title: 设置
    id: settings
  - title: 数据与存储
    id: storage
  - title: 更新
    id: update
  - title: 故障排查
    id: troubleshoot
---

## 安装与启动 {#install}

1. 在[下载页](https://github.com/SheriocCode/Arxiver/releases/latest)获取 `Arxiver Setup vX.exe`，双击按向导安装（可选择安装目录）。
2. 启动后即为桌面应用，无需浏览器扩展、无需单独启动任何服务。

## 翻译引擎 {#model}

翻译**开箱即用**：内置本地翻译模型（HY-MT + llama.cpp）在本机离线运行，无需 API Key；有 NVIDIA 显卡走 GPU，无独显自动回退 CPU。

- 「设置 → 翻译引擎」可切换为**在线接口**（OpenAI 兼容），或调整本地模型的 GPU 层数 / 额外参数。
- Arxiver 助手使用**独立**的在线接口，在「设置 → AI 助手」配置（与翻译互不影响）。

> 本地翻译与版面识别均在本机完成，数据不出本机；仅在线接口与 Arxiver 助手会访问你配置的服务。

## 导入与阅读 {#read}

- 「新建文献」可导入本地 PDF，或粘贴 arXiv 链接/编号自动下载。
- 文库支持分类、标签、星标、回收站、阅读历史与全文检索（标签页 / 年份 / 状态等）。
- 双击条目打开阅读器：**原文 / 对照 / 译文** 三视图，支持单页 / 双页、缩放、目录大纲、缩略图与页面主题（护眼 / 米黄 / 暗色）。

## 翻译 {#translate}

- 在阅读器工具栏点「翻译」（有译文时为「已翻译」）→ 右侧下拉可设 源语言 / 目标语言 / 导出格式 / 页数，也可「重新翻译」。
- 「已翻译」的下拉会列出该文献的多个译文版本，可切换。
- 翻译过程中顶部显示进度（已完成页数 / 当前页块进度）；可取消。完成后可「保存」导出 PDF。
- 相同 PDF 与参数再次翻译会命中本地缓存。

## Arxiver 助手 {#arxiver}

右侧「Arxiver」标签是基于文库的对话式助手：

- **自动路由**：默认针对当前文章；涉及其它文献或整库问题时自动检索，必要时会向你追问。
- **引用跳转**：回答带 `第 N 页` 胶囊，点击跳转到原文。
- **`@` 引用**：在输入框输入 `@` 选择其它已打开文献作为额外上下文（跨文献对比）。
- **选中文本提问**：在 PDF 里选中文字 → 点「问 Arxiver」。
- **写操作需确认**：改标签 / 元数据 / 星标 / 回收站 / 分类等，会先弹出确认卡片（批准 / 修改 / 拒绝）。
- 会话自动保存，右上角可查看历史（含关联论文，可搜索）。

## 设置 {#settings}

「设置」包含：翻译引擎（本地 / 在线）、通用、外观（主题 / 字号）、引用、AI 助手、同步与存储、快捷键、关于（版本与检查更新）。

## 数据与存储 {#storage}

本机数据位于 `%APPDATA%\Arxiver\`：

~~~
storage/
  index.json                 # 文库元数据（条目 / 分类 / 标签 / 历史）
  <docId>/                   # 每个条目一个文件夹
    paper.pdf                # 原始 PDF
    <cacheKey>.dual.pdf      # 双语译文
    <cacheKey>.mono.pdf      # 仅译文
    <cacheKey>.blocks.jsonl  # 块框数据
    text.json                # 全文检索用文本
  conversations/             # Arxiver 会话
config.json                  # 设置
~~~

## 更新 {#update}

应用内置自动更新（`electron-updater`）：启动时自动检查，也可在「设置 → 关于 → 检查更新」。更新只下载变化的块，未变的大文件（如引擎）不会重复下载；下载完成后点「重启并安装」。

## 故障排查 {#troubleshoot}

- **翻译失败**：本地模式下确认 `engine/llama` 运行时与 `engine/models` 模型齐备（安装包已内置）；也可在「设置 → 翻译引擎」切换为在线接口并填写地址 / 密钥 / 模型。阅读器顶部会显示错误。
- **首次翻译较慢**：首次会自动加载本地模型并缓存字体 / 版面模型（约数秒），之后变快。
- **源文件缺失**：条目对应的 `storage/<docId>/paper.pdf` 丢失时无法打开，需重新导入。
- **助手无响应**：确认「设置 → AI 助手」的接口地址 / 密钥 / 模型正确、网络可达，且已在「AI 助手」中启用。
