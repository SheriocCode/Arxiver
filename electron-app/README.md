# Arxiver — Electron 桌面端

独立的 Electron 桌面版：把原来的原生托盘启动器、本机 HTTP 服务、网页控制台与浏览器扩展
合并成**一个桌面应用**。翻译用随附的本机引擎（`engine/`）与内置的 HY-MT 模型**离线**完成；
Arxiver 助手另用独立配置的在线接口。

技术栈：**electron-vite + React + TypeScript**。

## 架构

```
electron-vite
├─ src/main (主进程, TS)
│   ├─ EngineManager        起 engine/runtime/python.exe，流式解析 ENGINE_* 进度
│   ├─ localmodel           本地翻译服务：按需拉起 engine/llama/llama-server，复用并退出回收
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
- 环境变量：`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`（由「翻译引擎」配置映射而来：本地模式指向内置 `llama-server`，在线模式指向你配置的接口）
- 输出：stdout 的 `ENGINE_PARTIAL/ENGINE_BLOCK/ENGINE_PAGE_START/ENGINE_PAGE_PROGRESS`，
  以及 `events/engine-events.jsonl`（逐块原文/译文）与 `partials/partial-*.pdf`（增量预览）

## 目录

| 路径            | 说明                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `src/main/`     | 主进程 TS：`index.ts`、`engine.ts`、`localmodel.ts`、`config.ts`、`storage.ts`、`library.ts`、`paths.ts` |
| `src/preload/`  | `index.ts`：contextBridge 暴露 `window.api`（类型见 `src/shared/types.ts`） |
| `src/renderer/` | React 应用：`index.html`、`src/main.tsx`、`App.tsx`、`components/*`、`state/*`、`viewer/engine.ts`、`styles.css`、`public/`（pdf.js、图标） |
| `src/shared/`   | 主进程 / 渲染层共享类型（IPC 契约）                                       |
| `engine/`       | 本机翻译引擎：源码（`translate_engine/`、`run.py` 等，进 git）+ 运行时/模型（`runtime/ site-packages/ assets/ llama/ models/`，不进 git，见 `engine/README.md`） |
| `resources/`    | 应用图标（`icon.ico`）                                                    |
| `zj_assets/`    | 设计参考（`design.md` 及原型截图）                                        |

## 开发

```powershell
cd electron-app
npm install
npm run dev        # electron-vite dev（渲染层热更新）
npm run typecheck  # tsc 类型检查（node + web）
```

首次翻译即可用（**内置本地模型**，首次会自动加载，约数秒）。需要 Arxiver 助手时，在「设置 → AI 助手」填入 OpenAI 兼容的接口。

## 打包

```powershell
npm run dist       # electron-vite build + electron-builder
```

`electron-builder` 会把 `engine/` 与图标作为 `extraResources` 放到安装目录（不进 asar），
产物在 `dist/`。安装包较大（约 1.9 GB）：含本地翻译运行时（llama.cpp，CUDA 版）与 HY-MT 模型。
仓库根的 `tools/build.ps1` 负责本地打包、`tools/publish.ps1` 负责发布（详见 `NOTES.local.md`）。

## 与旧版的关系

- `engine/` 为本应用自带：**源码进 git**（`translate_engine/`、`run.py` 等），运行时与模型不进 git（见 `engine/README.md`）。
- 本应用**不依赖**原 `server/server.py`、`launcher/` 或浏览器扩展。
