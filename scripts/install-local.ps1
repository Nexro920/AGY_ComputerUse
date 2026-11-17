param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\agy-chrome-use'

if ($Uninstall) {
  if (Test-Path $TargetDir) {
    $item = Get-Item $TargetDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      cmd /c rmdir "`"$TargetDir`""
    } else {
      Remove-Item $TargetDir -Recurse -Force
    }
    Write-Host "Removed plugin link at $TargetDir"
  } else {
    Write-Host "Plugin link not found at $TargetDir"
  }
  exit 0
}

Push-Location $PluginRoot
try {
  npm run build
} finally {
  Pop-Location
}

$PluginsParent = Split-Path -Parent $TargetDir
if (-not (Test-Path $PluginsParent)) {
  New-Item -ItemType Directory -Path $PluginsParent -Force | Out-Null
}

if (Test-Path $TargetDir) {
  $item = Get-Item $TargetDir -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir "`"$TargetDir`""
  }
}

# Antigravity's plugin scanner skips Windows directory junctions/reparse points,
# so install a real directory containing the plugin manifest, MCP config, rules, and skills.
# Copy in-place if the directory already exists so running MCP processes holding cwd don't lock it.
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
Copy-Item (Join-Path $PluginRoot 'plugin.json') $TargetDir -Force

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$mcpConfig = Get-Content (Join-Path $PluginRoot 'mcp_config.json') -Raw | ConvertFrom-Json
if ($mcpConfig.mcpServers.'agy-chrome-use') {
  if (-not $mcpConfig.mcpServers.'agy-chrome-use'.env) {
    $mcpConfig.mcpServers.'agy-chrome-use' | Add-Member -NotePropertyName 'env' -NotePropertyValue ([pscustomobject]@{})
  }
  $mcpConfig.mcpServers.'agy-chrome-use'.env | Add-Member -NotePropertyName 'AGY_CHROME_RUNTIME_ROOT' -NotePropertyValue $PluginRoot -Force
}
[System.IO.File]::WriteAllText((Join-Path $TargetDir 'mcp_config.json'), ($mcpConfig | ConvertTo-Json -Depth 10), $utf8NoBom)

if (Test-Path (Join-Path $PluginRoot 'scripts\stop-hook.mjs')) {
  New-Item -ItemType Directory -Path (Join-Path $TargetDir 'scripts') -Force | Out-Null
  $installedHookScript = Join-Path $TargetDir 'scripts\stop-hook.mjs'
  Copy-Item (Join-Path $PluginRoot 'scripts\stop-hook.mjs') $installedHookScript -Force
  if (Test-Path (Join-Path $PluginRoot 'hooks.json')) {
    $hooksConfig = Get-Content (Join-Path $PluginRoot 'hooks.json') -Raw | ConvertFrom-Json
    if ($hooksConfig.'agy-chrome-use-release'.Stop -and $hooksConfig.'agy-chrome-use-release'.Stop.Count -gt 0) {
      $hooksConfig.'agy-chrome-use-release'.Stop[0].command = "node `"$installedHookScript`""
    }
    [System.IO.File]::WriteAllText((Join-Path $TargetDir 'hooks.json'), ($hooksConfig | ConvertTo-Json -Depth 10), $utf8NoBom)
  }
} elseif (Test-Path (Join-Path $PluginRoot 'hooks.json')) {
  Copy-Item (Join-Path $PluginRoot 'hooks.json') $TargetDir -Force
}

if (Test-Path (Join-Path $PluginRoot 'README.md')) {
  Copy-Item (Join-Path $PluginRoot 'README.md') $TargetDir -Force
}
Copy-Item (Join-Path $PluginRoot 'rules') $TargetDir -Recurse -Force
Copy-Item (Join-Path $PluginRoot 'skills') $TargetDir -Recurse -Force
Write-Host "Installed plugin bundle to $TargetDir (runtime from $PluginRoot)"
