# AGENTS

主产品是 **Electron 桌面应用**，源码在 `electron-app/`（构建/校验/UI 约定见 `electron-app/AGENTS.md`）。
根目录其余为品牌资源（`icons/`）、发布脚本（`tools/`）与文档站（`site/` → `docs/`）。

## 通用约定

- **精简优先，不做向后兼容**：一切以当前版本为准。不要为旧配置/端口/路径/数据格式写兼容、迁移、
  兜底代码；破坏性变更只改当前实现并提示用户更新；发现冗余兼容代码主动移除。
- 不引入无关依赖。改动后跑相关校验：
  - Electron 端：`cd electron-app && npm run typecheck && npm run build`。
  - 脚本：`powershell -File tools/...` 本地运行验证。

## 文档站点（已迁到个人站）

- 线上地址 <https://sherioccode.github.io/arxiver/>，源码在 `../SheriocCode.github.io/`。
- 概览、使用文档、参考、更新日志**合并为一页**：`../SheriocCode.github.io/_pages/arxiver.md`；
  左侧目录在 front matter `toc:` 维护，版式在 `_layouts/manual.html`。
- 本仓库 `docs/` 只保留旧地址（`/Arxiver/...`）的跳转页，**不要在这里加内容**。
- 需要改文档时直接改 `_pages/arxiver.md`（更新日志是同一页的最后一段），提交推送个人站仓库即可。
- **内容以 Electron 桌面应用为准**；旧扩展 / 本机服务 / 托盘启动器的内容一律删除。
- 约定：代码块用 `~~~` 围栏；图片放 `../SheriocCode.github.io/arxiver/assets/index/`；
  标题锚点用 `## 标题 {#id}`。

## 发布（手动，勿主动执行）

- 发布由人工执行；**不要**在无关任务里 bump 版本或发版。
- 基于 Electron 构建（`electron-builder` + 差量更新），见 `NOTES.local.md` 与 `tools/publish.ps1`。
- 发布前：bump `electron-app/package.json` 的 `version`；引擎有变则更新 `electron-app/engine/VERSION`。
- 发布后**同步文档**：更新 `../SheriocCode.github.io/_pages/arxiver.md` 的更新日志段，在个人站仓库提交并推送。
