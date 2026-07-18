[CmdletBinding()]
param([string]$BaseRoot)

$ErrorActionPreference = 'Stop'
$Bootstrap = Join-Path $PSScriptRoot 'runtime-bootstrap.ps1'
$Manifest = Join-Path $PSScriptRoot 'runtime-manifest.json'
if ([string]::IsNullOrWhiteSpace($BaseRoot)) {
    $BaseRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { $env:TEMP }
}
$TestRoot = Join-Path $BaseRoot ('OpenSkillsGUI-PathSafety-' + [Guid]::NewGuid().ToString('N'))

# 在独立 Windows PowerShell 进程中执行运行环境状态检查。
function Invoke-BootstrapStatus {
    param([Parameter(Mandatory = $true)][string]$DataRoot)

    $lines = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Bootstrap -Action Status -DataRoot $DataRoot -ManifestPath $Manifest 2>&1)
    $exitCode = $LASTEXITCODE
    $jsonLine = [string]($lines | Select-Object -Last 1)
    try {
        $payload = $jsonLine | ConvertFrom-Json
    }
    catch {
        throw "运行环境脚本未返回有效 JSON。输出：$($lines -join ' | ')"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Payload = $payload }
}

# 确认包含目录联接的数据路径被明确拒绝。
function Assert-ReparsePointRejected {
    param([Parameter(Mandatory = $true)][string]$DataRoot)

    $result = Invoke-BootstrapStatus -DataRoot $DataRoot
    if ($result.ExitCode -eq 0 -or $result.Payload.ok) {
        throw "运行环境脚本错误接受了包含目录联接的路径：$DataRoot"
    }
    if ([string]$result.Payload.error.message -notmatch '重解析点') {
        throw "目录联接拒绝原因不明确：$($result.Payload.error.message)"
    }
}

# 创建路径安全测试使用的目录联接。
function New-TestJunction {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Target
    )

    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

# 仅删除测试创建的目录联接本身。
function Remove-TestJunction {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "测试清理拒绝删除非联接目录：$Path"
    }
    Remove-Item -LiteralPath $Path -Force
}

try {
    New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null

    $physicalData = Join-Path $TestRoot 'physical-data'
    New-Item -ItemType Directory -Path $physicalData -Force | Out-Null
    $physicalResult = Invoke-BootstrapStatus -DataRoot $physicalData
    if ($physicalResult.ExitCode -ne 0 -or -not $physicalResult.Payload.ok) {
        throw "实体目录被错误拒绝：$($physicalResult.Payload.error.message)"
    }

    $linkedData = Join-Path $TestRoot 'linked-data'
    New-TestJunction -Path $linkedData -Target (Join-Path $TestRoot 'linked-data-target')
    Assert-ReparsePointRejected -DataRoot $linkedData
    Remove-TestJunction -Path $linkedData

    $runtimeData = Join-Path $TestRoot 'runtime-data'
    New-Item -ItemType Directory -Path $runtimeData -Force | Out-Null
    $runtimeLink = Join-Path $runtimeData 'runtime'
    New-TestJunction -Path $runtimeLink -Target (Join-Path $TestRoot 'runtime-target')
    Assert-ReparsePointRejected -DataRoot $runtimeData
    Remove-TestJunction -Path $runtimeLink

    $updatesData = Join-Path $TestRoot 'updates-data'
    New-Item -ItemType Directory -Path $updatesData -Force | Out-Null
    $updatesLink = Join-Path $updatesData 'updates'
    New-TestJunction -Path $updatesLink -Target (Join-Path $TestRoot 'updates-target')
    Assert-ReparsePointRejected -DataRoot $updatesData
    Remove-TestJunction -Path $updatesLink

    $source = Get-Content -LiteralPath $Bootstrap -Raw -Encoding UTF8
    foreach ($requiredStatement in @(
        'Assert-DirectChildPath -Path $workRoot -Root $updatesRoot',
        'Assert-SafeDirectoryPath -Path $workRoot',
        'Remove-SafeDirectory -Path $workRoot -Root $updatesRoot'
    )) {
        if (-not $source.Contains($requiredStatement)) {
            throw "运行环境脚本缺少 work 目录安全约束：$requiredStatement"
        }
    }

    Write-Host '运行环境路径安全验证通过：实体目录可用，DataRoot/runtime/updates 联接均被拒绝。'
}
finally {
    foreach ($junction in @(
        (Join-Path $TestRoot 'linked-data'),
        (Join-Path $TestRoot 'runtime-data\runtime'),
        (Join-Path $TestRoot 'updates-data\updates')
    )) {
        try { Remove-TestJunction -Path $junction } catch { }
    }
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
