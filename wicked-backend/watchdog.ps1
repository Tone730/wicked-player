# Wicked Player backend watchdog (v2 - HTTP probe)
# If the app doesn't answer on http://localhost:5000, start it (hidden).
$up = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:5000/api/status" -UseBasicParsing -TimeoutSec 4
    if ($r.StatusCode -eq 200) { $up = $true }
} catch { $up = $false }

if (-not $up) {
    $dir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $log = Join-Path $dir "backend.log"
    "[$(Get-Date -Format s)] watchdog: app not answering on 5000 - restarting" | Out-File $log -Append -Encoding utf8

    # Kill any zombie node holding the port but not serving
    Get-Process -Name node -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "C:\Program Files\nodejs*" } |
        ForEach-Object {
            try {
                $dead = $true
                try {
                    $t = Invoke-WebRequest -Uri "http://localhost:5000/api/status" -UseBasicParsing -TimeoutSec 2
                    if ($t.StatusCode -eq 200) { $dead = $false }
                } catch { $dead = $true }
                if ($dead) { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
            } catch {}
        }
    Start-Sleep -Seconds 1

    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$dir\start-backend-hidden.vbs`"" -WindowStyle Hidden
}
