# PowerShell Setup Script for Hisab Local GPU AI Receipt Reader

Write-Host "==========================================" -ForegroundColor Cyans
Write-Host " Hisab Local GPU AI Receipt Reader Setup  " -ForegroundColor Cyans
Write-Host "==========================================" -ForegroundColor Cyans

# Check if winget or ollama is installed
if (-not (Get-Command "ollama" -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama is not installed yet." -ForegroundColor Yellow
    Write-Host "Installing Ollama via winget..." -ForegroundColor Green
    winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements
} else {
    Write-Host "[✓] Ollama command line found." -ForegroundColor Green
}

# Ensure Ollama service is running
Write-Host "Checking Ollama service status..." -ForegroundColor Green
$ollamaProc = Get-Process "ollama" -ErrorAction SilentlyContinue
if (-not $ollamaProc) {
    Write-Host "Starting Ollama server background process..." -ForegroundColor Yellow
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# Pull LLaVA vision model
Write-Host "Pulling 'llava' vision model (runs on your RTX 5060 Ti 16GB eGPU)..." -ForegroundColor Green
ollama pull llava

# Install python dependencies for local wrapper if needed
Write-Host "Installing Python requirements (flask, requests)..." -ForegroundColor Green
pip install flask requests --quiet

Write-Host "==========================================" -ForegroundColor Cyans
Write-Host " Setup complete! Starting local receipt AI reader server... " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyans

python "$PSScriptRoot\receipt_reader_server.py"
