<#
  Nautilus launcher — starts the app (single worker) + a Cloudflare tunnel.

  IMPORTANT: this network blocks Cloudflare's default QUIC (UDP 7844), so the
  tunnel is forced onto --protocol http2 (TCP 443). Without that it fails with
  "control stream encountered a failure" on a backoff loop.

  Usage (from anywhere):
    powershell -ExecutionPolicy Bypass -File scripts\serve_nautilus.ps1
    powershell -ExecutionPolicy Bypass -File scripts\serve_nautilus.ps1 -Named   # stable URL via TUNNEL_TOKEN
#>
param([switch]$Named)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$py   = Join-Path $proj '.venv\Scripts\python.exe'
$cf   = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$env:PYTHONUTF8 = '1'

# 1) App on 127.0.0.1:8000 (skip if already serving) — MUST stay single-worker:
#    watch-party rooms live in process memory (src/api/watchparty.py).
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

# 2) Cloudflare tunnel (always http2 here)
if ($Named) {
    # Stable URL via the named tunnel in .env. Requires a Public Hostname route
    # in the CF Zero Trust dashboard: Networks > Tunnels > <tunnel> > Public
    # Hostname > <your subdomain> -> http://localhost:8000
    $line = Get-Content (Join-Path $proj '.env') | Where-Object { $_ -match '^\s*TUNNEL_TOKEN\s*=' } | Select-Object -First 1
    $tok  = (($line -split '=',2)[1]).Trim().Trim('"')
    Write-Host 'Opening NAMED Cloudflare tunnel (stable hostname, http2)...' -ForegroundColor Cyan
    & $cf tunnel --no-autoupdate --protocol http2 --metrics 127.0.0.1:20299 run --token $tok
} else {
    # Quick tunnel: zero-config, but the *.trycloudflare.com URL changes each run.
    Write-Host 'Opening QUICK Cloudflare tunnel (http2) — watch for the URL below:' -ForegroundColor Cyan
    & $cf tunnel --no-autoupdate --protocol http2 --url http://localhost:8000
}
