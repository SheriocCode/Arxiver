# 本地打包 Electron 桌面应用（NSIS 安装包）。产物在 electron-app/dist/。
#
#   powershell -File tools/build.ps1                 # 用 electron-app/package.json 里的版本打包
#   powershell -File tools/build.ps1 -Version 0.7.0  # 先改 package.json 版本，再打包
#
# 只做本地构建：不提交 git、不打标签、不上传 GitHub。发布另跑 tools/publish.ps1。
# 前置见 NOTES.local.md（engine/ 就绪；已跑过 tools/fetch-llm.ps1）。

param(
    [string]$Version = "",
    [switch]$SkipTypecheck
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "electron-app"
Set-Location $root

function Fail([string]$message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

$pkgPath = Join-Path $app "package.json"

# 可选：更新版本号（只改文件，不提交；由发布步骤提交）。
if ($Version) {
    $re = [regex]'("version"\s*:\s*")[^"]*(")'
    $raw = Get-Content $pkgPath -Raw -Encoding UTF8
    $new = $re.Replace($raw, { param($m) $m.Groups[1].Value + $Version + $m.Groups[2].Value }, 1)
    [System.IO.File]::WriteAllText($pkgPath, $new, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "版本已改为 $Version" -ForegroundColor Cyan
}
$version = (Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "开始打包 Arxiver $version" -ForegroundColor Cyan

# 引擎就绪检查（安装包会打进 engine/）。
if (-not (Test-Path (Join-Path $app "engine"))) { Fail "缺少 electron-app/engine（安装包需要打包引擎）" }
if (-not (Test-Path (Join-Path $app "engine/llama/llama-server.exe"))) { Fail "缺少 engine/llama/llama-server.exe，请先跑 tools/fetch-llm.ps1" }
if (-not (Get-ChildItem (Join-Path $app "engine/models") -Filter *.gguf -ErrorAction SilentlyContinue)) { Fail "缺少 engine/models/*.gguf，请先跑 tools/fetch-llm.ps1" }

# 清掉上次产物，避免旧版本残留。
$out = Join-Path $app "dist"
if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force }

Push-Location $app
if (-not $SkipTypecheck) {
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "typecheck 失败" }
}
npm run dist
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "electron-builder 打包失败" }
Pop-Location

# 校验和
Get-ChildItem $out -File | Where-Object { $_.Name -like "*$version*.exe" } | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
} | Set-Content -Path (Join-Path $out "SHA256SUMS") -Encoding ascii

# GitHub Release 单个资产上限 2 GiB，超出将无法上传。
foreach ($installer in (Get-ChildItem $out -File | Where-Object { $_.Name -like "*$version*.exe" })) {
    if ($installer.Length -ge 2GB) {
        Write-Host "警告：$($installer.Name) 为 $([math]::Round($installer.Length / 1GB, 2)) GiB，超过 GitHub Release 单资产上限 2 GiB，发布会失败。" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "打包完成：$version" -ForegroundColor Green
Get-ChildItem $out -File | Where-Object { $_.Name -match '\.(exe|blockmap)$' -or $_.Name -eq "latest.yml" } |
    Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
Write-Host "本地可先安装/试运行 electron-app/dist 下的安装包与 latest.yml。"
Write-Host "确认无误后发布：powershell -File tools/publish.ps1 -Version $version" -ForegroundColor Yellow
