# install-dsh-plugin.ps1
# Install dsh-whale-bridge into the DSH desktop profile with live HMR reload (no app restart).
#
# Why not "dsh plugin --profile desktop add ...":
#   the desktop profile is managed exclusively by the Electron app, so the CLI refuses it.
#   But the profile HMR watches package.json (dsh.profile.bundles) and patch files, and the
#   runtime resolves packages from profile node_modules. So this script:
#     1. backs up profile package.json;
#     2. creates a directory junction node_modules\dsh-whale-bridge -> this plugin folder;
#     3. adds a link: dependency and appends dsh-whale-bridge to dsh.profile.bundles;
#     4. waits for HMR recomposition and probes the bridge health endpoint.
# The uninstall script reverses everything.
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$PluginDir = $PSScriptRoot,
  [int]$Port = 8789,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Write-Host '== dsh-whale-bridge install =='
Write-Host "profile : $ProfileDir"
Write-Host "plugin  : $PluginDir"

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { throw "DSH profile not found: $ProfileDir" }
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) { throw "plugin directory not found: $PluginDir" }

$nodeModules = Join-Path $ProfileDir 'node_modules'
$linkPath = Join-Path $nodeModules 'dsh-whale-bridge'
$pkgPath = Join-Path $ProfileDir 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir ("package.json.dsh-whale-bridge.bak_$stamp")

Copy-Item $pkgPath $backup -Force
Write-Host "[1/3] backup -> $backup"

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.PSObject.Properties['dependencies']) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$linkSpec = 'link:' + ($PluginDir -replace '\\', '/')
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-whale-bridge' -NotePropertyValue $linkSpec -Force
if (-not $pkg.dsh) { throw 'package.json has no dsh field; not a DSH profile?' }
if (-not $pkg.dsh.profile) { throw 'package.json has no dsh.profile field' }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-whale-bridge') { $bundles += 'dsh-whale-bridge' }
$pkg.dsh.profile.bundles = $bundles

if (-not $DryRun) {
  $json = $pkg | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host '[2/3] profile package.json updated (dependency + bundles)'

if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Write-Host "[3/3] link already exists: $linkPath -> $($item.Target)"
  } else {
    throw "node_modules\dsh-whale-bridge exists and is not a link: $linkPath"
  }
} else {
  if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory $nodeModules | Out-Null }
  if (-not $DryRun) {
    cmd /c mklink /J "$linkPath" "$PluginDir" | Out-Null
    if (-not (Test-Path $linkPath)) { throw 'failed to create junction' }
  }
  Write-Host "[3/3] junction created: $linkPath -> $PluginDir"
}

if ($DryRun) {
  # restore the untouched manifest (we only wrote it when not DryRun, but be safe)
  Write-Host '(DryRun) nothing written'
  exit 0
}

Write-Host "waiting for bridge on 127.0.0.1:$Port ..."
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 750
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if ($ok) {
  Write-Host "bridge is live: http://127.0.0.1:$Port/api/health"
  Write-Host 'next: refresh the DSH page (Ctrl+R); the left sidebar should show the whale bridge entry.'
} else {
  Write-Warning "bridge port not ready. Check C:\Users\$env:USERNAME\.dsh\whale-bridge\bridge.log and whether the profile recomposed."
}
