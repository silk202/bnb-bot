# FlashBolt Setup Script (Windows PowerShell)
# Installs dependencies, provisions Convex, and starts the dev server.
param(
    [switch]$SkipConvex
)

$ErrorActionPreference = "Stop"

function Write-Info  { param([string]$Msg) Write-Host "▸ $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "▸ $Msg" -ForegroundColor Yellow }
function Write-Error { param([string]$Msg) Write-Host "✖ $Msg" -ForegroundColor Red; exit 1 }

# ── Pre-flight checks ──────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required. Install from https://nodejs.org"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Warn "bun not found — installing..."
    powershell -Command "irm bun.sh/install.ps1 | iex"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git is required."
}

Write-Host ""
Write-Host "⚡ FlashBolt Setup" -ForegroundColor Cyan
Write-Host ""

# ── Install dependencies ───────────────────────────────────────────────
Write-Info "Installing dependencies..."
bun install

# ── Provision Convex ───────────────────────────────────────────────────
if (-not $SkipConvex) {
    if (-not (Test-Path ".env.local") -or -not (Select-String -Path ".env.local" -Pattern "VITE_CONVEX_URL" -Quiet)) {
        Write-Info "Provisioning Convex backend..."
        try {
            bunx convex dev --once --configure=new 2>$null
        } catch {
            Write-Warn "Convex provisioning skipped (run 'bunx convex dev' manually)"
        }
    } else {
        Write-Info "Convex already configured (.env.local exists)"
    }
}

# ── Start dev server ───────────────────────────────────────────────────
Write-Info "Starting dev server..."
Write-Host ""
Write-Host "  → http://localhost:5173" -ForegroundColor Cyan
Write-Host ""
bun run dev
