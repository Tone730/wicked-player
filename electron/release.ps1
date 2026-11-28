# ============================================================
# WICKED PLAYER - one-command release publisher (no gh needed)
# Usage:  .\release.ps1 -Bump    (auto-increments version + publishes)
#         .\release.ps1          (republishes current version)
# Every installed copy (1.4.0+) auto-updates within hours.
# ============================================================
param([switch]$Bump)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# credential from Windows Credential Manager (saved when you pushed)
$tokFile = Join-Path $env:USERPROFILE '.wicked-gh-token'
$TOK = $null
if (Test-Path $tokFile) { $TOK = ([System.IO.File]::ReadAllText($tokFile)).Trim() }
if (-not $TOK) {
  $in = "protocol=https`nhost=github.com`n`n"
  $TOK = (($in | git credential fill 2>&1) | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
}
if (-not $TOK) { Write-Host '!! no GitHub token found' -ForegroundColor Red; exit 1 }
$HDR = @{ Authorization = "token $TOK"; 'User-Agent' = 'wicked-release' }

# 1. version
$pkg = Join-Path $PSScriptRoot 'package.json'
$j = Get-Content $pkg -Raw | ConvertFrom-Json
if ($Bump) {
  $parts = $j.version.Split('.'); $parts[2] = [string]([int]$parts[2] + 1)
  $j.version = $parts -join '.'
  [System.IO.File]::WriteAllText($pkg, ($j | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
}
$V = $j.version
Write-Host "== Releasing v$V ==" -ForegroundColor Cyan

# 2. verify the authoritative compiled frontend distribution
Write-Host '[1/3] verifying frontend distribution...' -ForegroundColor Gray
$frontendDist = Join-Path $root 'wicked-frontend\dist'
$indexPath = Join-Path $frontendDist 'index.html'
if (-not (Test-Path $indexPath)) { Write-Host '!! missing compiled frontend index.html' -ForegroundColor Red; exit 1 }
$indexHtml = Get-Content $indexPath -Raw
foreach ($required in @('enhance.js', 'notification-policy.js', 'playback-policy.js')) {
  $path = Join-Path $frontendDist $required
  if (-not (Test-Path $path)) { Write-Host "!! missing frontend asset: $required" -ForegroundColor Red; exit 1 }
  if ($indexHtml -notmatch [regex]::Escape($required)) { Write-Host "!! index.html does not reference $required" -ForegroundColor Red; exit 1 }
}
$requiredBundle = 'assets/index-2kADS7Vh-p4.js'
$bundlePath = Join-Path $frontendDist ($requiredBundle -replace '/', '\')
if (-not (Test-Path $bundlePath)) { Write-Host "!! missing authoritative compiled bundle: $requiredBundle" -ForegroundColor Red; exit 1 }
if ($indexHtml -notmatch [regex]::Escape($requiredBundle)) {
  Write-Host "!! index.html does not reference authoritative bundle: $requiredBundle" -ForegroundColor Red
  exit 1
}
if ($indexHtml -notmatch 'enhance\.js\?ov=19') { Write-Host '!! index.html does not reference enhance.js?ov=19' -ForegroundColor Red; exit 1 }
if ($indexHtml -notmatch 'notification-policy\.js\?ov=1') { Write-Host '!! index.html does not reference notification-policy.js?ov=1' -ForegroundColor Red; exit 1 }
if ($indexHtml -notmatch 'playback-policy\.js\?ov=2') { Write-Host '!! index.html does not reference playback-policy.js?ov=2' -ForegroundColor Red; exit 1 }
if ($indexHtml -notmatch 'index-2kADS7Vh-p4\.js\?v=3515') { Write-Host '!! index.html does not reference the versioned authoritative bundle' -ForegroundColor Red; exit 1 }

# 3. package exe + metadata
Write-Host '[2/3] packaging exe...' -ForegroundColor Gray
Push-Location $PSScriptRoot
try {
  npx.cmd electron-builder -w
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
  node make-latest.js
  if ($LASTEXITCODE -ne 0) { throw "make-latest.js failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$dist = Join-Path $PSScriptRoot 'dist'
$assets = @(
  @{ n = "Wicked-Player-Setup-$V.exe"; p = Join-Path $dist "Wicked Player Setup $V.exe" },
  @{ n = "Wicked-Player-Setup-$V.exe.blockmap"; p = Join-Path $dist "Wicked Player Setup $V.exe.blockmap" },
  @{ n = 'latest.yml'; p = Join-Path $dist 'latest.yml' }
)
foreach ($a in $assets) { if (-not (Test-Path $a.p)) { Write-Host "!! missing $($a.p)" -ForegroundColor Red; exit 1 } }
$latestYml = Get-Content (Join-Path $dist 'latest.yml') -Raw
if ($latestYml -notmatch [regex]::Escape("Wicked-Player-Setup-$V.exe")) {
  Write-Host '!! latest.yml does not reference the published hyphenated installer name' -ForegroundColor Red
  exit 1
}

# 4. publish
Write-Host '[3/3] creating GitHub release...' -ForegroundColor Gray
$body = @{ tag_name = "v$V"; target_commitish = 'master'; name = "Wicked Player v$V"; body = "Auto-update release. Install once, updates forever."; draft = $false; prerelease = $false } | ConvertTo-Json
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Tone730/wicked-player/releases' -Method POST -Headers $HDR -ContentType 'application/json' -Body $body -TimeoutSec 30
} catch {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/Tone730/wicked-player/releases/tags/v$V" -Headers $HDR -TimeoutSec 30
}
$relId = $rel.id

Write-Host '[3/3] uploading assets...' -ForegroundColor Gray
foreach ($a in $assets) {
  $bytes = [System.IO.File]::ReadAllBytes($a.p)
  Invoke-RestMethod -Uri "https://uploads.github.com/repos/Tone730/wicked-player/releases/$relId/assets?name=$($a.n)" -Method POST -Headers @{ Authorization = "token $TOK"; 'Content-Type' = 'application/octet-stream'; 'User-Agent' = 'wicked-release' } -Body $bytes -TimeoutSec 600 | Out-Null
  Write-Host "   uploaded $($a.n)" -ForegroundColor Gray
}
Write-Host "== v$V IS LIVE - every installed copy updates itself within hours ==" -ForegroundColor Green