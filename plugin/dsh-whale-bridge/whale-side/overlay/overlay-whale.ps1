
param([ValidateSet('Status','Backup','Apply')][string]$Mode = 'Status')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here 'manifest.json'
$snapshot = Join-Path $here 'snapshot'
$backups = Join-Path $here 'backups'
$m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $PSBoundParameters.ContainsKey('WhaleDir')) { $WhaleDir = $m.whale_dir }
if (-not (Test-Path -LiteralPath $WhaleDir)) { throw "whale dir not found: $WhaleDir" }
function Get-Sha256([string]$p) { if (-not (Test-Path -LiteralPath $p)) { return '' }; (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function New-Backup {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $backups $stamp
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  foreach ($f in $m.files) {
    $src = Join-Path $WhaleDir $f.path
    if (Test-Path -LiteralPath $src) {
      $dst = Join-Path $dir $f.path
      New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
    }
  }
  Write-Host "backup -> $dir"
}
switch ($Mode) {
  'Status' {
    foreach ($f in $m.files) {
      $cur = Get-Sha256 (Join-Path $WhaleDir $f.path)
      $want = [string]$f.sha256
      $state = if ($cur -eq $want) { 'OK' } elseif (-not $cur) { 'MISSING' } else { 'DIFF' }
      "{0,-8} {1}" -f $state, $f.path
    }
  }
  'Backup' { New-Backup }
  'Apply' {
    New-Backup
    foreach ($f in $m.files) {
      $src = Join-Path $snapshot $f.path
      $dst = Join-Path $WhaleDir $f.path
      if (-not (Test-Path -LiteralPath $src)) { throw "snapshot missing: $($f.path)" }
      New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
      "applied $($f.path)"
    }
    Write-Host 'overlay applied; restart whale server'
  }
}
