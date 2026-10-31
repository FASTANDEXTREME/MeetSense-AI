# Windows PowerShell launcher for MeetSenseAI
$ErrorActionPreference = "Stop"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host " Starting MeetSenseAI (Windows Mode)  " -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

if (-not (Test-Path "venv")) {
    Write-Host "--> Creating Python virtual environment..."
    python -m venv venv
}

Write-Host "--> Installing Python backend dependencies..."
.\venv\Scripts\pip.exe install -r requirements.txt

if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "--> Installing Node.js frontend dependencies..."
    Push-Location frontend
    npm install --legacy-peer-deps
    Pop-Location
}

Write-Host "--> Starting FastAPI Backend on http://localhost:8000 ..."
$backendProc = Start-Process -FilePath ".\venv\Scripts\uvicorn.exe" -ArgumentList "app.main:app --host 0.0.0.0 --port 8000" -PassThru -NoNewWindow

try {
    Write-Host "--> Starting React Frontend on http://localhost:3000 ..."
    Push-Location frontend
    $env:PORT = "3000"
    npm start
}
finally {
    Pop-Location -ErrorAction SilentlyContinue
    if ($backendProc -and -not $backendProc.HasExited) {
        Write-Host "Stopping backend..."
        Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    }
}

