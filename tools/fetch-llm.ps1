# 装配本地翻译运行时（llama.cpp）与 HY-MT2 模型：
#   - CPU 版运行时 -> electron-app/engine/llama/（随安装包分发）
#   - Vulkan 版运行时 -> electron-app/data/runtime/vulkan/（开发时模拟应用内下载的 GPU 加速包）
#   - HY-MT2 GGUF -> electron-app/data/models/
#
#   powershell -File tools/fetch-llm.ps1
#   powershell -File tools/fetch-llm.ps1 -Quant Q5_K_M
#   powershell -File tools/fetch-llm.ps1 -SkipGpu     # 不下载 GPU 加速包
#
# 说明：
#  - 三处的 llama.cpp 都取自同一个 nightly 构建（默认 b11889），与应用里 GPU 加速包
#    校验的版本一致；升级时同步修改这里的 -Tag 与 src/main/models.ts 的 GPU 规格。
#  - 只保留 llama-server 和它需要的 DLL，官方压缩包里的 cli / bench 等工具不装。
#  - llama.cpp 的发布资产用 GitHub CLI（gh）下载，发布流程本就依赖 gh；先 `gh auth login`。
#  - GGUF 用标准 K-quant 仓库（现成 llama.cpp 可直接加载）。官方 tencent GGUF 依赖未合并的
#    STQ kernel，不能用预编译运行时，这里不使用。
#  - 在代理后先设置 $env:HTTPS_PROXY / $env:HTTP_PROXY。

param(
    [ValidateSet("Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")]
    [string]$Quant = "Q4_K_M",
    [string]$ModelRepo = "mradermacher/Hy-MT2-1.8B-GGUF",
    [string]$Tag = "b11889",
    [switch]$SkipGpu
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root "electron-app/engine"
$llamaDir = Join-Path $engine "llama"
$dataDir = Join-Path $root "electron-app/data"
$modelDir = Join-Path $dataDir "models"
$gpuDir = Join-Path $dataDir "runtime/vulkan"
New-Item -ItemType Directory -Force -Path $llamaDir, $modelDir | Out-Null

# 只留 llama-server 需要的文件
function Trim-Runtime([string]$dir) {
    Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -ne "llama-server.exe" } | Remove-Item -Force
    Get-ChildItem $dir -Filter "llama-*-impl.dll" |
        Where-Object { $_.Name -match '^llama-(batched-bench|bench|cli|completion|fit-params|perplexity|quantize)-impl\.dll$' } |
        Remove-Item -Force
    Remove-Item (Join-Path $dir "ggml-rpc.dll") -Force -ErrorAction SilentlyContinue
}

function Get-LlamaAsset([string]$name, [string]$dest) {
    Write-Host "下载 $name ..." -ForegroundColor Cyan
    & gh release download $Tag --repo ggml-org/llama.cpp --pattern $name --dir $dest --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release download 失败：$name" }
    $zip = Join-Path $dest $name
    $out = Join-Path $dest ([IO.Path]::GetFileNameWithoutExtension($name))
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Expand-Archive -Path $zip -DestinationPath $out -Force
    Remove-Item $zip -Force
    return $out
}

# ---- runtime ----------------------------------------------------------------
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "未找到 GitHub CLI（gh），请安装并执行 gh auth login" }

$tmp = Join-Path $env:TEMP ("llama-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "== CPU 运行时 ==" -ForegroundColor Cyan
$cpu = Get-LlamaAsset "llama-$Tag-bin-win-cpu-x64.zip" $tmp
Get-ChildItem $cpu -File | Copy-Item -Destination $llamaDir -Force
Trim-Runtime $llamaDir

if (-not $SkipGpu) {
    Write-Host "== GPU 加速包（Vulkan）==" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $gpuDir | Out-Null
    $vulkan = Get-LlamaAsset "llama-$Tag-bin-win-vulkan-x64.zip" $tmp
    Get-ChildItem $vulkan -File | Copy-Item -Destination $gpuDir -Force
    Trim-Runtime $gpuDir
    # 与 src/main/models.ts 的 GPU 规格一致：应用据此判断加速包是否已安装
    Set-Content -Path (Join-Path $gpuDir ".version") -Value "llama-$Tag-bin-win-vulkan-x64.zip" -Encoding ascii -NoNewline
}

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
Write-Host "  CPU 运行时  $llamaDir"
if (-not $SkipGpu) { Write-Host "  GPU 加速包  $gpuDir" }
Write-Host "  模型        $target"

# 开发仓库里如果已经有版面模型，顺手放进 data/models，省得打开应用后再下载
$layout = Join-Path $engine "assets/models/doclayout_yolo_docstructbench_imgsz1024.onnx"
if (Test-Path $layout) {
    Copy-Item $layout (Join-Path $modelDir "doclayout_yolo_docstructbench_imgsz1024.onnx") -Force
    Write-Host "  版面模型    $modelDir\\doclayout_yolo_docstructbench_imgsz1024.onnx"
}

Write-Host "提示：打包只要求 engine/llama/llama-server.exe；模型与 GPU 加速包都不随安装包分发。"
