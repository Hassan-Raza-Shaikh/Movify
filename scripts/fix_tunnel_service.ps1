<#
  Make the Cloudflare tunnel PERMANENT by forcing the auto-start "Cloudflared"
  Windows service onto --protocol http2 (this network blocks QUIC/UDP-7844, so
  the default makes the service restart-loop and the domain returns Bad Gateway).

  Edits the service's ImagePath in the registry (deterministic; no env-var
  guessing) and restarts the service. Run it ONCE. It self-elevates to admin.

    powershell -ExecutionPolicy Bypass -File scripts\fix_tunnel_service.ps1
#>
$ErrorActionPreference = 'Stop'

# Self-elevate if not already admin
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Requesting administrator rights...' -ForegroundColor Yellow
    Start-Process powershell "-ExecutionPolicy Bypass -NoProfile -File `"$PSCommandPath`"" -Verb RunAs
    return
}

$key = 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared'
$img = (Get-ItemProperty $key -ErrorAction Stop).ImagePath
Write-Host "Current: $($img -replace '(--token\s+)\S+','$1<TOKEN>')"

if ($img -match '--protocol\s+http2') {
    Write-Host 'Service is already on http2 — nothing to change.' -ForegroundColor Green
} else {
    # Insert "--protocol http2" before the `run` subcommand.
    $new = $img -replace '(\btunnel)\s+run\b', '$1 --protocol http2 run'
    if ($new -eq $img) { throw "Could not find 'tunnel run' in ImagePath; aborting to avoid breaking the service." }
    Set-ItemProperty -Path $key -Name ImagePath -Value $new
    Write-Host 'Updated service ImagePath to use http2.' -ForegroundColor Green
}

Write-Host 'Restarting Cloudflared service...' -ForegroundColor Cyan
Restart-Service Cloudflared -Force
Start-Sleep -Seconds 6
$svc = Get-Service Cloudflared
Write-Host ("Service status: " + $svc.Status) -ForegroundColor Green
Write-Host 'Done. The tunnel now reconnects on http2 automatically on every boot.'
Write-Host 'Press Enter to close...'; [void][System.Console]::ReadLine()
