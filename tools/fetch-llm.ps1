# 下载本地翻译运行时（llama.cpp）到 electron-app/engine/llama/，
# 并把 HY-MT2 GGUF 放到 electron-app/data/models/（应用数据目录，安装包里不包含模型）。
# 开发时跑一次即可让「设置 → 本地模型」显示已安装。
#
#   powershell -File tools/fetch-llm.ps1                 # CUDA 版 + Q4_K_M（默认，非 N 卡自动退 CPU）
#   powershell -File tools/fetch-llm.ps1 -Backend cpu    # 仅 CPU 版（包更小）
#   powershell -File tools/fetch-llm.ps1 -CudaVersion 13.4
#   powershell -File tools/fetch-llm.ps1 -Quant Q5_K_M
#
# 说明：
#  - 默认随包 CUDA 版：有 N 卡走 GPU，无 N 卡/CUDA 起不来时 llama.cpp 会自动退回 CPU
#    （已在应用层加 `-ngl 0` 重试兜底），所以一台安装包对所有机器都可用。
#  - llama.cpp 的发布资产用 GitHub CLI（gh）下载，发布流程本就依赖 gh；先 `gh auth login`。
#  - GGUF 用标准 K-quant 仓库（现成 llama.cpp 可直接加载）。官方 tencent GGUF 依赖未合并的
#    STQ kernel，不能用预编译运行时，这里不使用。
#  - 在代理后先设置 $env:HTTPS_PROXY / $env:HTTP_PROXY。

param(
    [ValidateSet("cpu", "cuda", "vulkan")]
    [string]$Backend = "cuda",
    [ValidateSet("Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")]
    [string]$Quant = "Q4_K_M",
    [string]$ModelRepo = "mradermacher/Hy-MT2-1.8B-GGUF",
    # CUDA 版本（仅 -Backend cuda 生效）。默认取可用的最低版本（如 12.4，兼容性最好）。
    [string]$CudaVersion = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root "electron-app/engine"
$llamaDir = Join-Path $engine "llama"
$modelDir = Join-Path $root "electron-app/data/models"
New-Item -ItemType Directory -Force -Path $llamaDir, $modelDir | Out-Null

# ---- llama.cpp --------------------------------------------------------------
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "未找到 GitHub CLI（gh），请安装并执行 gh auth login" }

# llama.cpp 现在用语义化 tag 发版（最新 vX.Y.Z 不带二进制），Windows 二进制挂在 nightly 构建
# （如 b11552）下，因此取"最新一个 release"而不是 "latest"。
Write-Host "查询 llama.cpp 最新 nightly 构建..." -ForegroundColor Cyan
$tag = & gh api "repos/ggml-org/llama.cpp/releases?per_page=1" --jq '.[0].tag_name'
if ($LASTEXITCODE -ne 0 -or -not $tag) { throw "无法获取 llama.cpp 发布信息；先执行 gh auth login" }
$names = & gh api "repos/ggml-org/llama.cpp/releases/tags/$tag" --jq '.assets[].name'
Write-Host "使用构建 $tag" -ForegroundColor Cyan

$picks = @()
switch ($Backend) {
    "cpu"    { $picks = $names | Where-Object { $_ -match '^llama-.*-bin-win-cpu-x64\.zip$' } }
    "vulkan" { $picks = $names | Where-Object { $_ -match '^llama-.*-bin-win-vulkan-x64\.zip$' } }
    "cuda"   {
        if ($CudaVersion) {
            $main = $names | Where-Object { $_ -match "^llama-.*-bin-win-cuda-$([regex]::Escape($CudaVersion))-x64\.zip$" } | Select-Object -First 1
        } else {
            # 取最低可用版本（12.x 对驱动更宽容），可用 -CudaVersion 指定。
            $main = $names | Where-Object { $_ -match '^llama-.*-bin-win-cuda-([\d.]+)-x64\.zip$' } | Sort-Object | Select-Object -First 1
        }
        $ver = ""
        if ($main -match '-cuda-([\d.]+)-x64\.zip$') { $ver = $Matches[1] }
        $picks = @($main) + ($names | Where-Object { $ver -and $_ -match "^cudart-.*-win-cuda-$([regex]::Escape($ver))-x64\.zip$" })
    }
}
$picks = @($picks | Where-Object { $_ })
if ($picks.Count -eq 0) { throw "未找到 backend '$Backend' 对应的 Windows 资产" }

$tmp = Join-Path $env:TEMP ("llama-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
foreach ($asset in $picks) {
    Write-Host "下载 $asset ..." -ForegroundColor Cyan
    & gh release download $tag --repo ggml-org/llama.cpp --pattern $asset --dir $tmp --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release download 失败：$asset" }
}

Write-Host "解压到 engine/llama ..." -ForegroundColor Cyan
Get-ChildItem $tmp -Filter *.zip | ForEach-Object { Expand-Archive -Path $_.FullName -DestinationPath $tmp -Force }
Get-ChildItem $tmp -Recurse -Include *.exe, *.dll | ForEach-Object { Copy-Item $_.FullName $llamaDir -Force }
Remove-Item $tmp -Recurse -Force

# ---- model ------------------------------------------------------------------
$fileName = "Hy-MT2-1.8B.$Quant.gguf"
$url = "https://huggingface.co/$ModelRepo/resolve/main/$fileName"
$target = Join-Path $modelDir "hy-mt2-1.8b-$($Quant.ToLower()).gguf"
Write-Host "下载模型 $fileName -> $target ..." -ForegroundColor Cyan
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L -C - --fail -o $target $url
    if ($LASTEXITCODE -ne 0) { throw "下载模型失败：$url" }
} else {
    Invoke-WebRequest -Uri $url -OutFile $target
}

Write-Host ""
Write-Host "完成：" -ForegroundColor Green
Write-Host "  运行时  $llamaDir"
Write-Host "  模型    $target"
# 开发仓库里如果已经有版面模型，顺手放进 data/models，省得打开应用后再下载
$layout = Join-Path $engine "assets/models/doclayout_yolo_docstructbench_imgsz1024.onnx"
if (Test-Path $layout) {
    Copy-Item $layout (Join-Path $modelDir "doclayout_yolo_docstructbench_imgsz1024.onnx") -Force
    Write-Host "  版面模型 $modelDir\doclayout_yolo_docstructbench_imgsz1024.onnx"
}

Write-Host "提示：打包只要求 engine/llama/llama-server.exe；模型不随安装包分发。"
