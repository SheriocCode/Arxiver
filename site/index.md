---
layout: home
nav: home
title: Arxiver — 把英文论文读成中文
description: 导入本地 PDF 或 arXiv 链接，用内置本地模型在本机离线翻译；原文 / 对照 / 译文三视图逐页阅读，另有能跨文献问答、联网检索的内置 AI 助手。
badge: 本机离线 · 0 费用
hero: 把英文论文，读成中文
lead: 导入本地 PDF 或 arXiv 链接。内置本地模型在本机完成翻译：约 10 页/分钟、边翻边看，论文不出本机；另有能跨文献问答的内置 AI 助手。
shots:
  - { src: assets/index/首页.jpg, caption: 主界面 }
  - { src: assets/index/翻译.jpg, caption: 翻译与对照 }
  - { src: assets/index/AI助手.jpg, caption: AI 助手 }
  - { src: assets/index/日志追溯.jpg, caption: AI 对话日志 }
  - { src: assets/index/运行状态监控.jpg, caption: 运行状态 }
  - { src: assets/index/设置面板.jpg, caption: 设置 }

compare_title: Why Arxiver?
compare_lead: "我们真正需要的是一个<strong>便携、好用、免费、不需要订阅</strong>的翻译工具，和一个能让 AI 趁手地帮我们<strong>读、理解、管理</strong>论文的地方——而不是一座要精心陈列的图书馆。<strong><u>科研缺的从来不是「摆得更整齐」，而是读得过来、读得明白</u></strong>。"
compare:
  - icon: languages
    label: 论文翻译
    more: 本地模式由 llama.cpp 在本机推理，有 NVIDIA 显卡走 GPU，无独显或驱动不匹配时自动回退 CPU（功能不受影响，速度较慢）。「边翻边看」＝每翻完一页，阅读器里的预览就刷新一次；切到在线模式则改为调用你配置的大模型接口。
    arxiver: { mark: plus, text: "<strong>内置</strong>：默认本机模型离线完成——<strong>约 10 页/分钟</strong>、<strong>0 费用</strong>、<strong>边翻边看</strong>，论文不出本机；<strong>也可切换自定义在线大模型接口</strong>" }
    zotero: { mark: part, text: "无内置，需装第三方插件；多为在线服务（正文发往服务商、额度用完要订阅），通常要整篇翻完才能看" }
  - icon: bot
    label: AI Harness
    more: 助手使用独立配置的 OpenAI 兼容接口，与翻译互不影响；联网搜索默认关闭，开启后可选 Tavily / 博查 / DeepSeek，Key 各存一份。
    arxiver: { mark: plus, text: "<strong>跨文献问答、联网检索与读正文、导入外部论文、改标签 / 分类（写操作先确认），长任务显示进度与已用时间</strong>" }
    zotero: { mark: "no", text: "官方无内置；第三方 AI 插件零散，配置与体验参差" }
  - icon: book-open
    label: 文献库与导入
    arxiver: { mark: equal, text: "分类层级、标签、笔记、回收站、全文检索；粘贴 arXiv 编号 / DOI / 链接即导入并自动补全元信息" }
    zotero: { mark: equal, text: "元数据与检索更完整、浏览器连接器抓取" }
compare_note:
  - "图例：<span class=\"m plus\"></span> 内置或强项 · <span class=\"m equal\"></span> 双方都有 · <span class=\"m part\"></span> 需插件或部分支持 · <span class=\"m no\"></span> 无。"
  - "浏览器扩展、与 Zotero 的双向同步、批注等能力 <strong>已在开发计划中</strong>。"
---

# 下载

- **Windows 安装包** — 双击向导安装，开箱即用。[前往 Releases →](https://github.com/SheriocCode/Arxiver/releases/latest)

1. **安装并启动** 运行 `Arxiver Setup vX.exe`（内置翻译引擎与本地翻译模型）。
2. **直接翻译** 开箱即用：本地模型离线翻译，无需 API Key。
3. **导入并翻译** 导入本地 PDF 或 arXiv 链接，打开后点「翻译」，在阅读器里切换 原文 / 对照 / 译文。
4. （可选）**配置助手** 需要对话式助手时，在「设置 → AI 助手」填入 OpenAI 兼容接口。

- **自动更新** — 内置差量更新，升级只下载变化的块；引擎与翻译模型没变就不会重下。
- **源码（开发者）** — 克隆仓库后进入 `electron-app/`：`npm install` → `npm run dev`。[查看仓库 →](https://github.com/SheriocCode/Arxiver)
