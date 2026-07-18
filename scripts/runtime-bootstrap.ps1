[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Status', 'Install')]
    [string]$Action,

    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'OpenSkillsGUI'),

    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $PSScriptRoot 'runtime-manifest.json'
}

# 输出后端和首次启动界面都能稳定解析的单行 JSON。
function Write-JsonResult {
    param([bool]$Ok, [object]$Data, [object]$ErrorData)

    $result = [ordered]@{ ok = $Ok }
    if ($Ok) { $result.data = $Data } else { $result.error = $ErrorData }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 10 -Compress))
}

# 拒绝在非原生 Windows x64 系统上安装运行环境。
function Assert-WindowsX64 {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Open Skills GUI 仅支持 Windows x64。'
    }
    $nativeArchitecture = if ([string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
        $env:PROCESSOR_ARCHITECTURE
    }
    else {
        $env:PROCESSOR_ARCHITEW6432
    }
    if ($nativeArchitecture -ne 'AMD64') {
        throw 'Open Skills GUI 仅支持原生 Windows x64，不支持 ARM64。'
    }
}

# 从命令输出中提取并转换版本号。
function Convert-ToVersion {
    param([Parameter(Mandatory = $true)][string]$Value)

    $match = [regex]::Match($Value, '\d+\.\d+\.\d+(?:\.\d+)?')
    if (-not $match.Success) {
        throw "无法解析版本号：$Value"
    }
    return [version]$match.Value
}

# 安全调用可执行文件并取得首行版本信息。
function Invoke-VersionCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $lines = @(& $Executable @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
    $output = [string]($lines | Select-Object -First 1)
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
        throw "无法获取版本：$Executable"
    }
    return $output.Trim()
}

# 检查可执行文件版本并返回规范化信息。
function Test-VersionedExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][version]$MinimumVersion,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $rawVersion = Invoke-VersionCommand -Executable $Path -Arguments $Arguments
        $version = Convert-ToVersion -Value $rawVersion
        if ($version -lt $MinimumVersion) { return $null }
        return [ordered]@{ path = [IO.Path]::GetFullPath($Path); version = $version.ToString() }
    }
    catch {
        return $null
    }
}

# Node 与 npx 必须来自同一个安装根目录，避免混用不同版本。
function Test-NodeNpxPair {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][object]$Manifest
    )

    $node = Test-VersionedExecutable -Path $NodePath -MinimumVersion ([version]$Manifest.node.minimumVersion) -Arguments @('--version')
    if ($null -eq $node) { return $null }

    $nodeRoot = Split-Path -Parent $node.path
    $npxCommand = Join-Path $nodeRoot $Manifest.node.npxExecutable
    $npxScript = Join-Path $nodeRoot $Manifest.node.npxScript
    if (Test-Path -LiteralPath $npxCommand -PathType Leaf) {
        try {
            $npxVersion = Invoke-VersionCommand -Executable $npxCommand -Arguments @('--version')
            return [ordered]@{
                node = [ordered]@{ available = $true; path = $node.path; version = $node.version; source = $Source }
                npx = [ordered]@{ available = $true; path = $npxCommand; version = $npxVersion; source = $Source }
            }
        }
        catch { }
    }
    if (Test-Path -LiteralPath $npxScript -PathType Leaf) {
        try {
            $npxVersion = Invoke-VersionCommand -Executable $node.path -Arguments @($npxScript, '--version')
            return [ordered]@{
                node = [ordered]@{ available = $true; path = $node.path; version = $node.version; source = $Source }
                npx = [ordered]@{ available = $true; path = $npxScript; version = $npxVersion; source = $Source }
            }
        }
        catch { }
    }
    return $null
}

# 依次查找私有和系统 Node/npx 配对。
function Find-NodeNpxPair {
    param([Parameter(Mandatory = $true)][object]$Manifest)

    $privateNode = Join-Path (Join-Path (Join-Path $DataRoot 'runtime') $Manifest.node.installDirectory) $Manifest.node.executable
    $pair = Test-NodeNpxPair -NodePath $privateNode -Source 'private' -Manifest $Manifest
    if ($null -ne $pair) { return $pair }

    $seen = @{}
    $commands = @(Get-Command node.exe -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if ($null -eq $command.Source) { continue }
        $key = $command.Source.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $pair = Test-NodeNpxPair -NodePath $command.Source -Source 'system' -Manifest $Manifest
        if ($null -ne $pair) { return $pair }
    }
    return $null
}

# 依次查找私有和系统 Git。
function Find-Git {
    param([Parameter(Mandatory = $true)][object]$Manifest)

    $privateGit = Join-Path (Join-Path (Join-Path $DataRoot 'runtime') $Manifest.git.installDirectory) $Manifest.git.executable
    $git = Test-VersionedExecutable -Path $privateGit -MinimumVersion ([version]$Manifest.git.minimumVersion) -Arguments @('--version')
    if ($null -ne $git) {
        return [ordered]@{ available = $true; path = $git.path; version = $git.version; source = 'private' }
    }

    $commands = @(Get-Command git.exe -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if ($null -eq $command.Source) { continue }
        $git = Test-VersionedExecutable -Path $command.Source -MinimumVersion ([version]$Manifest.git.minimumVersion) -Arguments @('--version')
        if ($null -ne $git) {
            return [ordered]@{ available = $true; path = $git.path; version = $git.version; source = 'system' }
        }
    }
    return [ordered]@{ available = $false; reason = "Git 不存在或版本低于 $($Manifest.git.minimumVersion)" }
}

# 汇总 Node、npx 和 Git 的当前可用状态。
function Get-RuntimeStatus {
    param([Parameter(Mandatory = $true)][object]$Manifest)

    $pair = Find-NodeNpxPair -Manifest $Manifest
    if ($null -eq $pair) {
        $node = [ordered]@{ available = $false; reason = "需要同一安装目录中的 Node.js >= $($Manifest.node.minimumVersion) 与 npx" }
        $npx = [ordered]@{ available = $false; reason = '未找到与 Node.js 配套的 npx' }
    }
    else {
        $node = $pair.node
        $npx = $pair.npx
    }
    $git = Find-Git -Manifest $Manifest
    return [ordered]@{
        ready = [bool]($node.available -and $npx.available -and $git.available)
        node = $node
        npx = $npx
        git = $git
    }
}

# 获取路径属性；路径不存在时返回空值。
function Get-PathAttributes {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        return [IO.File]::GetAttributes([IO.Path]::GetFullPath($Path))
    }
    catch [IO.FileNotFoundException] {
        return $null
    }
    catch [IO.DirectoryNotFoundException] {
        return $null
    }
}

# 检查从卷根到目标的每个现存路径段，防止目录联接或符号链接绕过边界。
function Assert-NoReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "路径没有有效卷根：$fullPath"
    }

    $current = $pathRoot
    $rootAttributes = Get-PathAttributes -Path $current
    if ($null -ne $rootAttributes -and ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "拒绝使用包含重解析点的路径：$current"
    }

    $relative = $fullPath.Substring($pathRoot.Length).Trim('\')
    if ([string]::IsNullOrWhiteSpace($relative)) { return }
    foreach ($segment in $relative.Split('\')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $current = Join-Path $current $segment
        $attributes = Get-PathAttributes -Path $current
        if ($null -eq $attributes) { break }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "拒绝使用包含重解析点的路径：$current"
        }
        if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -and
            -not $current.Equals($fullPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "路径父级不是目录：$current"
        }
    }
}

# 确认目录路径的现存父链不含重解析点且类型正确。
function Assert-SafeDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-NoReparsePointInExistingPath -Path $Path
    $attributes = Get-PathAttributes -Path $Path
    if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "预期路径为目录：$([IO.Path]::GetFullPath($Path))"
    }
}

# 使用规范化绝对路径确认目标位于允许根目录内。
function Assert-PathInsideRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作数据目录外的路径：$fullPath"
    }
}

# 所有可递归清理和原子切换目标都必须是受控根目录的直接子目录。
function Assert-DirectChildPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)

    Assert-PathInsideRoot -Path $Path -Root $Root
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $parent = [IO.Path]::GetDirectoryName($fullPath).TrimEnd('\')
    if (-not $parent.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "仅允许操作受控根目录的直接子目录：$fullPath"
    }
}

# 仅递归清理受控根目录下的实体直接子目录。
function Remove-SafeDirectory {
    param([string]$Path, [string]$Root, [switch]$IgnoreErrors)

    Assert-SafeDirectoryPath -Path $Root
    Assert-DirectChildPath -Path $Path -Root $Root
    Assert-SafeDirectoryPath -Path $Path
    $attributes = Get-PathAttributes -Path $Path
    if ($null -eq $attributes) { return }

    if ($IgnoreErrors) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

# 在同一磁盘内通过目录重命名切换新旧运行环境。
function Install-DirectoryAtomically {
    param([string]$Source, [string]$Target, [string]$RuntimeRoot)

    $suffix = [Guid]::NewGuid().ToString('N')
    $incoming = "$Target.incoming-$suffix"
    $backup = "$Target.backup-$suffix"
    Assert-SafeDirectoryPath -Path $RuntimeRoot
    Assert-SafeDirectoryPath -Path $Source
    Assert-DirectChildPath -Path $Target -Root $RuntimeRoot
    Assert-DirectChildPath -Path $incoming -Root $RuntimeRoot
    Assert-DirectChildPath -Path $backup -Root $RuntimeRoot
    Assert-SafeDirectoryPath -Path $Target
    Assert-SafeDirectoryPath -Path $incoming
    Assert-SafeDirectoryPath -Path $backup
    Move-Item -LiteralPath $Source -Destination $incoming
    Assert-SafeDirectoryPath -Path $incoming

    $activated = $false
    try {
        if (Test-Path -LiteralPath $Target) {
            Move-Item -LiteralPath $Target -Destination $backup
            Assert-SafeDirectoryPath -Path $backup
        }
        Move-Item -LiteralPath $incoming -Destination $Target
        Assert-SafeDirectoryPath -Path $Target
        $activated = $true
    }
    catch {
        if ((-not (Test-Path -LiteralPath $Target)) -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $Target
        }
        throw
    }
    finally {
        if (-not $activated) {
            Remove-SafeDirectory -Path $incoming -Root $RuntimeRoot -IgnoreErrors
        }
    }
    Remove-SafeDirectory -Path $backup -Root $RuntimeRoot -IgnoreErrors
}

# 下载、校验、解压并原子安装单个运行环境组件。
function Install-RuntimeComponent {
    param([object]$Component, [string]$RuntimeRoot, [string]$WorkRoot)

    $componentWork = Join-Path $WorkRoot $Component.installDirectory
    Assert-DirectChildPath -Path $componentWork -Root $WorkRoot
    Assert-SafeDirectoryPath -Path $componentWork
    $archivePath = Join-Path $componentWork $Component.fileName
    $extractPath = Join-Path $componentWork 'extract'
    New-Item -ItemType Directory -Path $componentWork -Force | Out-Null
    Assert-SafeDirectoryPath -Path $componentWork
    Assert-NoReparsePointInExistingPath -Path $archivePath
    Assert-SafeDirectoryPath -Path $extractPath
    Invoke-WebRequest -UseBasicParsing -Uri $Component.url -OutFile $archivePath

    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$Component.sha256).ToLowerInvariant()) {
        throw "$($Component.fileName) 的 SHA-256 校验失败"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    Assert-SafeDirectoryPath -Path $extractPath
    $sourcePath = $extractPath
    if (-not [string]::IsNullOrWhiteSpace([string]$Component.archiveRoot)) {
        $sourcePath = Join-Path $extractPath $Component.archiveRoot
        Assert-PathInsideRoot -Path $sourcePath -Root $extractPath
    }
    Assert-SafeDirectoryPath -Path $sourcePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "$($Component.fileName) 的压缩包结构不符合运行清单"
    }

    $targetPath = Join-Path $RuntimeRoot $Component.installDirectory
    Assert-DirectChildPath -Path $targetPath -Root $RuntimeRoot
    Install-DirectoryAtomically -Source $sourcePath -Target $targetPath -RuntimeRoot $RuntimeRoot
}

try {
    Assert-WindowsX64
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "找不到运行环境清单：$ManifestPath"
    }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'x64') {
        throw '运行环境清单版本或架构无效。'
    }

    $DataRoot = [IO.Path]::GetFullPath($DataRoot)
    $runtimeRoot = Join-Path $DataRoot 'runtime'
    $updatesRoot = Join-Path $DataRoot 'updates'
    Assert-SafeDirectoryPath -Path $DataRoot
    Assert-SafeDirectoryPath -Path $runtimeRoot
    Assert-SafeDirectoryPath -Path $updatesRoot

    $status = Get-RuntimeStatus -Manifest $manifest
    if ($Action -eq 'Install' -and -not $status.ready) {
        $workRoot = Join-Path $updatesRoot ('runtime-' + [Guid]::NewGuid().ToString('N'))
        Assert-DirectChildPath -Path $workRoot -Root $updatesRoot
        Assert-SafeDirectoryPath -Path $workRoot

        New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
        Assert-SafeDirectoryPath -Path $DataRoot
        New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        Assert-SafeDirectoryPath -Path $runtimeRoot
        New-Item -ItemType Directory -Path $updatesRoot -Force | Out-Null
        Assert-SafeDirectoryPath -Path $updatesRoot
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        Assert-SafeDirectoryPath -Path $workRoot

        try {
            if (-not ($status.node.available -and $status.npx.available)) {
                Install-RuntimeComponent -Component $manifest.node -RuntimeRoot $runtimeRoot -WorkRoot $workRoot
            }
            if (-not $status.git.available) {
                Install-RuntimeComponent -Component $manifest.git -RuntimeRoot $runtimeRoot -WorkRoot $workRoot
            }
        }
        finally {
            Remove-SafeDirectory -Path $workRoot -Root $updatesRoot -IgnoreErrors
        }

        $status = Get-RuntimeStatus -Manifest $manifest
        if (-not $status.ready) {
            throw '运行环境安装完成，但最终检查未通过。'
        }
    }

    Write-JsonResult -Ok $true -Data $status -ErrorData $null
    exit 0
}
catch {
    Write-JsonResult -Ok $false -Data $null -ErrorData ([ordered]@{
        code = 'RUNTIME_BOOTSTRAP_FAILED'
        message = $_.Exception.Message
    })
    exit 1
}
