param(
  [switch]$Uninstall,
  [switch]$PurgeData,
  [switch]$CheckOnly,
  [switch]$AutoInstall,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\agy-chrome-use'
$SetupScript = Join-Path $PSScriptRoot 'setup.mjs'

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $combined = @($machinePath, $userPath) | Where-Object { $_ }
  if ($combined.Count -gt 0) {
    $env:PATH = ($combined -join ';')
  }
}

function Get-NodeStatus {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    return @{ Ok = $false; Version = $null; Major = 0 }
  }
  try {
    $ver = (& node -p "process.versions.node" 2>$null).Trim()
    $major = [int]($ver.Split('.')[0])
    return @{ Ok = ($major -ge 20); Version = $ver; Major = $major }
  } catch {
    return @{ Ok = $false; Version = $null; Major = 0 }
  }
}

function Get-NpmReady {
  return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

function Find-ChromeExe {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  foreach ($regPath in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
  )) {
    if (Test-Path $regPath) {
      $val = (Get-ItemProperty $regPath -ErrorAction SilentlyContinue).'(default)'
      if ($val -and (Test-Path $val)) { return $val }
    }
  }
  $cmd = Get-Command chrome -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Path $cmd.Source)) { return $cmd.Source }
  return $null
}

if ($Uninstall) {
  $nodeStatus = Get-NodeStatus
  if ($nodeStatus.Ok -and (Test-Path $SetupScript)) {
    $argsList = @($SetupScript, '--uninstall', '--runtime-root', $PluginRoot)
    if ($PurgeData) { $argsList += '--purge-data' }
    & node @argsList
    exit $LASTEXITCODE
  }

  if (Test-Path $TargetDir) {
    $item = Get-Item $TargetDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      cmd /c rmdir "`"$TargetDir`""
    } else {
      Remove-Item $TargetDir -Recurse -Force
    }
    Write-Host "Removed plugin bundle at $TargetDir"
  } else {
    Write-Host "Plugin bundle not found at $TargetDir"
  }
  exit 0
}

$nodeStatus = Get-NodeStatus
$npmReady = Get-NpmReady
$chromeExe = Find-ChromeExe

if (-not $nodeStatus.Ok -or -not $npmReady -or -not $chromeExe) {
  Write-Host '=== AGY Chrome Use Pre-Flight Check ===' -ForegroundColor Cyan
  if ($nodeStatus.Ok) {
    Write-Host "Node.js (>=20): [OK] v$($nodeStatus.Version)" -ForegroundColor Green
  } elseif ($nodeStatus.Version) {
    Write-Host "Node.js (>=20): [FAIL] v$($nodeStatus.Version) is too old" -ForegroundColor Red
  } else {
    Write-Host 'Node.js (>=20): [FAIL] not installed' -ForegroundColor Red
  }
  Write-Host ("npm:            " + $(if ($npmReady) { '[OK]' } else { '[FAIL] not installed' })) -ForegroundColor $(if ($npmReady) { 'Green' } else { 'Red' })
  Write-Host ("Google Chrome:  " + $(if ($chromeExe) { "[OK] $chromeExe" } else { '[FAIL] not installed' })) -ForegroundColor $(if ($chromeExe) { 'Green' } else { 'Red' })

  if ($CheckOnly) {
    Write-Host "`n[REFUSED] Environment check failed. Install missing prerequisites or run with -AutoInstall." -ForegroundColor Red
    exit 1
  }

  $canPrompt = [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
  $shouldAutoInstall = $AutoInstall.IsPresent
  if (-not $shouldAutoInstall -and $canPrompt) {
    $answer = Read-Host 'Environment requirements are not met. Install missing prerequisites automatically via winget now? [y/N]'
    if ($answer -match '^(y|yes)$') {
      $shouldAutoInstall = $true
    }
  }

  if (-not $shouldAutoInstall) {
    Write-Host "`n[REFUSED] Installation aborted because required environment is missing." -ForegroundColor Red
    Write-Host 'Run again with -AutoInstall to install Node.js LTS / Google Chrome automatically via winget, or install them manually:'
    if (-not $nodeStatus.Ok -or -not $npmReady) { Write-Host '  - Node.js >= 20 LTS: https://nodejs.org/' }
    if (-not $chromeExe) { Write-Host '  - Google Chrome:     https://www.google.com/chrome/' }
    exit 1
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Error 'winget is not available on this system. Please install Node.js >= 20 (https://nodejs.org/) and Google Chrome (https://www.google.com/chrome/) manually.'
    exit 1
  }

  if (-not $nodeStatus.Ok -or -not $npmReady) {
    Write-Host 'Installing Node.js LTS via winget...' -ForegroundColor Yellow
    & winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      Write-Error 'Failed to install Node.js LTS via winget.'
      exit 1
    }
    Refresh-ProcessPath
  }

  if (-not $chromeExe) {
    Write-Host 'Installing Google Chrome via winget...' -ForegroundColor Yellow
    & winget install --id Google.Chrome --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      Write-Error 'Failed to install Google Chrome via winget.'
      exit 1
    }
    Refresh-ProcessPath
  }

  $nodeStatus = Get-NodeStatus
  $npmReady = Get-NpmReady
  $chromeExe = Find-ChromeExe
  if (-not $nodeStatus.Ok -or -not $npmReady -or -not $chromeExe) {
    Write-Error 'Prerequisites were installed, but the current shell cannot locate node/npm/chrome yet. Please open a new PowerShell window and re-run install-local.ps1.'
    exit 1
  }
}

$setupArgs = @($SetupScript, '--runtime-root', $PluginRoot)
if ($CheckOnly) { $setupArgs += '--check-only' }
if ($NoVerify) { $setupArgs += '--no-verify' }

& node @setupArgs
exit $LASTEXITCODE
