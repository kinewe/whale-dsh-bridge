#Requires -Version 5.1
<#
.SYNOPSIS
    鲸鱼娘侧 DSH 桥接适配安装（幂等，可重复执行）。

.DESCRIPTION
    把鲸鱼娘（whale-girl）接到 DeepSeek Harness（DSH）的桥接代理上，只动
    「用户数据 / 页面覆盖层 + 一个还原标记」，不改鲸鱼娘源码、不改 DSH 安装目录。

    鲸鱼娘 3.60 的 src/config.js -> resolveRuntime() 在 provider=custom 时读的是
    config.json 的 llm 段（{baseUrl, model, apiKey}），不是 custom 段；而 data/settings.json
    （网页「设置」）优先级最高。所以本脚本写：

      1. config.json          provider=custom；同时写 llm 段（baseUrl 指向桥接 /v1，
                              model/apiKey 保留原 llm 或原 custom 的值，缺省补
                              deepseek-chat / whale-dsh-bridge；llm.provider=custom），
                              custom 段保留（展示用，字段同上），其余字段/中文说明原样保留。
      2. data/settings.json   不存在则创建（没有它时 resolveRuntime 才会用 llm 段），
                              存在则合并 provider/baseUrl/model/apiKey/keys.custom，其余字段保留；
                              若旧设置里有 mock=true 会关掉（否则聊天走模拟回复、根本不连桥接）。
      3. web/debug.html       在 </main> 前插入带标记的 <script> 块，加载桥接的
                              /static/debug-bridge.js（调试台「DSH 桥接」卡片）。
      4. .whale-dsh-bridge.install.json
                              还原标记：记录首次安装前 config/settings 是否存在、安装后文件哈希，
                              供 revert 精确还原（settings.json 原本不存在时 revert 会删掉它）。

    特性：
      · 幂等：重复执行不会重复插入标记块；已符合目标状态时跳过写入；还原标记保留首次安装前状态。
      · 备份：首次改动前备份为 <文件>.whale-dsh-bridge.bak；已存在则保留不覆盖。
      · 预演：-DryRun 只打印将做的改动，不写盘、不建备份、不写还原标记。
      · 编码：config.json / data/settings.json / 还原标记用 UTF-8 无 BOM 写回且中文不转义；
              web/debug.html 保留原有 BOM 与换行风格。

    不会做的事：不启动鲸鱼娘、不启动/不碰微信桥接、不改鲸鱼娘源码、不重启 DSH。
    回滚：revert-whale-side.ps1。

.PARAMETER Root
    鲸鱼娘根目录（含 config.example.json、web/debug.html）。默认 C:\whale-girl。

.PARAMETER BridgePort
    DSH 桥接监听端口，写入 llm.baseUrl / custom.baseUrl / settings.baseUrl / script 地址。默认 8789。

.PARAMETER DryRun
    只预演：打印将做的改动，不写盘。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File install-whale-side.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File install-whale-side.ps1 -Root 'D:\whale-girl' -BridgePort 8790
    powershell -NoProfile -ExecutionPolicy Bypass -File install-whale-side.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\whale-girl',
    [int]$BridgePort = 8789,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------ 常量
$Version       = '0.2.0'
$MarkerBegin   = '<!-- whale-dsh-bridge:begin -->'
$MarkerEnd     = '<!-- whale-dsh-bridge:end -->'
$BackupSuffix  = '.whale-dsh-bridge.bak'
$MetaFileName  = '.whale-dsh-bridge.install.json'
$DefaultModel  = 'deepseek-chat'
$DefaultApiKey = 'whale-dsh-bridge'

$script:Utf8NoBom       = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom         = New-Object System.Text.UTF8Encoding($true)
$script:BridgeBaseUrl   = ''
$script:BridgeScriptUrl = ''
$script:EffectiveModel  = $DefaultModel
$script:EffectiveApiKey = $DefaultApiKey
$script:FailCount       = 0
$script:ChangeCount     = 0
$script:ConfigPath      = ''
$script:SettingsPath    = ''
$script:DebugPath       = ''
$script:MetaPath        = ''
$script:ConfigExisted   = $false
$script:SettingsExisted = $false
$script:FirstInstallAt  = ''
$script:ExistingMeta    = $null

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
        'OK'   { $color = 'Green';    $script:ChangeCount = $script:ChangeCount + 1 }
        'SKIP' { $color = 'DarkGray' }
        'WARN' { $color = 'Yellow' }
        'FAIL' { $color = 'Red' }
    }
    Write-Host ('  [{0,-4}] {1,-16} {2}' -f $Status, $Item, $Detail) -ForegroundColor $color
}

# ------------------------------------------------------------------ JSON 属性辅助
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

function Test-JsonProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $false }
    try {
        return ($null -ne $Object.PSObject.Properties[$Name])
    } catch {
        return $false
    }
}

function Test-JsonObject {
    param($Object)
    return (($null -ne $Object) -and ($Object -is [System.Management.Automation.PSCustomObject]))
}

function Set-JsonProperty {
    param($Object, [string]$Name, $Value)
    try {
        $prop = $Object.PSObject.Properties[$Name]
        if ($null -ne $prop) {
            $prop.Value = $Value
            return
        }
    } catch {
        # 走到下面的 Add-Member
    }
    [void]($Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force -PassThru)
}

function Insert-JsonPropertyAfter {
    param($Object, [string]$AfterName, [string]$NewName, $NewValue)
    $pairs = New-Object System.Collections.Specialized.OrderedDictionary
    $inserted = $false
    foreach ($p in $Object.PSObject.Properties) {
        $pairs[[string]$p.Name] = $p.Value
        if (-not $inserted -and $p.Name -eq $AfterName) {
            $pairs[$NewName] = $NewValue
            $inserted = $true
        }
    }
    if (-not $inserted) { $pairs[$NewName] = $NewValue }
    $newObj = New-Object System.Management.Automation.PSObject
    foreach ($key in $pairs.Keys) {
        $np = New-Object -TypeName System.Management.Automation.PSNoteProperty -ArgumentList ([string]$key), ($pairs[$key])
        [void]$newObj.PSObject.Properties.Add($np)
    }
    return $newObj
}

# ------------------------------------------------------------------ JSON 序列化（中文原样、UTF-8 无 BOM、LF 换行）
function ConvertTo-JsonString {
    param([string]$Text)
    if ($null -eq $Text) { return '""' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        $code = [int]$ch
        switch ($code) {
            34  { [void]$sb.Append('\"'); continue }
            92  { [void]$sb.Append('\\'); continue }
            8   { [void]$sb.Append('\b'); continue }
            12  { [void]$sb.Append('\f'); continue }
            10  { [void]$sb.Append('\n'); continue }
            13  { [void]$sb.Append('\r'); continue }
            9   { [void]$sb.Append('\t'); continue }
        }
        if ($code -lt 32) {
            [void]$sb.Append(('\u{0:x4}' -f $code))
        } else {
            [void]$sb.Append($ch)
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Write-JsonToBuilder {
    param(
        [System.Text.StringBuilder]$Builder,
        $Node,
        [int]$Depth = 0
    )
    if ($Depth -gt 100) { throw 'JSON 嵌套层级过深（>100），已中止' }
    if ($null -eq $Node) { [void]$Builder.Append('null'); return }

    if ($Node -is [bool]) {
        if ($Node) { [void]$Builder.Append('true') } else { [void]$Builder.Append('false') }
        return
    }
    if ($Node -is [string]) { [void]$Builder.Append((ConvertTo-JsonString $Node)); return }
    if ($Node -is [char]) { [void]$Builder.Append((ConvertTo-JsonString ([string]$Node))); return }
    if ($Node -is [decimal]) {
        [void]$Builder.Append($Node.ToString([System.Globalization.CultureInfo]::InvariantCulture))
        return
    }
    if ($Node -is [double] -or $Node -is [single]) {
        $d = [double]$Node
        if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) {
            [void]$Builder.Append('null')
        } else {
            [void]$Builder.Append($d.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture))
        }
        return
    }
    if ($Node -is [int] -or $Node -is [long] -or $Node -is [int16] -or $Node -is [byte] -or
        $Node -is [sbyte] -or $Node -is [uint16] -or $Node -is [uint32] -or $Node -is [uint64]) {
        [void]$Builder.Append($Node.ToString([System.Globalization.CultureInfo]::InvariantCulture))
        return
    }

    # 字典（含有序字典）
    if ($Node -is [System.Collections.IDictionary]) {
        $entries = New-Object System.Collections.ArrayList
        foreach ($entry in $Node.GetEnumerator()) { [void]$entries.Add($entry) }
        if ($entries.Count -eq 0) { [void]$Builder.Append('{}'); return }
        [void]$Builder.Append("{`n")
        $indent = ' ' * (($Depth + 1) * 2)
        $closeIndent = ' ' * ($Depth * 2)
        for ($i = 0; $i -lt $entries.Count; $i++) {
            if ($i -gt 0) { [void]$Builder.Append(",`n") }
            [void]$Builder.Append($indent)
            [void]$Builder.Append((ConvertTo-JsonString ([string]$entries[$i].Key)))
            [void]$Builder.Append(': ')
            Write-JsonToBuilder -Builder $Builder -Node $entries[$i].Value -Depth ($Depth + 1)
        }
        [void]$Builder.Append("`n" + $closeIndent + '}')
        return
    }

    # 数组 / 列表
    if ($Node -is [System.Collections.IList]) {
        $count = $Node.Count
        if ($count -eq 0) { [void]$Builder.Append('[]'); return }
        [void]$Builder.Append("[`n")
        $indent = ' ' * (($Depth + 1) * 2)
        $closeIndent = ' ' * ($Depth * 2)
        for ($i = 0; $i -lt $count; $i++) {
            [void]$Builder.Append($indent)
            Write-JsonToBuilder -Builder $Builder -Node $Node[$i] -Depth ($Depth + 1)
            if ($i -lt $count - 1) { [void]$Builder.Append(',') }
            [void]$Builder.Append("`n")
        }
        [void]$Builder.Append($closeIndent + ']')
        return
    }
    if ($Node -is [System.Collections.IEnumerable]) {
        $items = New-Object System.Collections.ArrayList
        foreach ($item in $Node) { [void]$items.Add($item) }
        if ($items.Count -eq 0) { [void]$Builder.Append('[]'); return }
        [void]$Builder.Append("[`n")
        $indent = ' ' * (($Depth + 1) * 2)
        $closeIndent = ' ' * ($Depth * 2)
        for ($i = 0; $i -lt $items.Count; $i++) {
            [void]$Builder.Append($indent)
            Write-JsonToBuilder -Builder $Builder -Node $items[$i] -Depth ($Depth + 1)
            if ($i -lt $items.Count - 1) { [void]$Builder.Append(',') }
            [void]$Builder.Append("`n")
        }
        [void]$Builder.Append($closeIndent + ']')
        return
    }

    # PSObject / 普通对象：按属性出现顺序输出
    $props = @($Node.PSObject.Properties)
    if ($props.Count -eq 0) {
        [void]$Builder.Append('{}')
        return
    }
    [void]$Builder.Append("{`n")
    $indent = ' ' * (($Depth + 1) * 2)
    $closeIndent = ' ' * ($Depth * 2)
    for ($i = 0; $i -lt $props.Count; $i++) {
        if ($i -gt 0) { [void]$Builder.Append(",`n") }
        [void]$Builder.Append($indent)
        [void]$Builder.Append((ConvertTo-JsonString ([string]$props[$i].Name)))
        [void]$Builder.Append(': ')
        Write-JsonToBuilder -Builder $Builder -Node $props[$i].Value -Depth ($Depth + 1)
    }
    [void]$Builder.Append("`n" + $closeIndent + '}')
}

function ConvertTo-JsonText {
    param($Node)
    $sb = New-Object System.Text.StringBuilder
    Write-JsonToBuilder -Builder $sb -Node $Node -Depth 0
    [void]$sb.Append("`n")
    return $sb.ToString()
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
        # 覆盖写（不是改名替换）：保留文件标识，鲸鱼娘对 config.json 的 fs.watch 热加载才不会断
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

function Backup-FileIfMissing {
    param([string]$Path)
    $bak = $Path + $BackupSuffix
    if ([System.IO.File]::Exists($bak)) {
        return [pscustomobject]@{ Path = $bak; Created = $false; Note = '已存在首次安装前备份，保留未覆盖' }
    }
    if ($DryRun) {
        return [pscustomobject]@{ Path = $bak; Created = $false; Note = '[预演] 将备份' }
    }
    [System.IO.File]::Copy($Path, $bak, $false)
    return [pscustomobject]@{ Path = $bak; Created = $true; Note = '已备份首次安装前内容' }
}

# ------------------------------------------------------------------ debug.html 标记块
function Get-BridgeMarkerBlock {
    param([string]$NewLine)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('  ' + $MarkerBegin + $NewLine)
    [void]$sb.Append('  <script src="' + $script:BridgeScriptUrl + '" defer></script>' + $NewLine)
    [void]$sb.Append('  ' + $MarkerEnd + $NewLine)
    return $sb.ToString()
}

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
    return $cleaned
}

# ------------------------------------------------------------------ 还原标记
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

# ------------------------------------------------------------------ 步骤 1：config.json
function Invoke-ConfigStep {
    $configPath = $script:ConfigPath
    $examplePath = Join-Path $Root 'config.example.json'

    if (-not [System.IO.File]::Exists($configPath)) {
        if (-not [System.IO.File]::Exists($examplePath)) {
            throw "config.json 不存在，且找不到模板 config.example.json（$examplePath）"
        }
        if (-not $DryRun) {
            [System.IO.File]::Copy($examplePath, $configPath, $false)
            Add-Result 'OK' 'config.json' '原本不存在，已从 config.example.json 复制生成'
        } else {
            Add-Result 'OK' 'config.json' '[预演] 将从 config.example.json 复制生成'
        }
        $baseline = Read-TextFile $examplePath
    } else {
        $baseline = Read-TextFile $configPath
    }

    $cfg = $null
    try {
        $cfg = $baseline.Text | ConvertFrom-Json
    } catch {
        throw "config.json 不是合法 JSON，未做改动：$($_.Exception.Message)"
    }
    if (-not (Test-JsonObject $cfg)) {
        throw 'config.json 的根节点必须是 JSON 对象，未做改动'
    }

    # 1) provider = custom
    Set-JsonProperty -Object $cfg -Name 'provider' -Value 'custom'

    # 2) 解析 model / apiKey：优先原 llm，其次原 custom，最后默认
    $llm = Get-JsonProperty $cfg 'llm'
    $custom = Get-JsonProperty $cfg 'custom'
    $llmIsObject = Test-JsonObject $llm
    $customIsObject = Test-JsonObject $custom

    $llmModel = ''; $llmKey = ''
    if ($llmIsObject) {
        $llmModel = ([string](Get-JsonProperty $llm 'model')).Trim()
        $llmKey = ([string](Get-JsonProperty $llm 'apiKey')).Trim()
    }
    $customModel = ''; $customKey = ''
    if ($customIsObject) {
        $customModel = ([string](Get-JsonProperty $custom 'model')).Trim()
        $customKey = ([string](Get-JsonProperty $custom 'apiKey')).Trim()
    }
    $model = $DefaultModel
    if ($customModel.Length -gt 0) { $model = $customModel }
    if ($llmModel.Length -gt 0) { $model = $llmModel }
    $apiKey = $DefaultApiKey
    if ($customKey.Length -gt 0) { $apiKey = $customKey }
    if ($llmKey.Length -gt 0) { $apiKey = $llmKey }
    $script:EffectiveModel = $model
    $script:EffectiveApiKey = $apiKey

    # 3) custom 段（展示用；没有就插到 provider 后面）：保留原有额外字段
    if (-not $customIsObject) {
        $custom = [pscustomobject][ordered]@{
            baseUrl = $script:BridgeBaseUrl
            model   = $model
            apiKey  = $apiKey
        }
        if (Test-JsonProperty $cfg 'custom') {
            Set-JsonProperty -Object $cfg -Name 'custom' -Value $custom
        } else {
            $cfg = Insert-JsonPropertyAfter -Object $cfg -AfterName 'provider' -NewName 'custom' -NewValue $custom
        }
    } else {
        Set-JsonProperty -Object $custom -Name 'baseUrl' -Value $script:BridgeBaseUrl
        Set-JsonProperty -Object $custom -Name 'model'   -Value $model
        Set-JsonProperty -Object $custom -Name 'apiKey'  -Value $apiKey
    }

    # 4) llm 段：鲸鱼娘 3.60 resolveRuntime() 在 provider=custom 时读的是这一段，必须写
    if (-not $llmIsObject) {
        $llm = [pscustomobject][ordered]@{
            provider = 'custom'
            baseUrl  = $script:BridgeBaseUrl
            model    = $model
            apiKey   = $apiKey
        }
        if (Test-JsonProperty $cfg 'llm') {
            Set-JsonProperty -Object $cfg -Name 'llm' -Value $llm
        } else {
            $cfg = Insert-JsonPropertyAfter -Object $cfg -AfterName 'custom' -NewName 'llm' -NewValue $llm
        }
    } else {
        Set-JsonProperty -Object $llm -Name 'provider' -Value 'custom'
        Set-JsonProperty -Object $llm -Name 'baseUrl'  -Value $script:BridgeBaseUrl
        Set-JsonProperty -Object $llm -Name 'model'    -Value $model
        Set-JsonProperty -Object $llm -Name 'apiKey'   -Value $apiKey
    }

    # 5) 聊天超时：桥接在需要动手时会等 DSH 任务完成（通常 10~120s），
    #    鲸鱼娘默认的 deepseek.timeoutMs=45s 会先报 request timeout 拿不到回复；这里放宽到 660s（聊天委托上限 10 分钟）。
    $deepseek = Get-JsonProperty $cfg 'deepseek'
    if (-not (Test-JsonObject $deepseek)) {
        $deepseek = [pscustomobject][ordered]@{}
        if (Test-JsonProperty $cfg 'deepseek') {
            Set-JsonProperty -Object $cfg -Name 'deepseek' -Value $deepseek
        } elseif (Test-JsonProperty $cfg 'llm') {
            $cfg = Insert-JsonPropertyAfter -Object $cfg -AfterName 'llm' -NewName 'deepseek' -NewValue $deepseek
        } else {
            $cfg = Insert-JsonPropertyAfter -Object $cfg -AfterName 'custom' -NewName 'deepseek' -NewValue $deepseek
        }
    }
    $currentTimeout = 0
    try { $currentTimeout = [int](Get-JsonProperty $deepseek 'timeoutMs') } catch { $currentTimeout = 0 }
    if ($currentTimeout -lt 660000) {
        Set-JsonProperty -Object $deepseek -Name 'timeoutMs' -Value 660000
    }

    $newText = ConvertTo-JsonText $cfg
    if ($newText -eq $baseline.Text) {
        Add-Result 'SKIP' 'config.json' "已是目标状态（provider=custom、llm.baseUrl=$($script:BridgeBaseUrl)），未改动"
        return
    }

    if ($DryRun) {
        Add-Result 'OK' 'config.json' ("[预演] 将写入 provider=custom、llm.baseUrl={0}、llm.model={1}、custom 段同步" -f $script:BridgeBaseUrl, $model)
        return
    }

    $bak = Backup-FileIfMissing -Path $configPath
    Write-TextFile -Path $configPath -Text $newText -WithBom $false
    Add-Result 'OK' 'config.json' ("已更新（provider=custom、llm.baseUrl={0}、llm.model={1}、llm.apiKey=保留/默认，custom 段同步）" -f $script:BridgeBaseUrl, $model)
    Add-Result 'OK' '  └ 备份' ($bak.Path + '（' + $bak.Note + '）')

    # 写后自检
    try {
        $check = (Read-TextFile $configPath).Text | ConvertFrom-Json
        if (-not (Test-JsonObject $check)) { throw '根节点不是对象' }
        if ([string]$check.provider -ne 'custom') { throw 'provider 未变成 custom' }
        $checkLlm = Get-JsonProperty $check 'llm'
        if (-not (Test-JsonObject $checkLlm)) { throw '缺少 llm 段' }
        if ([string](Get-JsonProperty $checkLlm 'baseUrl') -ne $script:BridgeBaseUrl) { throw 'llm.baseUrl 未指向桥接' }
    } catch {
        throw "config.json 写入后自检失败：$($_.Exception.Message)"
    }
}

# ------------------------------------------------------------------ 步骤 2：data/settings.json（不存在则创建）
function Invoke-SettingsStep {
    $settingsPath = $script:SettingsPath
    $existed = [System.IO.File]::Exists($settingsPath)

    # ---- 不存在：创建一份「网页设置」，让网页设置的优先级也指向桥接 ----
    if (-not $existed) {
        if ($DryRun) {
            Add-Result 'OK' 'data/settings.json' ("[预演] 将创建（provider=custom、baseUrl={0}、model={1}、apiKey=默认、keys.custom）" -f $script:BridgeBaseUrl, $script:EffectiveModel)
            return
        }
        $newSettings = [pscustomobject][ordered]@{
            provider = 'custom'
            baseUrl  = $script:BridgeBaseUrl
            model    = $script:EffectiveModel
            apiKey   = $script:EffectiveApiKey
            keys     = [pscustomobject][ordered]@{
                custom = $script:EffectiveApiKey
            }
        }
        $newText = ConvertTo-JsonText $newSettings
        Write-TextFile -Path $settingsPath -Text $newText -WithBom $false
        Add-Result 'OK' 'data/settings.json' ("原本不存在，已创建（provider=custom、baseUrl={0}、model={1}、keys.custom）" -f $script:BridgeBaseUrl, $script:EffectiveModel)
        try {
            $check = (Read-TextFile $settingsPath).Text | ConvertFrom-Json
            if ([string]$check.provider -ne 'custom') { throw 'provider 未变成 custom' }
            if ([string]$check.baseUrl -ne $script:BridgeBaseUrl) { throw 'baseUrl 未指向桥接' }
        } catch {
            throw "data/settings.json 写入后自检失败：$($_.Exception.Message)"
        }
        return
    }

    # ---- 已存在：合并 ----
    $baseline = Read-TextFile $settingsPath
    $st = $null
    try {
        $st = $baseline.Text | ConvertFrom-Json
    } catch {
        Add-Result 'WARN' 'data/settings.json' "不是合法 JSON，已跳过（未做任何改动）：$($_.Exception.Message)"
        return
    }
    if (-not (Test-JsonObject $st)) {
        Add-Result 'WARN' 'data/settings.json' '内容不是 JSON 对象，已跳过（未做任何改动）'
        return
    }

    $origModel = ([string](Get-JsonProperty $st 'model')).Trim()
    if ($origModel.Length -gt 0) { $model = $origModel } else { $model = $script:EffectiveModel }
    $origKey = ([string](Get-JsonProperty $st 'apiKey')).Trim()
    if ($origKey.Length -gt 0) { $apiKey = $origKey } else { $apiKey = $script:EffectiveApiKey }

    Set-JsonProperty -Object $st -Name 'provider' -Value 'custom'
    Set-JsonProperty -Object $st -Name 'baseUrl'  -Value $script:BridgeBaseUrl
    Set-JsonProperty -Object $st -Name 'model'    -Value $model
    Set-JsonProperty -Object $st -Name 'apiKey'   -Value $apiKey

    # keys.custom：鲸鱼娘 saveSettings 按服务商分别存 key，保持一致
    $keys = Get-JsonProperty $st 'keys'
    if (Test-JsonObject $keys) {
        Set-JsonProperty -Object $keys -Name 'custom' -Value $apiKey
    } else {
        $newKeys = [pscustomobject][ordered]@{ custom = $apiKey }
        Set-JsonProperty -Object $st -Name 'keys' -Value $newKeys
    }

    # 网页设置里若留着 mock=true，会让鲸鱼娘走模拟回复、根本不连桥接，必须关掉
    $mockNote = ''
    if ((Test-JsonProperty $st 'mock') -and ((Get-JsonProperty $st 'mock') -eq $true)) {
        Set-JsonProperty -Object $st -Name 'mock' -Value $false
        $mockNote = '；已把旧的 mock=true 关掉（否则聊天会走模拟回复）'
    }

    $newText = ConvertTo-JsonText $st
    if ($newText -eq $baseline.Text) {
        Add-Result 'SKIP' 'data/settings.json' '已是目标状态（provider=custom、baseUrl 指向桥接），未改动'
        return
    }

    if ($DryRun) {
        Add-Result 'OK' 'data/settings.json' ("[预演] 将合并 provider=custom、baseUrl={0}、model={1}、apiKey=保留/默认、keys.custom{2}" -f $script:BridgeBaseUrl, $model, $mockNote)
        return
    }

    # 只有「安装前就存在」的 settings 才需要备份；若是本脚本之前创建的，revert 会直接删除它
    $createdByUs = ($null -ne $script:ExistingMeta) -and ($script:SettingsExisted -eq $false)
    if (-not $createdByUs) {
        $bak = Backup-FileIfMissing -Path $settingsPath
    }
    Write-TextFile -Path $settingsPath -Text $newText -WithBom $false
    Add-Result 'OK' 'data/settings.json' ("已合并（provider=custom、baseUrl={0}、model={1}、keys.custom）{2}" -f $script:BridgeBaseUrl, $model, $mockNote)
    if ($createdByUs) {
        Add-Result 'SKIP' '  └ 备份' '该文件由本脚本创建（安装前不存在），无需另存备份；revert 会删除它'
    } else {
        Add-Result 'OK' '  └ 备份' ($bak.Path + '（' + $bak.Note + '）')
    }

    try {
        $check = (Read-TextFile $settingsPath).Text | ConvertFrom-Json
        if ([string]$check.provider -ne 'custom') { throw 'provider 未变成 custom' }
    } catch {
        throw "data/settings.json 写入后自检失败：$($_.Exception.Message)"
    }
}

# ------------------------------------------------------------------ 步骤 3：web/debug.html 标记块
function Invoke-DebugHtmlStep {
    $debugPath = $script:DebugPath
    if (-not [System.IO.File]::Exists($debugPath)) {
        throw "找不到 web/debug.html（$debugPath），无法注入调试台卡片"
    }

    $file = Read-TextFile $debugPath
    $text = $file.Text
    if ($text.Contains("`r`n")) { $newLine = "`r`n" } else { $newLine = "`n" }
    $block = Get-BridgeMarkerBlock -NewLine $newLine

    $beginIdx = $text.IndexOf($MarkerBegin, [System.StringComparison]::Ordinal)
    $endIdx   = $text.IndexOf($MarkerEnd, [System.StringComparison]::Ordinal)
    $newText = $null
    $action = 'insert'

    if ($beginIdx -ge 0 -and $endIdx -gt $beginIdx) {
        $lineStart = $text.LastIndexOf("`n", $beginIdx)
        if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart = $lineStart + 1 }
        $endAfter = $endIdx + $MarkerEnd.Length
        while ($endAfter -lt $text.Length -and ($text[$endAfter] -eq ' ' -or $text[$endAfter] -eq "`t")) { $endAfter++ }
        if ($endAfter -lt $text.Length -and $text[$endAfter] -eq "`r") { $endAfter++ }
        if ($endAfter -lt $text.Length -and $text[$endAfter] -eq "`n") { $endAfter++ }
        $newText = $text.Substring(0, $lineStart) + $block + $text.Substring($endAfter)
        $action = 'update'
    } else {
        $cleaned = $text
        if ($beginIdx -ge 0 -or $endIdx -ge 0) {
            $cleaned = Remove-MarkerBlockText $cleaned
            $cleaned = [regex]::Replace($cleaned, '(?m)^[ \t]*<script[^\r\n]*debug-bridge\.js[^\r\n]*</script>[ \t]*(?:\r?\n)?', '')
        }
        $mainClose = $cleaned.LastIndexOf('</main>', [System.StringComparison]::Ordinal)
        if ($mainClose -lt 0) {
            throw 'web/debug.html 里找不到 </main>，无法插入标记块（页面结构可能已变，请检查后重试）'
        }
        $lineStart = $cleaned.LastIndexOf("`n", $mainClose)
        if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart = $lineStart + 1 }
        $prefix = $cleaned.Substring($lineStart, $mainClose - $lineStart)
        if ($prefix -match '^[ \t]*$') {
            $newText = $cleaned.Substring(0, $lineStart) + $block + $cleaned.Substring($lineStart)
        } else {
            $newText = $cleaned.Substring(0, $mainClose) + $newLine + $block + $cleaned.Substring($mainClose)
        }
    }

    if ($newText -eq $text) {
        Add-Result 'SKIP' 'web/debug.html' "标记块已存在且指向 $($script:BridgeScriptUrl)，未改动"
        return
    }

    if ($DryRun) {
        if ($action -eq 'update') {
            Add-Result 'OK' 'web/debug.html' "[预演] 将更新标记块端口/内容 → $($script:BridgeScriptUrl)"
        } else {
            Add-Result 'OK' 'web/debug.html' "[预演] 将在 </main> 前插入标记块（$($script:BridgeScriptUrl)）"
        }
        return
    }

    $bak = Backup-FileIfMissing -Path $debugPath
    Write-TextFile -Path $debugPath -Text $newText -WithBom $file.HasBom
    if ($action -eq 'update') {
        Add-Result 'OK' 'web/debug.html' "已更新标记块（$($script:BridgeScriptUrl)）"
    } else {
        Add-Result 'OK' 'web/debug.html' "已在 </main> 前插入标记块（$($script:BridgeScriptUrl)）"
    }
    Add-Result 'OK' '  └ 备份' ($bak.Path + '（' + $bak.Note + '）')

    $check = (Read-TextFile $debugPath).Text
    $beginCount = ([regex]::Matches($check, [regex]::Escape($MarkerBegin))).Count
    $endCount   = ([regex]::Matches($check, [regex]::Escape($MarkerEnd))).Count
    if ($beginCount -ne 1 -or $endCount -ne 1) {
        throw "web/debug.html 写入后自检失败：标记块出现 $beginCount 个 begin / $endCount 个 end"
    }
    if ($check.IndexOf($script:BridgeScriptUrl, [System.StringComparison]::Ordinal) -lt 0) {
        throw 'web/debug.html 写入后自检失败：找不到脚本地址'
    }
    $scriptPos = $check.IndexOf($script:BridgeScriptUrl, [System.StringComparison]::Ordinal)
    $mainPos   = $check.LastIndexOf('</main>', [System.StringComparison]::Ordinal)
    if ($mainPos -lt 0 -or $scriptPos -gt $mainPos) {
        throw 'web/debug.html 写入后自检失败：标记块不在 </main> 之前'
    }
}

# ------------------------------------------------------------------ 步骤 4：还原标记
function Write-InstallMeta {
    if ($DryRun) {
        Add-Result 'OK' '还原标记' '[预演] 将写入 .whale-dsh-bridge.install.json（记录生效端口与安装前状态，供 revert 还原）'
        return
    }
    $previousUpdatedAt = ''
    if ($null -ne $script:ExistingMeta) {
        $previousUpdatedAt = [string](Get-JsonProperty $script:ExistingMeta 'updatedAt')
    }
    if ($script:ChangeCount -gt 0 -or $previousUpdatedAt.Length -eq 0) {
        $updatedAt = (Get-Date).ToString('o')
    } else {
        $updatedAt = $previousUpdatedAt
    }
    $meta = [ordered]@{
        tool                  = 'dsh-whale-bridge/whale-side/install-whale-side.ps1'
        version               = $Version
        bridgePort            = $BridgePort
        bridgeBaseUrl         = $script:BridgeBaseUrl
        firstInstallAt        = $script:FirstInstallAt
        updatedAt             = $updatedAt
        configExisted         = [bool]$script:ConfigExisted
        settingsExisted       = [bool]$script:SettingsExisted
        configInstalledHash   = (Get-FileSha256 $script:ConfigPath)
        settingsInstalledHash = (Get-FileSha256 $script:SettingsPath)
    }
    $text = ConvertTo-JsonText $meta
    if ([System.IO.File]::Exists($script:MetaPath)) {
        $oldText = (Read-TextFile $script:MetaPath).Text
        if ($oldText -eq $text) {
            Add-Result 'SKIP' '还原标记' '内容未变，未改写（' + $script:MetaPath + '）'
            return
        }
    }
    Write-TextFile -Path $script:MetaPath -Text $text -WithBom $false
    Add-Result 'OK' '还原标记' ($script:MetaPath + '（记录安装前状态；revert 会用它判断 settings.json 是否要删除）')
}

# ------------------------------------------------------------------ 主流程
try {
    if ($BridgePort -lt 1 -or $BridgePort -gt 65535) {
        throw "BridgePort 必须是 1-65535 的整数（当前：$BridgePort）"
    }
    try {
        $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    } catch {
        throw "Root 不是合法路径：$Root"
    }
    if (-not [System.IO.Directory]::Exists($resolvedRoot)) {
        throw "鲸鱼娘根目录不存在：$resolvedRoot"
    }
    $Root = $resolvedRoot.TrimEnd('\', '/')

    $script:BridgeBaseUrl   = "http://127.0.0.1:$BridgePort/v1"
    $script:BridgeScriptUrl = "http://127.0.0.1:$BridgePort/static/debug-bridge.js"
    $script:ConfigPath      = Join-Path $Root 'config.json'
    $script:SettingsPath    = Join-Path (Join-Path $Root 'data') 'settings.json'
    $script:DebugPath       = Join-Path (Join-Path $Root 'web') 'debug.html'
    $script:MetaPath        = Join-Path $Root $MetaFileName

    # 安装前状态：首次安装前的 config/settings 是否存在（重复执行时沿用最早一次记录）
    $existingMeta = Read-InstallMeta $script:MetaPath
    $script:ExistingMeta = $existingMeta
    $configNowExists = [System.IO.File]::Exists($script:ConfigPath)
    $settingsNowExists = [System.IO.File]::Exists($script:SettingsPath)
    if ($null -ne $existingMeta) {
        $prevConfig = Get-JsonProperty $existingMeta 'configExisted'
        if ($null -ne $prevConfig) { $script:ConfigExisted = [bool]$prevConfig } else { $script:ConfigExisted = $configNowExists }
        $prevSettings = Get-JsonProperty $existingMeta 'settingsExisted'
        if ($null -ne $prevSettings) { $script:SettingsExisted = [bool]$prevSettings } else { $script:SettingsExisted = $settingsNowExists }
        $firstAt = [string](Get-JsonProperty $existingMeta 'firstInstallAt')
        if ($firstAt.Length -gt 0) { $script:FirstInstallAt = $firstAt }
    } else {
        $script:ConfigExisted = $configNowExists
        $script:SettingsExisted = $settingsNowExists
    }
    if ($script:FirstInstallAt.Length -eq 0) { $script:FirstInstallAt = (Get-Date).ToString('o') }

    Write-Host ''
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host '  DSH 桥接 · 鲸鱼娘侧安装（config.json + settings.json + /debug 卡片）' -ForegroundColor Cyan
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host ('  鲸鱼娘目录 : ' + $Root)
    Write-Host ('  桥接地址   : ' + $script:BridgeBaseUrl + '（写入 config.json 的 llm 段与 custom 段）')
    Write-Host ('  卡片脚本   : ' + $script:BridgeScriptUrl)
    if ($DryRun) {
        Write-Host '  运行模式   : 预演 DryRun（只打印，不写盘、不建备份）' -ForegroundColor Yellow
    } else {
        Write-Host ('  运行模式   : 实际写入（改动前自动备份为 *' + $BackupSuffix + '）')
    }
    Write-Host ''
    Write-Host '检查与写入：' -ForegroundColor Cyan

    $configOk = $false
    $settingsOk = $false
    try { Invoke-ConfigStep; $configOk = $true } catch { $script:FailCount++; Add-Result 'FAIL' 'config.json' $_.Exception.Message }
    try { Invoke-SettingsStep; $settingsOk = $true } catch { $script:FailCount++; Add-Result 'FAIL' 'data/settings.json' $_.Exception.Message }
    try { Invoke-DebugHtmlStep } catch { $script:FailCount++; Add-Result 'FAIL' 'web/debug.html' $_.Exception.Message }

    if ($configOk -and $settingsOk) {
        try { Write-InstallMeta } catch { $script:FailCount++; Add-Result 'FAIL' '还原标记' $_.Exception.Message }
    } elseif ($DryRun) {
        Add-Result 'SKIP' '还原标记' '[预演] 有步骤失败，未写还原标记'
    } else {
        Add-Result 'WARN' '还原标记' 'config.json 或 data/settings.json 未成功处理，未写还原标记；修复后重跑本脚本'
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host ('预演完成：共 ' + $script:ChangeCount + ' 项将改动（没有写盘）。去掉 -DryRun 再执行即可生效。') -ForegroundColor Yellow
    } elseif ($script:FailCount -gt 0) {
        Write-Host ('安装未完全成功：' + $script:FailCount + ' 项失败（见上方 [FAIL]），其余项已处理。') -ForegroundColor Red
    } else {
        Write-Host '安装完成。' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host '下一步：' -ForegroundColor Cyan
    Write-Host ('  1) 启动 DSH：桥接插件加载后监听 127.0.0.1:' + $BridgePort + '（GET /api/health 可验证）。')
    Write-Host '  2) 鲸鱼娘网页：打开/刷新 http://127.0.0.1:8787/debug ，<main> 末尾会出现「DSH 桥接 · 权限与模式」卡片。'
    Write-Host '     config.json 由鲸鱼娘 fs.watch 热加载（一般不用重启）；data/settings.json 每次请求即时读取。'
    Write-Host ('  3) 回滚：powershell -NoProfile -ExecutionPolicy Bypass -File revert-whale-side.ps1 -Root "' + $Root + '"')
    Write-Host ('     回滚会还原 config.json 备份、删除带标记的 /debug 脚本块；settings.json 若安装前不存在则删除（见还原标记 ' + $MetaFileName + '）。')
    Write-Host ''

    if ($script:FailCount -gt 0) { exit 1 } else { exit 0 }
} catch {
    Write-Host ''
    Write-Host ('安装失败：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    exit 1
}
