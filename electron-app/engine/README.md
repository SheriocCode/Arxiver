# engine

Electron 桌面端的 PDF 翻译引擎（基于 PDFMathTranslate / babeldoc 的本地封装）。
由 `electron-app/src/main/engine.ts` 以子进程方式调用 `run.py`。

## 目录说明

**进 git（引擎源码）：**

| 路径 | 说明 |
| --- | --- |
| `run.py` | 启动引导：把引擎根目录与 `site-packages` 加入 `sys.path`，恢复离线 assets，转交 CLI 参数 |
| `extract_text.py` | 用内置 PyMuPDF 提取逐页文本（供 AI 助手检索） |
| `outline.py` | 目录（大纲）：优先读 PDF 自带书签；没有书签时用 PyMuPDF 启发式识别标题生成 |
| `pdfmeta.py` | 探测 PDF 自带元信息（标题/作者）并扫描首页里的 arXiv 编号 / DOI，供本地导入时自动补全 |
| `translate_engine/` | 引擎源码主体（本仓库维护） |
| `requirements.txt` | `site-packages` 的第三方依赖清单 |
| `VERSION` | 引擎版本；引擎有实质更新时 bump（见 `NOTES.local.md`） |

**不进 git（运行时/模型，由脚本装配，随安装包分发）：**

| 路径 | 说明 |
| --- | --- |
| `runtime/` | 嵌入式 Python 运行时（`python.exe`） |
| `site-packages/` | 第三方依赖（按 `requirements.txt` 安装） |
| `assets/` | 离线资源：`fonts/`、`models/`（doclayout ONNX）、`tiktoken/` |
| `llama/` | llama.cpp 运行时（`llama-server.exe` 等） |
| `models/` | 本地翻译模型（HY-MT GGUF） |

## 装配

- **llama.cpp + HY-MT 模型**：仓库根执行 `powershell -File tools/fetch-llm.ps1`（默认 CUDA 版）。
- **python 运行时 / site-packages / assets**：由引擎构建流程装配——嵌入式 Python，`pip install
  -r requirements.txt` 到 `site-packages/`，字体 / ONNX 模型 / tiktoken 缓存放入 `assets/`。
- `translate_engine` 已从 `site-packages/` 抽出到本目录，安装依赖时**不要**再安装 `translate-engine` 包。
- 版面识别依赖 **`onnxruntime-directml`**（`requirements.txt` 里声明）：优先走 DirectML（任意 DX12
  显卡，实测约 6–10 倍于 CPU），无 DX12 设备 / 驱动不匹配时由 `translate_engine/doclayout.py`
  自动回退 CPU。这是 `onnxruntime` 与 `onnxruntime-directml` 二选一，**不要同时安装**。

## 路径与 sys.path

嵌入式 Python 的 `runtime/python312._pth` 只包含 `python312.zip` 与 `.`，因此 `run.py` 会把
`engine/`（源码）与 `engine/site-packages/`（依赖）都加入 `sys.path`。调用方永远通过
`engine/run.py` 入口，`paths.ts` 也只依赖 `run.py`、`runtime/python.exe`、`llama/`、`models/` 的位置。
