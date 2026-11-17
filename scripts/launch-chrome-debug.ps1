param(
  [int]$Port = 9222,
  [string]$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\AgyDebugProfile"
)

$ChromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$ChromeExe = $ChromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ChromeExe) {
  Write-Error "chrome.exe not found in standard installation paths."
  exit 1
}

try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
  if ($resp.StatusCode -eq 200) {
    Write-Host "Chrome CDP is already listening on http://127.0.0.1:$Port"
    exit 0
  }
} catch {
  # Port not active yet; proceed to launch Chrome.
}

if (-not (Test-Path $UserDataDir)) {
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
}

Start-Process -FilePath $ChromeExe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`""
)

Write-Host "Launched Chrome with CDP on http://127.0.0.1:$Port (profile: $UserDataDir)"
