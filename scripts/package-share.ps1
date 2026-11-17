param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$stamp = Get-Date -Format 'yyyyMMdd'
$stage = Join-Path $OutDir "whale-dsh-share-$stamp"
$zip = Join-Path $OutDir "whale-dsh-share-$stamp.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $repo 'README.md') $stage -Force
Copy-Item (Join-Path $repo 'LICENSE') $stage -Force
Copy-Item (Join-Path $repo 'plugin') $stage -Recurse -Force
Copy-Item (Join-Path $repo 'bridge-reference') $stage -Recurse -Force
Copy-Item (Join-Path $repo 'docs') $stage -Recurse -Force

Get-ChildItem $stage -Recurse -File -Filter '*.bak*' | Remove-Item -Force
Get-ChildItem $stage -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "package: $zip"
