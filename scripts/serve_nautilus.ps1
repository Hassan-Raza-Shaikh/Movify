<#
  Nautilus launcher — starts the app + the stable Cloudflare tunnel.
  Run this to bring the site back at https://stream.nautilusea.app

    powershell -ExecutionPolicy Bypass -File scripts\serve_nautilus.ps1
    powershell -ExecutionPolicy Bypass -File scripts\serve_nautilus.ps1 -Quick   # ephemeral *.trycloudflare.com URL instead

  NOTE: this network blocks Cloudflare QUIC (UDP 7844), so the tunnel is forced
  onto --protocol http2 (TCP 443).
#>
param([switch]$Quick)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$py   = Join-Path $proj '.venv\Scripts\python.exe'
$cf   = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$env:PYTHONUTF8 = '1'

# 1) App on 127.0.0.1:8000 (skip if already serving). Keep it single-worker.
if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host 'Starting Nautilus on http://127.0.0.1:8000 ...' -ForegroundColor Cyan
    Start-Process -FilePath $py `
        -ArgumentList '-m','uvicorn','src.api.main:app','--host','127.0.0.1','--port','8000' `
        -WorkingDirectory $proj -WindowStyle Minimized
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 750
        if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { break }
    }
    Write-Host 'App is up.' -ForegroundColor Green
} else {
    Write-Host 'App already running on :8000.' -ForegroundColor Green
}

# 2) Cloudflare tunnel (always http2). Kill any stale connector first.
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Milliseconds 500

if ($Quick) {
    Write-Host 'Opening QUICK tunnel (ephemeral URL below)...' -ForegroundColor Cyan
    & $cf tunnel --no-autoupdate --protocol http2 --url http://localhost:8000
} else {
    # Stable hostname (stream.nautilusea.app). Uses the installed Cloudflared
    # service's tunnel token from the registry — the .env TUNNEL_TOKEN is a
    # dead/deleted tunnel.
    $img = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared' -ErrorAction SilentlyContinue).ImagePath
    if ($img -and $img -match '--token\s+(\S+)') {
        $tok = $Matches[1].Trim('"')
        Write-Host 'Opening stable tunnel (http2) -> https://stream.nautilusea.app ...' -ForegroundColor Cyan
        & $cf tunnel --no-autoupdate --protocol http2 run --token $tok
    } else {
        Write-Host 'Service token not found; using a quick tunnel instead.' -ForegroundColor Yellow
        & $cf tunnel --no-autoupdate --protocol http2 --url http://localhost:8000
    }
}
