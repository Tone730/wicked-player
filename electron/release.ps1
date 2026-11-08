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

# 2. frontend build
Write-Host '[1/4] building frontend...' -ForegroundColor Gray
Push-Location (Join-Path $root 'wicked-frontend'); npm run build 2>&1 | Out-Null; Pop-Location

# 3. package exe + metadata
Write-Host '[2/4] packaging exe...' -ForegroundColor Gray
Push-Location $PSScriptRoot; npx electron-builder -w 2>&1 | Out-Null; node make-latest.js; Pop-Location

$dist = Join-Path $PSScriptRoot 'dist'
$assets = @(
  @{ n = "Wicked.Player.Setup.$V.exe"; p = Join-Path $dist "Wicked Player Setup $V.exe" },
  @{ n = "Wicked.Player.Setup.$V.exe.blockmap"; p = Join-Path $dist "Wicked Player Setup $V.exe.blockmap" },
  @{ n = 'latest.yml'; p = Join-Path $dist 'latest.yml' }
)
foreach ($a in $assets) { if (-not (Test-Path $a.p)) { Write-Host "!! missing $($a.p)" -ForegroundColor Red; exit 1 } }

# 4. publish
Write-Host '[3/4] creating GitHub release...' -ForegroundColor Gray
$body = @{ tag_name = "v$V"; target_commitish = 'master'; name = "Wicked Player v$V"; body = "Auto-update release. Install once, updates forever."; draft = $false; prerelease = $false } | ConvertTo-Json
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Tone730/wicked-player/releases' -Method POST -Headers $HDR -ContentType 'application/json' -Body $body -TimeoutSec 30
} catch {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/Tone730/wicked-player/releases/tags/v$V" -Headers $HDR -TimeoutSec 30
}
$relId = $rel.id

Write-Host '[4/4] uploading assets...' -ForegroundColor Gray
foreach ($a in $assets) {
  $bytes = [System.IO.File]::ReadAllBytes($a.p)
  Invoke-RestMethod -Uri "https://uploads.github.com/repos/Tone730/wicked-player/releases/$relId/assets?name=$($a.n)" -Method POST -Headers @{ Authorization = "token $TOK"; 'Content-Type' = 'application/octet-stream'; 'User-Agent' = 'wicked-release' } -Body $bytes -TimeoutSec 600 | Out-Null
  Write-Host "   uploaded $($a.n)" -ForegroundColor Gray
}
Write-Host "== v$V IS LIVE - every installed copy updates itself within hours ==" -ForegroundColor Green