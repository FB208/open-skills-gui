[CmdletBinding()]
param([switch]$AllowProcessTermination)

$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -and -not $AllowProcessTermination) {
    throw '真实 Restart Manager 测试会终止其自行创建的测试进程；请通过 npm run test:restart-manager 明确执行。'
}

$BaseRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$BaseRoot = [IO.Path]::GetFullPath($BaseRoot).TrimEnd('\')
$TestRoot = Join-Path $BaseRoot ('OpenSkillsGUI-RestartManager-' + [Guid]::NewGuid().ToString('N'))
$LockedFile = Join-Path $TestRoot '独占文件.txt'
$ReadyFile = Join-Path $TestRoot 'holder-ready.txt'
$HolderScript = Join-Path $TestRoot 'hold-exclusive.ps1'
$RestartManagerScript = Join-Path $PSScriptRoot 'restart-manager.ps1'
$PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$TaskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$holder = $null
$holderStartTime = $null

# 确认待清理路径是本测试在临时目录中创建的直接后代。
function Assert-TestRootBoundary {
    $full = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
    if (-not $full.StartsWith(($BaseRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -notlike 'OpenSkillsGUI-RestartManager-*') {
        throw "拒绝使用临时根目录外的测试路径：$full"
    }
}

# 以 PID 和启动时间共同确认仍是原测试进程，防止误伤复用后的 PID。
function Test-OriginalHolderRunning {
    if ($null -eq $holder -or $null -eq $holderStartTime) { return $false }
    $current = Get-Process -Id $holder.Id -ErrorAction SilentlyContinue
    if ($null -eq $current) { return $false }
    try { return $current.StartTime.ToUniversalTime().Ticks -eq $holderStartTime.ToUniversalTime().Ticks }
    catch { return $false }
}

# 调用产品随附脚本并解析 Restart Manager 的 JSON 结果。
function Invoke-RestartManagerQuery {
    $lines = @(& $PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $RestartManagerScript -Path $LockedFile 2>&1)
    $exitCode = $LASTEXITCODE
    try { $payload = ([string]($lines | Select-Object -Last 1)) | ConvertFrom-Json }
    catch { throw "Restart Manager 未返回有效 JSON：$($lines -join ' | ')" }
    if ($exitCode -ne 0 -or -not $payload.ok) { throw "Restart Manager 查询失败：$($payload.error.message)" }
    return $payload
}

# 等待 Restart Manager 观察到刚建立的独占句柄。
function Wait-LockingProcess {
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        $payload = Invoke-RestartManagerQuery
        $match = @($payload.data.processes | Where-Object { [int]$_.pid -eq $holder.Id })
        if ($match.Count -eq 1) { return $match[0] }
        Start-Sleep -Milliseconds 250
    }
    throw "Restart Manager 未发现测试进程 PID $($holder.Id)。"
}

# 尝试重新取得 FileShare.None，用于验证占用前后状态。
function Test-CanOpenExclusively {
    try {
        $stream = New-Object IO.FileStream($LockedFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.Dispose()
        return $true
    }
    catch [IO.IOException] { return $false }
}

# 用 ProcessStartInfo 执行 taskkill，避免把预期错误输出提升为 PowerShell 解析错误。
function Invoke-Taskkill {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $TaskkillPath
    $startInfo.Arguments = "/PID $($holder.Id) /T /F"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw '无法启动 taskkill。' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) {
        $process.Kill()
        throw 'taskkill 执行超时。'
    }
    $output = ($stdoutTask.Result + $stderrTask.Result).Trim()
    if ($process.ExitCode -ne 0) { throw "taskkill 返回错误代码 $($process.ExitCode)：$output" }
}

# 仅在进程身份仍匹配时使用 taskkill /T /F 终止测试进程树。
function Stop-HolderWithTaskkill {
    if (-not (Test-OriginalHolderRunning)) { return }
    Invoke-Taskkill
    if (-not $holder.WaitForExit(10000)) { throw '测试进程在 taskkill 后仍未退出。' }
}

# taskkill 受运行沙箱限制时，仅为安全清理回收本脚本直接创建的子进程。
function Stop-HolderForCleanup {
    if (-not (Test-OriginalHolderRunning)) { return }
    try { Stop-HolderWithTaskkill }
    catch {
        Write-Warning $_.Exception.Message
        if (Test-OriginalHolderRunning) {
            $holder.Kill()
            [void]$holder.WaitForExit(10000)
        }
    }
}

try {
    Assert-TestRootBoundary
    New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
    Set-Content -LiteralPath $LockedFile -Value 'Open Skills GUI Restart Manager integration test' -Encoding UTF8
    $holderSource = @'
[CmdletBinding()]
param([string]$FilePath, [string]$ReadyPath)
$ErrorActionPreference = 'Stop'
$stream = New-Object IO.FileStream($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    Set-Content -LiteralPath $ReadyPath -Value $PID -Encoding ASCII
    while ($true) { Start-Sleep -Seconds 1 }
}
finally { $stream.Dispose() }
'@
    Set-Content -LiteralPath $HolderScript -Value $holderSource -Encoding UTF8
    $arguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $HolderScript),
        '-FilePath', ('"{0}"' -f $LockedFile), '-ReadyPath', ('"{0}"' -f $ReadyFile)
    )
    $holder = Start-Process -FilePath $PowerShellPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $holderStartTime = $holder.StartTime

    for ($attempt = 1; $attempt -le 100 -and -not (Test-Path -LiteralPath $ReadyFile -PathType Leaf); $attempt++) {
        if ($holder.HasExited) { throw "独占句柄测试进程提前退出，代码 $($holder.ExitCode)。" }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $ReadyFile -PathType Leaf)) { throw '等待独占句柄测试进程超时。' }

    $lockingProcess = Wait-LockingProcess
    $expectedName = [IO.Path]::GetFileNameWithoutExtension($PowerShellPath)
    if (-not ([string]$lockingProcess.name).Equals($expectedName, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Restart Manager 进程名不正确：期望 $expectedName，实际 $($lockingProcess.name)。"
    }

    # 模拟取消：不调用 taskkill，并确认进程与独占句柄保持不变。
    Start-Sleep -Milliseconds 300
    if (-not (Test-OriginalHolderRunning)) { throw '取消强制关闭后测试进程被错误终止。' }
    if (Test-CanOpenExclusively) { throw '取消强制关闭后独占文件被错误释放。' }
    Write-Host "Restart Manager 已识别 PID $($lockingProcess.pid) 和进程名 $($lockingProcess.name)，取消路径验证通过。"

    Stop-HolderWithTaskkill
    if (Test-OriginalHolderRunning) { throw '确认强制关闭后测试进程仍在运行。' }
    if (-not (Test-CanOpenExclusively)) { throw '确认强制关闭后仍无法重试独占文件操作。' }
    Write-Host 'taskkill /T /F 与文件操作重试验证通过。'
}
finally {
    Stop-HolderForCleanup
    Assert-TestRootBoundary
    if (-not (Test-OriginalHolderRunning) -and (Test-Path -LiteralPath $TestRoot)) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
