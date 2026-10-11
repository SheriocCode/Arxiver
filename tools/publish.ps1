# 把已构建好的安装包发布到 GitHub Release（不负责打包——先跑 tools/build.ps1）。
#
#   powershell -File tools/publish.ps1 -Version 0.7.0
#   powershell -File tools/publish.ps1 -Version 0.7.0 -NotesFile notes/v0.7.0.md
#   powershell -File tools/publish.ps1            # 版本取 electron-app/package.json
#
# 步骤：提交版本号改动 -> git tag & push -> 用 gh 上传安装包 / blockmap / latest.yml。
#
# 前置：
#   - GitHub CLI：gh auth login（代理后先设 $env:HTTPS_PROXY）
#   - 已执行 tools/build.ps1，electron-app/dist/ 里有对应版本的产物

param(
    [string]$Version = "",
    [string]$Notes = "",
    [string]$NotesFile = "",
    [string]$Repo = "",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "electron-app"
Set-Location $root

function Fail([string]$message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }
function Assert-Ok([string]$what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" } }

# ---- 0. 前置检查 ------------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "GitHub CLI (gh) not found; install and run 'gh auth login'" }
$null = & gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { Fail "gh is not authenticated; run 'gh auth login'" }
if (-not $Repo) { $Repo = (& gh repo view --json nameWithOwner -q .nameWithOwner 2>$null) }
$Repo = ("$Repo").Trim()
if (-not $Repo) { Fail "cannot determine repo; pass -Repo owner/name" }

# ---- 1. 版本号 --------------------------------------------------------------
$pkgPath = Join-Path $app "package.json"
$pkgVersion = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
if (-not $Version) { $Version = $pkgVersion }
if ($Version -ne $pkgVersion) { Fail "版本不一致：参数 $Version vs package.json $pkgVersion（请先跑 tools/build.ps1 -Version $Version）" }
$tag = "v$Version"

# ---- 2. 产物确认 ------------------------------------------------------------
$out = Join-Path $app "dist"
$assets = @(Get-ChildItem $out -File -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -match '\.(exe|blockmap)$' -and $_.Name -like "*$Version*") -or $_.Name -eq "latest.yml"
} | ForEach-Object { $_.FullName })
if ($assets.Count -eq 0) { Fail "dist/ 里没有 $Version 的产物；请先跑 tools/build.ps1 -Version $Version" }
foreach ($asset in $assets) {
    $leaf = Split-Path $asset -Leaf
    if ($leaf -match ' ') { Fail "产物名含空格：$leaf。GitHub 会把空格改成点，导致与 latest.yml 里的文件名不一致、更新下载 404。请确认 electron-builder 的 artifactName 不含空格后重新打包。" }
}
Write-Host "publishing $tag ($($assets.Count) assets)" -ForegroundColor Cyan

# ---- 3. 提交版本号改动 ------------------------------------------------------
git add "electron-app/package.json"
$null = git diff --cached --quiet 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host "no version change to commit" }
else { git commit -m "chore(release): $tag"; Assert-Ok "git commit version"; git push origin $Branch; Assert-Ok "git push $Branch" }

# ---- 4. tag + push ----------------------------------------------------------
if (-not (git tag --list $tag)) { git tag $tag; Assert-Ok "git tag" }
git push origin $tag; Assert-Ok "git push tag"

# ---- 5. 发布说明 ------------------------------------------------------------
if (-not $NotesFile -and (Test-Path "RELEASE_NOTES.md")) { $NotesFile = "RELEASE_NOTES.md" }
$notesPath = ""
if ($NotesFile) {
    if (-not (Test-Path $NotesFile)) { Fail "notes file not found: $NotesFile" }
    $notesPath = (Resolve-Path $NotesFile).Path
    Write-Host "using release notes: $notesPath" -ForegroundColor Cyan
} elseif (-not $Notes) {
    $Notes = "Release $tag"
}

# ---- 6. 创建 / 更新 Release（先不带资产；见第 7 步逐个上传）------------------
$null = & gh release view $tag 2>&1
if ($LASTEXITCODE -ne 0) {
    if ($notesPath) { & gh release create $tag --title $tag --notes-file $notesPath } else { & gh release create $tag --title $tag --notes $Notes }
    Assert-Ok "gh release create"
} elseif ($notesPath) {
    & gh release edit $tag --notes-file $notesPath; Assert-Ok "gh release edit notes"
}

# 草稿对 electron-updater 不可见，确保是正式发布。
& gh release edit $tag --draft=false; Assert-Ok "gh release edit --draft=false"

# ---- 7. 逐个上传资产（curl，有进度条；先删同名避免 HTTP 422）----------------
# gh 自带上传没有进度显示，大文件（~2GB）容易以为卡死；这里用 curl 直接 POST 到
# uploads.github.com，进程内能看到进度。资产名必须与 latest.yml 里的 url 完全一致。
$releaseId = (& gh api "repos/$Repo/releases/tags/$tag" --jq .id).Trim()
if (-not $releaseId) { Fail "无法获取 release id（$Repo $tag）" }
$token = (& gh auth token).Trim()
foreach ($asset in $assets) {
    $name = Split-Path $asset -Leaf
    & gh release delete-asset $tag $name --repo $Repo --yes 2>$null | Out-Null
    Write-Host "上传 $name ..." -ForegroundColor Cyan
    & curl.exe --progress-bar -X POST -H "Expect:" `
        -H "Authorization: Bearer $token" `
        -H "Content-Type: application/octet-stream" `
        --upload-file "$asset" `
        "https://uploads.github.com/repos/$Repo/releases/$releaseId/assets?name=$name"
    if ($LASTEXITCODE -ne 0) { Fail "上传失败：$name" }
}

Write-Host "published $tag" -ForegroundColor Green

# ---- 8. 文档站提醒 ----------------------------------------------------------
$siteDir = Join-Path $root "site"
if (Test-Path $siteDir) {
    Write-Host ""
    Write-Host "Post-release checklist:" -ForegroundColor Cyan
    Write-Host "  [ ] update site/changelog.md (and home page if needed)"
    Write-Host "  [ ] powershell -File tools/build-docs.ps1"
    Write-Host "  [ ] git add site docs && git commit && git push origin $Branch"
}
