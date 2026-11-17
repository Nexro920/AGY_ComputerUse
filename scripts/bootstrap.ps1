param(
  [string]$RepoUrl = 'https://github.com/Nexro920/AGY_ComputerUse.git',
  [string]$ZipUrl = 'https://github.com/Nexro920/AGY_ComputerUse/archive/refs/heads/main.zip',
  [switch]$Uninstall,
  [switch]$PurgeData,
  [switch]$CheckOnly,
  [switch]$AutoInstall,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$DataRoot = Join-Path $env:USERPROFILE '.gemini\config\plugin-data\agy-chrome-use'
$RuntimeDir = Join-Path $DataRoot 'runtime'

if ($Uninstall) {
  $localInstaller = Join-Path $RuntimeDir 'scripts\install-local.ps1'
  if (Test-Path $localInstaller) {
    $uArgs = @('-Uninstall')
    if ($PurgeData) { $uArgs += '-PurgeData' }
    & $localInstaller @uArgs
  } else {
    $targetDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\agy-chrome-use'
    if (Test-Path $targetDir) {
      Remove-Item $targetDir -Recurse -Force
      Write-Host "Removed plugin bundle at $targetDir"
    }
    if ($PurgeData -and (Test-Path $DataRoot)) {
      Remove-Item $DataRoot -Recurse -Force
      Write-Host "Purged plugin data at $DataRoot"
    }
  }
  if ($PurgeData -and (Test-Path $RuntimeDir)) {
    Remove-Item $RuntimeDir -Recurse -Force
  }
  exit 0
}

if (-not (Test-Path $DataRoot)) {
  New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
  if (Test-Path (Join-Path $RuntimeDir '.git')) {
    Write-Host "Updating existing runtime in $RuntimeDir..." -ForegroundColor Cyan
    & git -C $RuntimeDir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'git pull failed; continuing with existing runtime checkout.'
    }
  } else {
    if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
    Write-Host "Cloning $RepoUrl into $RuntimeDir..." -ForegroundColor Cyan
    & git clone --depth 1 $RepoUrl $RuntimeDir
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Failed to clone $RepoUrl"
      exit 1
    }
  }
} else {
  $tempZip = Join-Path $env:TEMP ("agy-chrome-use-" + [guid]::NewGuid().ToString('N') + '.zip')
  $tempExtract = Join-Path $env:TEMP ("agy-chrome-use-extract-" + [guid]::NewGuid().ToString('N'))
  try {
    Write-Host "Downloading runtime archive from $ZipUrl..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $tempZip -UseBasicParsing
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
    $inner = Get-ChildItem $tempExtract -Directory | Select-Object -First 1
    if (-not $inner) {
      throw 'Downloaded archive did not contain a root directory.'
    }
    if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
    Move-Item -Path $inner.FullName -Destination $RuntimeDir
  } finally {
    if (Test-Path $tempZip) { Remove-Item $tempZip -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$installer = Join-Path $RuntimeDir 'scripts\install-local.ps1'
if (-not (Test-Path $installer)) {
  Write-Error "Installer script not found at $installer"
  exit 1
}

$forward = @{}
if ($CheckOnly) { $forward['CheckOnly'] = $true }
if ($AutoInstall) { $forward['AutoInstall'] = $true }
if ($NoVerify) { $forward['NoVerify'] = $true }

& $installer @forward
exit $LASTEXITCODE
