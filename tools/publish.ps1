# One-command local release for the Electron desktop app.
#
#   powershell -File tools/publish.ps1 -Version 0.6.0
#   powershell -File tools/publish.ps1 -Version 0.6.0 -Notes "本次更新说明"
#
# Steps: bump electron-app/package.json version -> electron-builder 打包（NSIS）-> 写入校验和
# -> tag & push -> 把安装包 / blockmap / latest.yml 上传到 GitHub Release。
#
# electron-builder 会生成 NSIS 差量更新所需的 *.exe.blockmap 与 latest.yml；electron-updater
# 据此只下载变化的块（引擎文件未变时不会被重新下载）。
#
# Prerequisites (one-time):
#   - GitHub CLI: `gh auth login`（在代理后先设置 $env:HTTPS_PROXY）
#   - 打包环境见 electron-app（electron-builder；Windows 打 NSIS）
#   - engine/ 已就绪（会随安装包一起打进去）

param(
    [string]$Version = "",
    [string]$Notes = "",
    [string]$NotesFile = "",
    [string]$Repo = "",
    [string]$Branch = "main"
)

# Native tools (gh/git) write progress to stderr; keep going and check exit codes.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "electron-app"
Set-Location $root

function Fail([string]$message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }
function Assert-Ok([string]$what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" } }

# ---- 0. prerequisites -------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "GitHub CLI (gh) not found; install and run 'gh auth login'" }
$null = & gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { Fail "gh is not authenticated; run 'gh auth login'" }
if (-not $Repo) { $Repo = (& gh repo view --json nameWithOwner -q .nameWithOwner 2>$null) }
$Repo = ("$Repo").Trim()
if (-not $Repo) { Fail "cannot determine repo; pass -Repo owner/name" }

# ---- 1. version / engine version -------------------------------------------
$pkgPath = Join-Path $app "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if ($Version) {
    $pkg.version = $Version
    [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
}
$version = $pkg.version
$tag = "v$version"
$engine = ""
if (Test-Path (Join-Path $app "engine/VERSION")) { $engine = (Get-Content (Join-Path $app "engine/VERSION") -Raw).Trim() }
Write-Host "publishing $tag  (engine=$engine)" -ForegroundColor Cyan

# ---- 1b. commit the version bump so the tag includes it ---------------------
git add "electron-app/package.json"
$null = git diff --cached --quiet 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host "no version change to commit" }
else { git commit -m "chore(release): $tag"; Assert-Ok "git commit version"; git push origin $Branch; Assert-Ok "git push $Branch" }

# ---- 2. build (electron-builder, NSIS) --------------------------------------
$out = Join-Path $app "dist"
# clean previous outputs so stale artifacts from earlier versions aren't uploaded
if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force }

Push-Location $app
if (-not (Test-Path "engine")) { Fail "electron-app/engine not found; the installer bundles the engine" }
npm run typecheck; Assert-Ok "typecheck"
npm run dist; Assert-Ok "electron-builder"
Pop-Location

# upload only this version's artifacts (plus latest.yml)
$assets = @(Get-ChildItem $out -File | Where-Object {
    ($_.Name -match '\.(exe|blockmap)$' -and $_.Name -like "*$version*") -or $_.Name -eq "latest.yml"
} | ForEach-Object { $_.FullName })
if ($assets.Count -eq 0) { Fail "no build assets for $version in $out" }

# ---- 3. checksums -----------------------------------------------------------
Get-ChildItem $out -File | Where-Object { $_.Name -like "*$version*.exe" } | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
} | Set-Content -Path (Join-Path $out "SHA256SUMS") -Encoding ascii

# ---- 4. tag + release -------------------------------------------------------
if (-not (git tag --list $tag)) { git tag $tag; Assert-Ok "git tag" }
git push origin $tag; Assert-Ok "git push tag"

# Release notes: prefer a file (avoids command-line quoting/wrapping issues).
if (-not $NotesFile -and (Test-Path "RELEASE_NOTES.md")) { $NotesFile = "RELEASE_NOTES.md" }
$notesPath = ""
if ($NotesFile) {
    if (-not (Test-Path $NotesFile)) { Fail "notes file not found: $NotesFile" }
    $notesPath = (Resolve-Path $NotesFile).Path
    Write-Host "using release notes: $notesPath" -ForegroundColor Cyan
} elseif (-not $Notes) {
    $Notes = "Release $tag"
}

$null = & gh release view $tag 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "release $tag exists; uploading assets"
    & gh release upload $tag @assets --clobber; Assert-Ok "gh release upload"
    if ($notesPath) { & gh release edit $tag --notes-file $notesPath; Assert-Ok "gh release edit notes" }
} elseif ($notesPath) {
    & gh release create $tag @assets --title $tag --notes-file $notesPath; Assert-Ok "gh release create"
} else {
    & gh release create $tag @assets --title $tag --notes $Notes; Assert-Ok "gh release create"
}

Write-Host "published $tag" -ForegroundColor Green

# ---- 5. docs site reminder --------------------------------------------------
$siteDir = Join-Path $root "site"
if (Test-Path $siteDir) {
    Write-Host ""
    Write-Host "Post-release checklist:" -ForegroundColor Cyan
    Write-Host "  [ ] update site/changelog.md (and home page if needed)"
    Write-Host "  [ ] powershell -File tools/build-docs.ps1"
    Write-Host "  [ ] git add site docs && git commit && git push origin $Branch"
}
