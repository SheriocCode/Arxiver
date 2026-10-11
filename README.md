<p align="center">
  <img src="icons/logo.svg" height="50" alt="">
  &#160;&#160;
  <img src="icons/arxiver_black.svg#gh-light-mode-only" height="50" alt="Arxiver">
  <img src="icons/arxiver.svg#gh-dark-mode-only" height="50" alt="Arxiver">
</p>

<p align="center">在桌面端翻译 arXiv 论文与本地 PDF，并阅读双语对照 —— 全程在本机完成。</p>

<p align="center">
  <a href="https://sherioccode.github.io/Arxiver/">官网</a> ·
  <a href="https://github.com/SheriocCode/Arxiver/releases/latest">下载</a> ·
  <a href="https://sherioccode.github.io/Arxiver/guide.html">文档</a> ·
  <a href="https://sherioccode.github.io/Arxiver/changelog.html">更新日志</a>
</p>

## 快速开始

1. 从 [Releases](https://github.com/SheriocCode/Arxiver/releases/latest) 下载并运行安装包。
2. 首次启动即可直接翻译：**内置本地翻译模型在本机离线运行，无需 API Key**。
3. 导入本地 PDF 或粘贴 arXiv 链接，打开后点「翻译」；在阅读器里切换 原文 / 对照 / 译文。
4. （可选）需要对话式助手时，在「设置 → AI 助手」填入 OpenAI 兼容的接口。

## 特性

- **桌面文献库**：导入、分类、标签、回收站、阅读历史与检索；导入的 PDF 与本机数据不出本机。
- **双语对照阅读器**：原文/对照/译文三视图，单页/双页、缩放、目录大纲与缩略图、页面主题（护眼/米黄/暗色）。
- **内置本地翻译（离线）**：随应用分发 HY-MT 翻译模型（llama.cpp），安装即用、无需 API Key、离线完成；有 NVIDIA 显卡走 GPU，无独显自动回退 CPU。
- **段落块框与引用跳转**：原文页叠加段落矩形，悬停显示「原文 → 译文」；引用悬停预览目标页、点击跳转。
- **Arxiver 助手**：基于当前文章与整库的对话式检索，回答带可点击引用；可跨文献、`@` 引用已打开文献、
  执行标签/元数据等写操作（需确认）；支持历史会话与选中文本提问。使用独立配置的在线接口，与翻译互不影响。

## 开发

```powershell
cd electron-app
npm install
npm run dev        # 开发运行
npm run typecheck  # tsc（node + web）
npm run build      # electron-vite 构建
npm run dist       # 打包安装包（electron-builder）
```

本地打包用 `tools/build.ps1`，发布用 `tools/publish.ps1`（详见 `NOTES.local.md`）；文档站见 `site/`（构建产物 `docs/`，`tools/build-docs.ps1`）。

## 第三方许可

- **PDF.js**（Mozilla，Apache-2.0）：PDF 渲染与文本层。
- **HY-MT**（腾讯混元，Apache-2.0）：随应用分发的本地翻译模型。
- **llama.cpp**（MIT）：本地翻译推理运行时。
- **ONNX Runtime**（MIT，含 DirectML 执行后端）：版面识别。
- **BabelDOC / PyMuPDF**（AGPL-3.0）：随引擎分发的翻译引擎与文本抽取。
- **KaTeX**（MIT）、**react-markdown / remark / rehype**（MIT）：Arxiver 回答渲染。
- 图标集移植自 **Lucide**（ISC）。
