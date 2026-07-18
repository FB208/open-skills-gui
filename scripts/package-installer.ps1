[CmdletBinding()]
param(
    [string]$IsccPath,
    [string]$DistributionDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$InstallerScript = Join-Path $ProjectRoot 'installer\OpenSkillsGUI.iss'
$OutputDirectory = Join-Path $ProjectRoot 'installer\output'
$StagingDirectory = Join-Path $OutputDirectory 'app-dist'

# 查找并返回固定版本的 Inno Setup 编译器路径。
function Find-Iscc {
    if (-not [string]::IsNullOrWhiteSpace($IsccPath)) {
        return [IO.Path]::GetFullPath($IsccPath)
    }
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
    $defaultPath = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $defaultPath -PathType Leaf) { return $defaultPath }
    throw '找不到 Inno Setup 6.7.3 的 ISCC.exe。'
}

# 定位 Neutralino Windows x64 发布目录。
function Find-Distribution {
    if (-not [string]::IsNullOrWhiteSpace($DistributionDirectory)) {
        return [IO.Path]::GetFullPath($DistributionDirectory)
    }
    $binary = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'dist') -Filter 'OpenSkillsGUI-win_x64.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $binary) {
        throw '找不到 Neutralino Windows x64 构建产物，请先执行发布构建。'
    }
    return $binary.Directory.FullName
}

# 仅复制安装程序需要的 x64 发布文件到临时暂存区。
function Copy-X64Distribution {
    param([Parameter(Mandatory = $true)][string]$SourceDirectory)

    $binary = Join-Path $SourceDirectory 'OpenSkillsGUI-win_x64.exe'
    $resources = Join-Path $SourceDirectory 'resources.neu'
    $extensions = Join-Path $SourceDirectory 'extensions'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "构建目录缺少 $binary" }
    if (-not (Test-Path -LiteralPath $resources -PathType Leaf)) { throw "构建目录缺少 $resources" }
    if (-not (Test-Path -LiteralPath $extensions -PathType Container)) { throw "构建目录缺少 $extensions" }

    if (Test-Path -LiteralPath $StagingDirectory) {
        $fullStaging = [IO.Path]::GetFullPath($StagingDirectory)
        $fullOutput = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
        if (-not $fullStaging.StartsWith($fullOutput, [StringComparison]::OrdinalIgnoreCase)) { throw '拒绝清理安装器输出目录之外的路径。' }
        Remove-Item -LiteralPath $fullStaging -Recurse -Force
    }
    New-Item -ItemType Directory -Path $StagingDirectory -Force | Out-Null
    Copy-Item -LiteralPath $binary -Destination $StagingDirectory
    Copy-Item -LiteralPath $resources -Destination $StagingDirectory
    Copy-Item -LiteralPath $extensions -Destination $StagingDirectory -Recurse
}

& node (Join-Path $PSScriptRoot 'verify-version.mjs')
if ($LASTEXITCODE -ne 0) { throw '版本一致性校验失败。' }
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'validate-powershell.ps1')
if ($LASTEXITCODE -ne 0) { throw 'PowerShell 编码或语法校验失败。' }

$compiler = Find-Iscc
$productVersion = (Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion
if ([string]::IsNullOrWhiteSpace($productVersion) -or -not $productVersion.StartsWith('6.7.3')) {
    throw "必须使用 Inno Setup 6.7.3，当前为 $productVersion。"
}

$distribution = Find-Distribution
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Copy-X64Distribution -SourceDirectory $distribution
$installerPath = Join-Path $OutputDirectory 'OpenSkillsGUI-Setup-x64.exe'
Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue

try {
    & $compiler ('/DSourceRoot=' + $ProjectRoot) ('/DDistributionDir=' + $StagingDirectory) $InstallerScript
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败，退出码为 $LASTEXITCODE。" }
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw '安装程序编译完成，但未生成约定名称的文件。'
    }
    Write-Host "安装程序已生成：$installerPath"
}
finally {
    if (Test-Path -LiteralPath $StagingDirectory) {
        Remove-Item -LiteralPath $StagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
