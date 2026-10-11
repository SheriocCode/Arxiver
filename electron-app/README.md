# Arxiver — Electron 桌面端

独立的 Electron 桌面版：把原来的原生托盘启动器、本机 HTTP 服务、网页控制台与浏览器扩展
合并成**一个桌面应用**。翻译仍然用随附的本机 Python 引擎（`engine/`），全程本机完成。

技术栈：**electron-vite + React + TypeScript**。

## 架构

```
electron-vite
├─ src/main (主进程, TS)
│   ├─ EngineManager        起 engine/runtime/python.exe，流式解析 ENGINE_* 进度
│   ├─ config / storage / library   配置、翻译缓存、文库（userData/）
│   ├─ 托盘 + 单实例 + 窗口
│   └─ IPC 处理（ipcMain）
├─ src/preload (contextBridge → window.api)
└─ src/renderer (React)
    ├─ App / Rail / Sidebar / 各视图组件（翻译台 / 文库 / 记录 / 设置）
    ├─ viewer/engine.ts   命令式 PDF 对照 + 阅读引擎（pdf.js：对照、逐页预览、块框、单/双页）
    └─ state/useLibrary.ts  文库状态与筛选逻辑

engine/  python 引擎（随安装包 extraResources 分发，不进 asar）
resources/  应用图标
```

引擎通过 **CLI + stdout 标记 + 事件目录** 与主进程对接：

- 参数：`source.pdf -li -lo -s -o [-p -t -f] [--babeldoc] [--skip-subset-fonts] [--ignore-cache] [--prompt 文件] [--partial-dir] [--events-dir]`
- 环境变量：`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`
- 输出：stdout 的 `ENGINE_PARTIAL/ENGINE_BLOCK/ENGINE_PAGE_START/ENGINE_PAGE_PROGRESS`，
  以及 `events/engine-events.jsonl`（逐块原文/译文）与 `partials/partial-*.pdf`（增量预览）

## 目录

| 路径            | 说明                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `src/main/`     | 主进程 TS：`index.ts`、`engine.ts`、`config.ts`、`storage.ts`、`library.ts`、`paths.ts` |
| `src/preload/`  | `index.ts`：contextBridge 暴露 `window.api`（类型见 `src/shared/types.ts`） |
| `src/renderer/` | React 应用：`index.html`、`src/main.tsx`、`App.tsx`、`components/*`、`state/*`、`viewer/engine.ts`、`styles.css`、`public/`（pdf.js、图标） |
| `src/shared/`   | 主进程 / 渲染层共享类型（IPC 契约）                                       |
| `engine/`       | Python 引擎副本（runtime / site-packages / assets）                       |
| `resources/`    | 应用图标（`icon.ico`）                                                    |
| `zj_assets/`    | 设计参考（`design.md` 及原型截图）                                        |

## 开发

```powershell
cd electron-app
npm install
npm run dev        # electron-vite dev（渲染层热更新）
npm run typecheck  # tsc 类型检查（node + web）
```

首次翻译前，在「设置 → 模型接口」填入接口地址、密钥与模型。

## 打包

```powershell
npm run dist       # electron-vite build + electron-builder
```

`electron-builder` 会把 `engine/` 与图标作为 `extraResources` 放到安装目录（不进 asar），
产物在 `dist/`。注意安装包会较大（引擎约 500 MB）。

## 与旧版的关系

- `engine/` 是从仓库根复制来的**独立副本**，可整体替换为新引擎版本。
- 本应用**不依赖**原 `server/server.py`、`launcher/` 或浏览器扩展；它们仍可独立使用。
