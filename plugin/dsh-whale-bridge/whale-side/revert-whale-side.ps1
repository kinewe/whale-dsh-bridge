#Requires -Version 5.1
<#
.SYNOPSIS
    鲸鱼娘侧 DSH 桥接适配回滚（还原 config.json / data/settings.json，删除 debug.html 标记块）。

.DESCRIPTION
    撤销 install-whale-side.ps1 做过的改动：

      1. config.json         若存在 install 时生成的备份 config.json.whale-dsh-bridge.bak，则还原它；
                             没有备份则跳过并提示（不会乱删你的用户数据）。
      2. data/settings.json  优先看还原标记 .whale-dsh-bridge.install.json：
                               · settingsExisted=false（安装前本来没有这个文件）→ 删除它（并清掉空 data 目录）；
                               · 否则用 settings.json.whale-dsh-bridge.bak 还原；
                             没有还原标记时退化为「有备份就还原」。
      3. web/debug.html      删除 <!-- whale-dsh-bridge:begin/end --> 标记块（含其中的 <script>）；
                             不存在标记块则跳过；若标记块缺失但发现本桥接注入的脚本行，也会一并清掉。
      4. 还原标记（.whale-dsh-bridge.install.json）在回滚成功后删除；备份文件默认保留。

    -DryRun 只打印将做的操作，不写盘。

    不会做的事：不启动/不重启鲸鱼娘、不碰微信桥接、不改鲸鱼娘源码、不重启 DSH。

.PARAMETER Root
    鲸鱼娘根目录。默认 C:\whale-girl。

.PARAMETER DryRun
    只预演：打印将做的操作，不写盘。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File revert-whale-side.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File revert-whale-side.ps1 -Root 'D:\whale-girl'
    powershell -NoProfile -ExecutionPolicy Bypass -File revert-whale-side.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\whale-girl',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------ 常量
$MarkerBegin  = '<!-- whale-dsh-bridge:begin -->'
$MarkerEnd    = '<!-- whale-dsh-bridge:end -->'
$BackupSuffix = '.whale-dsh-bridge.bak'
$MetaFileName = '.whale-dsh-bridge.install.json'
$ScriptName   = 'debug-bridge.js'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom   = New-Object System.Text.UTF8Encoding($true)
$script:FailCount = 0

# ------------------------------------------------------------------ 输出
function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Add-Result {
    param(
        [string]$Status,
        [string]$Item,
        [string]$Detail
    )
    $color = 'Gray'
    switch ($Status) {
        'OK'   { $color = 'Green' }
        'SKIP' { $color = 'DarkGray' }
        'WARN' { $color = 'Yellow' }
        'FAIL' { $color = 'Red' }
    }
    Write-Host ('  [{0,-4}] {1,-16} {2}' -f $Status, $Item, $Detail) -ForegroundColor $color
}

# ------------------------------------------------------------------ 文件读写
function Read-TextFile {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($hasBom) {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } else {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    return [pscustomobject]@{ Text = $text; HasBom = $hasBom }
}

function Write-TextFile {
    param([string]$Path, [string]$Text, [bool]$WithBom)
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
        [void][System.IO.Directory]::CreateDirectory($dir)
    }
    if ($WithBom) { $enc = $script:Utf8Bom } else { $enc = $script:Utf8NoBom }
    $tmp = [System.IO.Path]::Combine($dir, [System.IO.Path]::GetFileName($Path) + '.whale-dsh-bridge.tmp')
    try {
        [System.IO.File]::WriteAllText($tmp, $Text, $enc)
        [System.IO.File]::Copy($tmp, $Path, $true)
    } finally {
        if ([System.IO.File]::Exists($tmp)) {
            try { [System.IO.File]::Delete($tmp) } catch { /* 忽略清理失败 */ }
        }
    }
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-JsonProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    try {
        $prop = $Object.PSObject.Properties[$Name]
        if ($null -eq $prop) { return $null }
        return $prop.Value
    } catch {
        return $null
    }
}

function Test-JsonObject {
    param($Object)
    return (($null -ne $Object) -and ($Object -is [System.Management.Automation.PSCustomObject]))
}

function Read-InstallMeta {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    try {
        $obj = (Read-TextFile $Path).Text | ConvertFrom-Json
        if (-not (Test-JsonObject $obj)) { return $null }
        return $obj
    } catch {
        return $null
    }
}

# ------------------------------------------------------------------ 还原 / 删除
function Restore-BackupFile {
    param([string]$Path, [string]$Item, [string]$MissingHint)
    $bak = $Path + $BackupSuffix
    if (-not [System.IO.File]::Exists($bak)) {
        if ([System.IO.File]::Exists($Path)) {
            Add-Result 'SKIP' $Item ("没有备份 " + [System.IO.Path]::GetFileName($bak) + '，保持原样未改动' + $MissingHint)
        } else {
            Add-Result 'SKIP' $Item '文件与备份都不存在，跳过'
        }
        return
    }
    if (-not [System.IO.File]::Exists($Path)) {
        if ($DryRun) {
            Add-Result 'OK' $Item ('[预演] 将用 ' + [System.IO.Path]::GetFileName($bak) + ' 还原')
            return
        }
        [System.IO.File]::Copy($bak, $Path, $false)
        Add-Result 'OK' $Item ('已还原（来源：' + [System.IO.Path]::GetFileName($bak) + '，备份保留）')
        return
    }
    if ((Get-FileSha256 $Path) -eq (Get-FileSha256 $bak)) {
        Add-Result 'SKIP' $Item '文件已与备份一致，无需还原'
        return
    }
    if ($DryRun) {
        Add-Result 'OK' $Item ('[预演] 将用 ' + [System.IO.Path]::GetFileName($bak) + ' 还原')
        return
    }
    [System.IO.File]::Copy($bak, $Path, $true)
    Add-Result 'OK' $Item ('已还原（来源：' + [System.IO.Path]::GetFileName($bak) + '，备份保留）')
}

function Remove-CreatedFile {
    param([string]$Path, [string]$InstalledHash, [string]$Item, [string]$DirToCleanup)
    if (-not [System.IO.File]::Exists($Path)) {
        Add-Result 'SKIP' $Item '不存在（安装前也不存在），无需删除'
        return
    }
    $current = Get-FileSha256 $Path
    if ($InstalledHash -and $current -ne $InstalledHash) {
        Add-Result 'WARN' $Item '安装后被改动过，为安全起见未删除；需要的话请手动处理'
        return
    }
    if ($DryRun) {
        Add-Result 'OK' $Item '[预演] 将删除（安装前不存在本文件）'
        return
    }
    [System.IO.File]::Delete($Path)
    Add-Result 'OK' $Item '已删除（安装前不存在本文件）'
    $bak = $Path + $BackupSuffix
    if ([System.IO.File]::Exists($bak)) {
        [System.IO.File]::Delete($bak)
        Add-Result 'OK' '  └ 备份' '已删除本脚本生成的备份（安装前没有原文件，保留备份没有意义）'
    }
    if ($DirToCleanup -and [System.IO.Directory]::Exists($DirToCleanup)) {
        $left = @(Get-ChildItem -LiteralPath $DirToCleanup -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -LiteralPath $DirToCleanup -Force
            Add-Result 'OK' 'data/' '空目录已清理'
        }
    }
}

# ------------------------------------------------------------------ debug.html 标记块
function Remove-MarkerBlockText {
    param([string]$Text)
    $beginIdx = $Text.IndexOf($MarkerBegin, [System.StringComparison]::Ordinal)
    $endIdx = $Text.IndexOf($MarkerEnd, [System.StringComparison]::Ordinal)
    if ($beginIdx -lt 0 -and $endIdx -lt 0) { return $Text }
    if ($beginIdx -ge 0 -and $endIdx -gt $beginIdx) {
        $lineStart = $Text.LastIndexOf("`n", $beginIdx)
        if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart = $lineStart + 1 }
        $endAfter = $endIdx + $MarkerEnd.Length
        while ($endAfter -lt $Text.Length -and ($Text[$endAfter] -eq ' ' -or $Text[$endAfter] -eq "`t")) { $endAfter++ }
        if ($endAfter -lt $Text.Length -and $Text[$endAfter] -eq "`r") { $endAfter++ }
        if ($endAfter -lt $Text.Length -and $Text[$endAfter] -eq "`n") { $endAfter++ }
        return ($Text.Substring(0, $lineStart) + $Text.Substring($endAfter))
    }
    $cleaned = [regex]::Replace($Text, '[ \t]*<!--\s*whale-dsh-bridge:(?:begin|end)\s*-->[ \t]*\r?\n?', '')
    $cleaned = [regex]::Replace($cleaned, '(?m)^[ \t]*<script[^\r\n]*' + [regex]::Escape($ScriptName) + '[^\r\n]*</script>[ \t]*(?:\r?\n)?', '')
    return $cleaned
}

function Invoke-DebugHtmlRevert {
    param([string]$DebugPath)
    if (-not [System.IO.File]::Exists($DebugPath)) {
        Add-Result 'SKIP' 'web/debug.html' '文件不存在，跳过'
        return
    }

    $file = Read-TextFile $DebugPath
    $text = $file.Text
    $hasMarkers = ($text.IndexOf($MarkerBegin, [System.StringComparison]::Ordinal) -ge 0) -or
                  ($text.IndexOf($MarkerEnd, [System.StringComparison]::Ordinal) -ge 0)

    $newText = Remove-MarkerBlockText $text
    if ($newText -eq $text) {
        Add-Result 'SKIP' 'web/debug.html' '没有标记块，跳过'
        return
    }

    if ($DryRun) {
        if ($hasMarkers) {
            Add-Result 'OK' 'web/debug.html' '[预演] 将删除 <!-- whale-dsh-bridge:begin/end --> 标记块'
        } else {
            Add-Result 'OK' 'web/debug.html' '[预演] 标记块缺失，但发现注入的脚本行，将一并清理'
        }
        return
    }

    Write-TextFile -Path $DebugPath -Text $newText -WithBom $file.HasBom
    if ($hasMarkers) {
        Add-Result 'OK' 'web/debug.html' '已删除标记块（debug.html 备份保留未删）'
    } else {
        Add-Result 'WARN' 'web/debug.html' '标记块缺失，但已清理残留的 debug-bridge.js 脚本行'
    }

    $check = (Read-TextFile $DebugPath).Text
    if ($check.IndexOf($MarkerBegin, [System.StringComparison]::Ordinal) -ge 0) {
        throw 'web/debug.html 写入后自检失败：仍残留 begin 标记'
    }
    if ($check.IndexOf($MarkerEnd, [System.StringComparison]::Ordinal) -ge 0) {
        throw 'web/debug.html 写入后自检失败：仍残留 end 标记'
    }
}

# ------------------------------------------------------------------ 主流程
try {
    try {
        $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    } catch {
        throw "Root 不是合法路径：$Root"
    }
    if (-not [System.IO.Directory]::Exists($resolvedRoot)) {
        throw "鲸鱼娘根目录不存在：$resolvedRoot"
    }
    $Root = $resolvedRoot.TrimEnd('\', '/')

    $configPath   = Join-Path $Root 'config.json'
    $settingsPath = Join-Path (Join-Path $Root 'data') 'settings.json'
    $debugPath    = Join-Path (Join-Path $Root 'web') 'debug.html'
    $metaPath     = Join-Path $Root $MetaFileName

    $meta = Read-InstallMeta $metaPath
    $configExisted = $null
    $settingsExisted = $null
    $settingsInstalledHash = ''
    if ($null -ne $meta) {
        $configExisted = Get-JsonProperty $meta 'configExisted'
        $settingsExisted = Get-JsonProperty $meta 'settingsExisted'
        $settingsInstalledHash = [string](Get-JsonProperty $meta 'settingsInstalledHash')
    }

    Write-Host ''
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host '  DSH 桥接 · 鲸鱼娘侧回滚（还原备份 + 删除 /debug 标记块）' -ForegroundColor Cyan
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host ('  鲸鱼娘目录 : ' + $Root)
    if ($null -ne $meta) {
        Write-Host ('  还原标记   : 找到（安装前 config.json 存在=' + $configExisted + '，data/settings.json 存在=' + $settingsExisted + '）')
    } else {
        Write-Host '  还原标记   : 未找到（退化为「有备份就还原」）' -ForegroundColor Yellow
    }
    if ($DryRun) {
        Write-Host '  运行模式   : 预演 DryRun（只打印，不写盘）' -ForegroundColor Yellow
    } else {
        Write-Host '  运行模式   : 实际回滚'
    }
    Write-Host ''
    Write-Host '检查与还原：' -ForegroundColor Cyan

    # 1) config.json：始终「有备份就还原」（安装前不存在时，备份是 example 基线，还原后等同于首次使用状态）
    try {
        Restore-BackupFile -Path $configPath -Item 'config.json' -MissingHint '；如需恢复 provider，请手动改 config.json'
    } catch {
        $script:FailCount++; Add-Result 'FAIL' 'config.json' $_.Exception.Message
    }

    # 2) data/settings.json：安装前不存在 → 删除；否则还原备份
    try {
        if ($null -ne $meta -and $settingsExisted -eq $false) {
            Remove-CreatedFile -Path $settingsPath -InstalledHash $settingsInstalledHash -Item 'data/settings.json' -DirToCleanup (Join-Path $Root 'data')
        } else {
            Restore-BackupFile -Path $settingsPath -Item 'data/settings.json' -MissingHint '；网页设置里可能仍留着 provider=custom，请到鲸鱼娘网页「⚙️ 设置」里重新选模型服务'
        }
    } catch {
        $script:FailCount++; Add-Result 'FAIL' 'data/settings.json' $_.Exception.Message
    }

    # 3) debug.html：删除标记块
    try {
        Invoke-DebugHtmlRevert -DebugPath $debugPath
    } catch {
        $script:FailCount++; Add-Result 'FAIL' 'web/debug.html' $_.Exception.Message
    }

    # 4) 还原标记：回滚成功后删除
    if ($null -ne $meta) {
        if ($DryRun) {
            Add-Result 'OK' '还原标记' '[预演] 将删除 .whale-dsh-bridge.install.json'
        } elseif ($script:FailCount -eq 0) {
            try {
                [System.IO.File]::Delete($metaPath)
                Add-Result 'OK' '还原标记' '已删除 .whale-dsh-bridge.install.json'
            } catch {
                Add-Result 'WARN' '还原标记' ('删除失败（不影响配置还原）：' + $_.Exception.Message)
            }
        } else {
            Add-Result 'WARN' '还原标记' '有步骤失败，保留还原标记，方便修复后重跑'
        }
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host '预演完成：以上操作都没有写入磁盘。去掉 -DryRun 再执行即可真正回滚。' -ForegroundColor Yellow
    } elseif ($script:FailCount -gt 0) {
        Write-Host ('回滚未完全成功：' + $script:FailCount + ' 项失败（见上方 [FAIL]）。') -ForegroundColor Red
    } else {
        Write-Host '回滚完成。' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host '提示：' -ForegroundColor Cyan
    Write-Host ('  · 备份文件（*' + $BackupSuffix + '）默认保留，需要彻底清掉可手动删除。')
    Write-Host '  · 鲸鱼娘若正在运行：config.json 会热加载；如果没有生效，重启鲸鱼娘即可。'
    Write-Host ('  · 重新接入：powershell -NoProfile -ExecutionPolicy Bypass -File install-whale-side.ps1 -Root "' + $Root + '"')
    Write-Host ''

    if ($script:FailCount -gt 0) { exit 1 } else { exit 0 }
} catch {
    Write-Host ''
    Write-Host ('回滚失败：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    exit 1
}
