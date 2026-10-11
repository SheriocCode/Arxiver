---
layout: home
nav: home
title: Arxiver — 在桌面端翻译 arXiv 论文
description: 在桌面端翻译 arXiv 论文与本地 PDF，全程在本机完成。Electron 桌面应用 + 内嵌本机翻译引擎。
badge: 本机·桌面
hero: 在桌面端翻译 arXiv 论文
lead: 导入本地或 arXiv PDF，在原文 / 对照 / 译文三视图中逐页阅读译文。全程在本机完成——只调用你自己配置的模型接口。
shots:
  - { src: assets/index/1791694144413.png, caption: 主界面 }
  - { src: assets/index/1791694236791.png, caption: 翻译与对照 }
  - { src: assets/index/1791694183469.png, caption: 系统日志 }
---

# 核心特点

- **桌面文献库** — 导入、分类、标签、回收站、阅读历史与检索；文件与本机数据不出本机。
- **双语对照阅读器** — 原文 / 对照 / 译文三视图，单页 / 双页、缩放、目录大纲与缩略图、页面主题（护眼 / 米黄 / 暗色）。
- **内嵌翻译引擎** — 随应用分发的本机引擎负责解析与翻译，只调用你配置的模型 API。
- **段落块框与引用** — 原文页叠加段落矩形，悬停显示「原文 → 译文」；悬浮引用预览目标页、点击跳转。
- **Arxiver 助手** — 基于当前文章与整库的对话式检索，回答带可点击引用；可跨文献、`@` 引用已打开文献，并可执行标签 / 元数据等写操作（需确认）。
- **差量自动更新** — 内置自动更新，只下载变化的块；未变的大文件（如引擎）不会重复下载。

# 下载

- **Windows 安装包** — 双击向导安装，开箱即用。[前往 Releases →](https://github.com/SheriocCode/Arxiver/releases/latest)

1. **安装并启动** 运行 `Arxiver Setup vX.exe`（内置翻译引擎）。
2. **配置模型** 在「设置 → 模型接口」填入 OpenAI 兼容的地址 / 密钥 / 模型并保存。
3. **导入并翻译** 导入本地 PDF 或 arXiv 链接，打开后点「翻译」，在阅读器里切换 原文 / 对照 / 译文。

- **源码（开发者）** — 克隆仓库后进入 `electron-app/`：`npm install` → `npm run dev`。[查看仓库 →](https://github.com/SheriocCode/Arxiver)
