[CmdletBinding()]
param(
    [string]$BaseRoot,
    [string]$NpxPath
)

$ErrorActionPreference = 'Stop'
$SkillsVersion = '1.5.19'
$Source = 'vercel-labs/agent-skills'
$SkillName = 'vercel-react-best-practices'
if ([string]::IsNullOrWhiteSpace($BaseRoot)) {
    $BaseRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { $env:TEMP }
}
$BaseRoot = [IO.Path]::GetFullPath($BaseRoot)
$SmokeRoot = Join-Path $BaseRoot ('OpenSkillsGUI-CliSmoke-' + [Guid]::NewGuid().ToString('N'))
$IsolatedHome = Join-Path $SmokeRoot 'home'
$WorkDirectory = Join-Path $SmokeRoot 'work'
$TempDirectory = Join-Path $SmokeRoot 'temp'
$ExpectedSkillDirectory = Join-Path $IsolatedHome ".agents\skills\$SkillName"

# 确认目标位于指定根目录内，避免清理真实用户路径。
function Assert-PathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "CLI 冒烟测试路径超出隔离根目录：$fullPath"
    }
}

# 使用固定 npx 和 skills 版本执行命令并捕获完整输出。
function Invoke-SkillsCommand {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $npxArguments = @('--yes', "skills@$SkillsVersion") + $Arguments
    $lines = @(& $NpxPath @npxArguments 2>&1)
    $exitCode = $LASTEXITCODE
    $output = [string](($lines | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
    if ($exitCode -ne 0) {
        $detail = if ($output.Length -gt 4000) { $output.Substring($output.Length - 4000) } else { $output }
        throw "skills 命令失败（退出码 $exitCode）：$detail"
    }
    return $output
}

# 从 list --json 输出中解析 Skill 数组。
function Convert-InstalledList {
    param([Parameter(Mandatory = $true)][string]$Output)

    $json = $Output.Trim()
    try {
        return @($json | ConvertFrom-Json)
    }
    catch {
        $start = $json.IndexOf('[')
        $end = $json.LastIndexOf(']')
        if ($start -lt 0 -or $end -le $start) {
            throw "skills list 未返回 JSON 数组：$Output"
        }
        return @(($json.Substring($start, $end - $start + 1)) | ConvertFrom-Json)
    }
}

# 计算目录内相对路径和文件哈希组成的确定性摘要。
function Get-DirectoryDigest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullRoot = [IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'
    $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse | Sort-Object FullName)
    if ($files.Count -eq 0) { throw "安装后的 Skill 目录为空：$Path" }
    $entries = foreach ($file in $files) {
        $relative = $file.FullName.Substring($fullRoot.Length).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$relative`0$hash"
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

# 确认 list 仅返回一个位于隔离用户目录中的目标 Skill。
function Assert-InstalledSkill {
    param([Parameter(Mandatory = $true)][object[]]$Items)

    $matches = @($Items | Where-Object { $_.name -eq $SkillName })
    if ($matches.Count -ne 1) {
        throw "skills list 中目标 Skill 数量异常：$($matches.Count)"
    }
    $listedPath = [IO.Path]::GetFullPath([string]$matches[0].path).TrimEnd('\')
    $expectedPath = [IO.Path]::GetFullPath($ExpectedSkillDirectory).TrimEnd('\')
    Assert-PathInsideRoot -Path $listedPath -Root $SmokeRoot
    if (-not $listedPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Skill 被安装到非预期路径：$listedPath"
    }
    if ([string]$matches[0].scope -ne 'global') {
        throw "Skill 安装范围不是 global：$($matches[0].scope)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $listedPath 'SKILL.md') -PathType Leaf)) {
        throw '安装后的 Skill 缺少 SKILL.md。'
    }
}

# 只删除本次测试创建的实体隔离目录。
function Remove-SmokeRoot {
    if (-not (Test-Path -LiteralPath $SmokeRoot)) { return }
    Assert-PathInsideRoot -Path $SmokeRoot -Root $BaseRoot
    $item = Get-Item -LiteralPath $SmokeRoot -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "拒绝清理重解析点：$SmokeRoot"
    }
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
}

try {
    if ([string]::IsNullOrWhiteSpace($NpxPath)) {
        $npxCommand = Get-Command npx.cmd -ErrorAction Stop | Select-Object -First 1
        $NpxPath = $npxCommand.Source
    }
    $NpxPath = [IO.Path]::GetFullPath($NpxPath)
    if (-not (Test-Path -LiteralPath $NpxPath -PathType Leaf)) {
        throw "找不到 npx：$NpxPath"
    }

    New-Item -ItemType Directory -Path $IsolatedHome, $WorkDirectory, $TempDirectory -Force | Out-Null
    Assert-PathInsideRoot -Path $IsolatedHome -Root $SmokeRoot
    Assert-PathInsideRoot -Path $WorkDirectory -Root $SmokeRoot
    Assert-PathInsideRoot -Path $TempDirectory -Root $SmokeRoot

    $env:HOME = $IsolatedHome
    $env:USERPROFILE = $IsolatedHome
    $env:HOMEDRIVE = [IO.Path]::GetPathRoot($IsolatedHome).TrimEnd('\')
    $env:HOMEPATH = $IsolatedHome.Substring($env:HOMEDRIVE.Length)
    $env:APPDATA = Join-Path $IsolatedHome 'AppData\Roaming'
    $env:LOCALAPPDATA = Join-Path $IsolatedHome 'AppData\Local'
    $env:XDG_CONFIG_HOME = Join-Path $IsolatedHome '.config'
    $env:XDG_CACHE_HOME = Join-Path $IsolatedHome '.cache'
    $env:CODEX_HOME = Join-Path $IsolatedHome '.codex'
    $env:TEMP = $TempDirectory
    $env:TMP = $TempDirectory
    $env:npm_config_cache = Join-Path $SmokeRoot 'npm-cache'
    $env:npm_config_userconfig = Join-Path $SmokeRoot '.npmrc'
    $env:npm_config_prefix = Join-Path $SmokeRoot 'npm-prefix'
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_audit = 'false'
    $env:DISABLE_TELEMETRY = '1'
    $env:DO_NOT_TRACK = '1'
    $env:NO_UPDATE_NOTIFIER = '1'
    $env:NO_COLOR = '1'
    $env:FORCE_COLOR = '0'
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = 'NUL'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:CI = 'true'

    Push-Location $WorkDirectory
    try {
        $searchOutput = Invoke-SkillsCommand -Arguments @('find', 'react')
        if ([string]::IsNullOrWhiteSpace($searchOutput) -or -not $searchOutput.Contains('https://skills.sh/')) {
            throw '公开 Skill 搜索未返回可识别结果。'
        }

        $addArguments = @('add', $Source, '--skill', $SkillName, '-g', '-a', 'codex', '-y', '--copy')
        [void](Invoke-SkillsCommand -Arguments $addArguments)
        $firstList = Convert-InstalledList -Output (Invoke-SkillsCommand -Arguments @('list', '-g', '--json'))
        Assert-InstalledSkill -Items $firstList
        $firstDigest = Get-DirectoryDigest -Path $ExpectedSkillDirectory

        [void](Invoke-SkillsCommand -Arguments $addArguments)
        $secondList = Convert-InstalledList -Output (Invoke-SkillsCommand -Arguments @('list', '-g', '--json'))
        Assert-InstalledSkill -Items $secondList
        $secondDigest = Get-DirectoryDigest -Path $ExpectedSkillDirectory
        if ($firstDigest -ne $secondDigest) {
            throw '相同来源再次安装后内容摘要发生变化。'
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "skills@$SkillsVersion 真实 CLI 冒烟通过：搜索、隔离安装、列表和再次安装均正常。"
}
finally {
    Remove-SmokeRoot
}
