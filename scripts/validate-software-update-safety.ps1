[CmdletBinding()]
param([string]$BaseRoot)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($BaseRoot)) {
    $BaseRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
}
$BaseRoot = [IO.Path]::GetFullPath($BaseRoot).TrimEnd('\')
$TestRoot = Join-Path $BaseRoot ('OpenSkillsGUI-SoftwareUpdate-' + [Guid]::NewGuid().ToString('N'))
$SoftwareUpdateScript = Join-Path $PSScriptRoot 'software-update.ps1'
$InstallerSource = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'installer\OpenSkillsGUI.iss'
$PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$ZeroHash = '0' * 64

# 确认运行测试仅在本次创建的临时目录内读写。
function Assert-TestRootBoundary {
    $full = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
    if (-not $full.StartsWith(($BaseRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -notlike 'OpenSkillsGUI-SoftwareUpdate-*') {
        throw "拒绝使用临时目录外的测试路径：$full"
    }
}

# 创建测试专属目录联接及实体目标。
function New-TestJunction {
    param([string]$Path, [string]$Target)

    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

# 通过非递归目录删除仅移除联接本身，不进入联接目标。
function Remove-TestJunction {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "拒绝把非联接目录作为联接清理：$Path"
    }
    [IO.Directory]::Delete([IO.Path]::GetFullPath($Path), $false)
}

# 为 ProcessStartInfo 构造不含注入字符的 Windows 参数。
function Convert-ToQuotedArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) { throw '测试参数不能包含双引号。' }
    return '"' + $Value + '"'
}

# 以独立进程和隔离 LOCALAPPDATA 运行更新辅助程序。
function Invoke-UpdateSafetyCase {
    param([string]$HelperPath, [string]$LocalAppData, [string]$InstallerPath)

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $PowerShellPath
    $startInfo.Arguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        (Convert-ToQuotedArgument $HelperPath), '-InstallerPath',
        (Convert-ToQuotedArgument $InstallerPath), '-ExpectedSha256', $ZeroHash,
        '-ParentProcessId', '2147483647', '-ApplicationPath',
        (Convert-ToQuotedArgument (Join-Path $TestRoot 'missing-app.exe'))
    ) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['LOCALAPPDATA'] = $LocalAppData
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw '无法启动软件更新安全测试进程。' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
        $process.Kill()
        throw '软件更新安全测试进程超时。'
    }
    $output = $stdoutTask.Result + $stderrTask.Result
    $logPath = Join-Path $LocalAppData 'OpenSkillsGUI\logs\software-update.log'
    $log = if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        Get-Content -LiteralPath $logPath -Raw -Encoding UTF8
    }
    else { '' }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output; Log = $log }
}

# 要求指定用例清晰拒绝重解析点。
function Assert-ReparsePointRejected {
    param([object]$Result, [string]$CaseName)

    if ($Result.ExitCode -eq 0) { throw "$CaseName 错误通过路径校验。" }
    if (([string]$Result.Log + ' ' + [string]$Result.Output) -notmatch '重解析点') {
        throw "$CaseName 未给出重解析点原因。输出：$($Result.Output)；日志：$($Result.Log)"
    }
}

# 静态确认安装路径固定、启用防联接且只清理三个可再生目录。
function Assert-InstallerUninstallBoundary {
    $source = Get-Content -LiteralPath $InstallerSource -Raw -Encoding UTF8
    foreach ($required in @(
        '#define AppId "io.github.fb208.openskillsgui"',
        'DefaultDirName={localappdata}\Programs\OpenSkillsGUI',
        'DisableDirPage=yes',
        'RedirectionGuard=yes'
    )) {
        if (-not $source.Contains($required)) { throw "安装器缺少固定契约：$required" }
    }
    $match = [regex]::Match($source, '(?ms)^\[UninstallDelete\]\s*(.*?)^\[')
    if (-not $match.Success) { throw '找不到 UninstallDelete 段。' }
    $entries = @($match.Groups[1].Value -split "`r?`n" | Where-Object { $_.Trim().StartsWith('Type:') })
    $expected = @(
        'Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\runtime"',
        'Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\cache"',
        'Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\updates"'
    )
    if ($entries.Count -ne 3) { throw "UninstallDelete 必须且只能有三项，实际 $($entries.Count) 项。" }
    foreach ($entry in $expected) {
        if ($entries -notcontains $entry) { throw "UninstallDelete 缺少固定项：$entry" }
    }
    foreach ($forbidden in @('\data', '\workspace', '\logs', '.agents', '.claude', '.codeium', '*')) {
        if ($match.Groups[1].Value.Contains($forbidden)) { throw "UninstallDelete 包含禁止项：$forbidden" }
    }
}

try {
    Assert-TestRootBoundary
    New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
    Assert-InstallerUninstallBoundary

    $updatesLocal = Join-Path $TestRoot 'updates-case\LocalAppData'
    $updatesTarget = Join-Path $TestRoot 'updates-case\outside-target'
    $updatesLink = Join-Path $updatesLocal 'OpenSkillsGUI\updates'
    New-TestJunction $updatesLink $updatesTarget
    $updatesInstaller = Join-Path $updatesTarget 'OpenSkillsGUI-Setup-x64.exe'
    Set-Content -LiteralPath $updatesInstaller -Value 'not an installer' -Encoding UTF8
    $result = Invoke-UpdateSafetyCase $SoftwareUpdateScript $updatesLocal $updatesInstaller
    Assert-ReparsePointRejected $result 'updates 目录联接'
    if (-not (Test-Path -LiteralPath $updatesInstaller -PathType Leaf)) { throw '错误删除了 updates 联接目标。' }
    Remove-TestJunction $updatesLink

    $installerLocal = Join-Path $TestRoot 'installer-case\LocalAppData'
    $installerLink = Join-Path $installerLocal 'OpenSkillsGUI\updates\OpenSkillsGUI-Setup-x64.exe'
    New-TestJunction $installerLink (Join-Path $TestRoot 'installer-case\outside-target')
    $result = Invoke-UpdateSafetyCase $SoftwareUpdateScript $installerLocal $installerLink
    Assert-ReparsePointRejected $result '安装包重解析点'
    Remove-TestJunction $installerLink

    $helperLocal = Join-Path $TestRoot 'helper-case\LocalAppData'
    $helperUpdates = Join-Path $helperLocal 'OpenSkillsGUI\updates'
    New-Item -ItemType Directory -Path $helperUpdates -Force | Out-Null
    $helperInstaller = Join-Path $helperUpdates 'OpenSkillsGUI-Setup-x64.exe'
    Set-Content -LiteralPath $helperInstaller -Value 'not an installer' -Encoding UTF8
    $helperLink = Join-Path $TestRoot 'helper-case\linked-scripts'
    New-TestJunction $helperLink $PSScriptRoot
    $result = Invoke-UpdateSafetyCase (Join-Path $helperLink 'software-update.ps1') $helperLocal $helperInstaller
    Assert-ReparsePointRejected $result '辅助脚本目录联接'
    if (-not (Test-Path -LiteralPath $helperInstaller -PathType Leaf)) { throw '错误删除了辅助脚本用例安装包。' }
    Remove-TestJunction $helperLink

    Write-Host '安装目录、软件更新与卸载路径安全验证通过。'
}
finally {
    foreach ($junction in @(
        (Join-Path $TestRoot 'updates-case\LocalAppData\OpenSkillsGUI\updates'),
        (Join-Path $TestRoot 'installer-case\LocalAppData\OpenSkillsGUI\updates\OpenSkillsGUI-Setup-x64.exe'),
        (Join-Path $TestRoot 'helper-case\linked-scripts')
    )) { try { Remove-TestJunction $junction } catch { } }
    Assert-TestRootBoundary
    if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
