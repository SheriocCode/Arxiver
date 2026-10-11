---
layout: page
nav: changelog
title: 更新日志 — Arxiver
description: Arxiver 版本更新历史。
---
# 更新日志

全部版本见 [GitHub Releases](https://github.com/SheriocCode/Arxiver/releases)。

## 桌面版（Electron）

以 Electron 桌面应用取代原「浏览器扩展 + 本机服务 + 托盘启动器」组合。

- **桌面文献库**：导入、分类、标签、回收站、阅读历史与检索。
- **双语对照阅读器**：原文 / 对照 / 译文三视图，单页 / 双页、缩放、目录大纲、缩略图、页面主题。
- **内嵌引擎**：随应用分发的本地翻译引擎，仅调用用户配置的模型接口。
- **段落块框与引用**：悬停显示「原文 → 译文」；引用预览目标页、点击跳转。
- **Arxiver 助手**：基于当前文章与整库的对话式检索、可点击引用、`@` 引用已打开文献、选中文本提问；
  标签 / 元数据等写操作经人机协作确认；会话持久化与历史。
- **自动更新**：`electron-builder`（NSIS）+ `electron-updater` 差量更新，未变的大文件不重复下载。
