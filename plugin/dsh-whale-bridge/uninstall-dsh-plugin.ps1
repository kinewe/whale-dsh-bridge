# uninstall-dsh-plugin.ps1
# Remove dsh-whale-bridge from the DSH desktop profile (keeps user data under ~/.dsh/whale-bridge).
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$PluginDir = $PSScriptRoot,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$nodeModules = Join-Path $ProfileDir 'node_modules'
$linkPath = Join-Path $nodeModules 'dsh-whale-bridge'
$pkgPath = Join-Path $ProfileDir 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir ("package.json.dsh-whale-bridge.uninstall.bak_$stamp")

if (-not (Test-Path $pkgPath)) { throw "profile package.json not found: $pkgPath" }
Copy-Item $pkgPath $backup -Force
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if ($pkg.dependencies) { $pkg.dependencies.PSObject.Properties.Remove('dsh-whale-bridge') }
if ($pkg.dsh.profile.bundles) {
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-whale-bridge' })
}
if (-not $DryRun) {
  $json = $pkg | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path $linkPath) { cmd /c rmdir "$linkPath" | Out-Null }
}
Write-Host "removed profile entry and junction (backup: $backup)"
Write-Host "bridge data stays at $env:USERPROFILE\.dsh\whale-bridge (delete manually if needed)"
