# ============================================================================
# FlashBolt — Windows desktop app activation + launch (PowerShell)
# ----------------------------------------------------------------------------
# Calls the exact same backend activation verdict as the web form and the CLI
# (POST { email, os, password } to {AppUrl}/activate), then launches the
# desktop app. On success the app runs like the browser app step by step:
# first page (landing) -> auth page -> terminal.
#
# Usage:
#   .\flashbolt-windows.ps1 -Email "you@example.com" `
#                           -Password "FB-XXXX-XXXX-XXXX" `
#                           -AppUrl "https://<your-deployment>.convex.cloud"
#
#   -AppPath <path-to-FlashBolt.exe>  (optional; defaults to FlashBolt.exe)
# ============================================================================
param(
  [Parameter(Mandatory = $true)]
  [string]$Email,
  [Parameter(Mandatory = $true)]
  [string]$Password,
  [Parameter(Mandatory = $true)]
  [string]$AppUrl,
  [string]$AppPath = "FlashBolt.exe"
)

$ErrorActionPreference = "Stop"
$os = "windows"

Write-Host ""
Write-Host "FlashBolt — Windows desktop app activation" -ForegroundColor Cyan
Write-Host "  Email    : $Email"
Write-Host "  OS       : $os"
Write-Host "  Endpoint : $AppUrl/activate"
Write-Host ""

if (-not $Email -or $Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
  Write-Host "ERROR: a valid email address is required." -ForegroundColor Red
  exit 1
}
if (-not $Password) {
  Write-Host "ERROR: the activation password is required." -ForegroundColor Red
  exit 1
}

$body = @{ email = $Email; os = $os; password = $Password } | ConvertTo-Json

try {
  $response = Invoke-RestMethod `
    -Uri "$AppUrl/activate" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  Write-Host "ACTIVATION FAILED (HTTP $status)" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
  exit 1
}

if ($response.ok) {
  $count = $response.activationCount
  Write-Host "ACTIVATION SUCCESSFUL — the desktop app is now licensed to run." -ForegroundColor Green
  Write-Host "  Activation #$count — the password stays active for re-use / re-run." -ForegroundColor Green
  if (Test-Path $AppPath) {
    Write-Host "Launching $AppPath ..." -ForegroundColor Cyan
    Start-Process -FilePath $AppPath
  } else {
    Write-Host "NOTE: '$AppPath' not found next to this script — start the desktop app manually."
  }
  exit 0
}

Write-Host "ACTIVATION FAILED — $($response.status)" -ForegroundColor Red
Write-Host "  $($response.message)" -ForegroundColor Yellow
exit 1
