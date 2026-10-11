# AGENTS

主产品是 **Electron 桌面应用**，源码在 `electron-app/`（构建/校验/UI 约定见 `electron-app/AGENTS.md`）。
根目录其余为品牌资源（`icons/`）、发布脚本（`tools/`）与文档站（`site/` → `docs/`）。

## 通用约定

- **精简优先，不做向后兼容**：一切以当前版本为准。不要为旧配置/端口/路径/数据格式写兼容、迁移、
  兜底代码；破坏性变更只改当前实现并提示用户更新；发现冗余兼容代码主动移除。
- 不引入无关依赖。改动后跑相关校验：
  - Electron 端：`cd electron-app && npm run typecheck && npm run build`。
  - 脚本：`powershell -File tools/...` 本地运行验证。

## 文档站点（site/ → docs/）

- 源在 `site/`（Jekyll：Markdown + `_layouts` + `assets`），产物在 `docs/`（GitHub Pages 发布目录，含 `.nojekyll`）。
- **内容以 Electron 桌面应用为准**；旧扩展 / 本机服务 / 托盘启动器的内容一律删除。
- **仅当本次任务改动了面向用户的内容**时才动它：改 `site/` → `powershell -File tools/build-docs.ps1` →
  一并提交 `site/` 与 `docs/`。不手改 `docs/`（是产物）。
- 约定：代码块用 `~~~` 围栏；图片放 `site/assets/img|index/`，Markdown 用相对路径；标题锚点用
  `## 标题 {#id}`，左侧目录在 front matter `toc:` 维护；新增页面设 `layout: doc` 并在
  `site/_layouts/default.html` 导航里加一项。

## 发布（手动，勿主动执行）

- 发布由人工执行；**不要**在无关任务里 bump 版本或发版。
- 基于 Electron 构建（`electron-builder` + 差量更新），见 `NOTES.local.md` 与 `tools/publish.ps1`。
- 发布前：bump `electron-app/package.json` 的 `version`；引擎有变则更新 `electron-app/engine/VERSION`。
- 发布后**同步文档**：更新 `site/changelog.md` → `build-docs.ps1` → 提交 `docs/`。
