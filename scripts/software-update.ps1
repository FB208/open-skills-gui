[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [string]$ApplicationPath = (Join-Path $env:LOCALAPPDATA 'Programs\OpenSkillsGUI\OpenSkillsGUI.exe')
)

$ErrorActionPreference = 'Stop'
$DataRoot = Join-Path $env:LOCALAPPDATA 'OpenSkillsGUI'
$UpdatesRoot = Join-Path $DataRoot 'updates'
$LogDirectory = Join-Path $DataRoot 'logs'
$LogPath = Join-Path $LogDirectory 'software-update.log'
$HelperPath = [IO.Path]::GetFullPath($PSCommandPath)
$validatedInstaller = $null

# 获取路径属性；不存在的路径返回空值。
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

# 从卷根逐层拒绝现存路径中的目录联接和符号链接。
function Assert-NoReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "路径没有有效卷根：$fullPath"
    }

    $current = $pathRoot
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

# 校验目录路径及其所有现存父级均为实体目录。
function Assert-SafeDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-NoReparsePointInExistingPath -Path $Path
    $attributes = Get-PathAttributes -Path $Path
    if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "预期路径为目录：$([IO.Path]::GetFullPath($Path))"
    }
}

# 校验文件及父链没有重解析点，并按需允许文件尚不存在。
function Assert-SafeFilePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowMissing
    )

    Assert-NoReparsePointInExistingPath -Path $Path
    $attributes = Get-PathAttributes -Path $Path
    if ($null -eq $attributes) {
        if ($AllowMissing) { return }
        throw "找不到文件：$([IO.Path]::GetFullPath($Path))"
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        throw "预期路径为文件：$([IO.Path]::GetFullPath($Path))"
    }
}

# 隐藏日志中的用户主目录，避免记录用户身份路径。
function Protect-LogMessage {
    param([Parameter(Mandatory = $true)][string]$Message)

    $result = $Message
    foreach ($userHomeCandidate in @($env:USERPROFILE, [Environment]::GetFolderPath('UserProfile'))) {
        if ([string]::IsNullOrWhiteSpace($userHomeCandidate)) { continue }
        $result = [regex]::Replace(
            $result,
            [regex]::Escape([IO.Path]::GetFullPath($userHomeCandidate).TrimEnd('\')),
            '%USERPROFILE%',
            [Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }
    return $result
}

# 将软件更新过程写入经过路径校验的本地日志。
function Write-UpdateLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    Assert-SafeDirectoryPath -Path $LogDirectory
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    Assert-SafeDirectoryPath -Path $LogDirectory
    Assert-SafeFilePath -Path $LogPath -AllowMissing
    Add-Content -LiteralPath $LogPath -Value ('{0:u} {1}' -f (Get-Date), (Protect-LogMessage -Message $Message)) -Encoding UTF8
}

# 仅接受实体 updates 目录中的固定发布文件。
function Assert-InstallerBoundary {
    param([Parameter(Mandatory = $true)][string]$CandidatePath)

    $fullInstallerPath = [IO.Path]::GetFullPath($CandidatePath)
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $UpdatesRoot 'OpenSkillsGUI-Setup-x64.exe'))
    Assert-SafeDirectoryPath -Path $DataRoot
    Assert-SafeDirectoryPath -Path $UpdatesRoot
    if (-not $fullInstallerPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw '安装包必须是本工具 updates 目录中的固定发布文件。'
    }
    Assert-SafeFilePath -Path $fullInstallerPath
    return $fullInstallerPath
}

# 规范化并校验 Release 提供的 SHA-256 摘要。
function Convert-ExpectedHash {
    $expected = $ExpectedSha256.Trim().ToLowerInvariant()
    if ($expected.StartsWith('sha256:')) { $expected = $expected.Substring(7) }
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw 'GitHub Release 未提供有效的 SHA-256 摘要。'
    }
    return $expected
}

# 等待当前主程序退出，避免覆盖正在使用的文件。
function Wait-ForParentExit {
    $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($null -ne $parent -and -not $parent.WaitForExit(60000)) {
        throw '等待主程序退出超时。'
    }
}

# 以静默覆盖参数运行再次校验过的安装程序。
function Invoke-Installer {
    param([Parameter(Mandatory = $true)][string]$Path)

    $safePath = Assert-InstallerBoundary -CandidatePath $Path
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $safePath
    $startInfo.Arguments = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /REDIRECTIONGUARD'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw '无法启动软件更新安装程序。' }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "安装程序返回错误代码 $($process.ExitCode)。"
    }
}

# 更新完成后仅重启实体安装目录中的主程序。
function Start-UpdatedApplication {
    if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) { return }
    Assert-SafeFilePath -Path $ApplicationPath
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = [IO.Path]::GetFullPath($ApplicationPath)
    $startInfo.WorkingDirectory = Split-Path -Parent $startInfo.FileName
    $startInfo.UseShellExecute = $true
    [void][Diagnostics.Process]::Start($startInfo)
}

# 只删除仍位于实体 updates 目录中的固定安装包。
function Remove-ValidatedInstaller {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $safePath = Assert-InstallerBoundary -CandidatePath $Path
    Remove-Item -LiteralPath $safePath -Force
}

try {
    Assert-SafeFilePath -Path $HelperPath
    $validatedInstaller = Assert-InstallerBoundary -CandidatePath $InstallerPath
    $expectedHash = Convert-ExpectedHash
    Write-UpdateLog -Message '软件更新辅助程序已启动，等待主程序退出。'
    Wait-ForParentExit

    # 父进程退出后重新校验路径和摘要，缩小校验与执行之间的替换窗口。
    $validatedInstaller = Assert-InstallerBoundary -CandidatePath $validatedInstaller
    $actualHash = (Get-FileHash -LiteralPath $validatedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw '软件更新安装包的 SHA-256 校验失败。'
    }
    $validatedInstaller = Assert-InstallerBoundary -CandidatePath $validatedInstaller

    Write-UpdateLog -Message '更新安装包复核通过，开始静默覆盖安装。'
    Invoke-Installer -Path $validatedInstaller
    Write-UpdateLog -Message '软件更新安装完成。'
    Start-UpdatedApplication
    exit 0
}
catch {
    try { Write-UpdateLog -Message ('软件更新失败：' + $_.Exception.Message) } catch { }
    [Console]::Error.WriteLine('软件更新失败：' + (Protect-LogMessage -Message $_.Exception.Message))
    exit 1
}
finally {
    if ($null -ne $validatedInstaller) {
        try { Remove-ValidatedInstaller -Path $validatedInstaller } catch { }
    }
}
