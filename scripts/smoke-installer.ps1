[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallerPath)

$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw '安装/卸载冒烟测试只能在 CI 临时环境中运行。' }

$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$AppDirectory = Join-Path $env:LOCALAPPDATA 'Programs\OpenSkillsGUI'
$AppExecutable = Join-Path $AppDirectory 'OpenSkillsGUI.exe'
$Uninstaller = Join-Path $AppDirectory 'unins000.exe'
$DataRoot = Join-Path $env:LOCALAPPDATA 'OpenSkillsGUI'
$MarkerName = 'open-skills-gui-ci-smoke'
$Preserved = @(
    (Join-Path $DataRoot 'data\ci-smoke.txt'),
    (Join-Path $DataRoot 'workspace\disabled\ci-smoke\SKILL.md'),
    (Join-Path $DataRoot 'logs\ci-smoke.log')
)
$DisposableRoots = @(
    (Join-Path $DataRoot 'runtime'),
    (Join-Path $DataRoot 'cache'),
    (Join-Path $DataRoot 'updates')
)
$Disposable = @($DisposableRoots | ForEach-Object { Join-Path $_ 'ci-smoke.txt' })
$CanonicalSkill = Join-Path $env:USERPROFILE ".agents\skills\$MarkerName"
$ClaudeSkill = Join-Path $env:USERPROFILE ".claude\skills\$MarkerName"
$WindsurfSkill = Join-Path $env:USERPROFILE ".codeium\windsurf\skills\$MarkerName"
$SetupArguments = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /REDIRECTIONGUARD'
$UninstallArguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /REDIRECTIONGUARD'

# 启动安装或卸载程序并校验退出码。
function Invoke-SetupProcess {
    param([string]$Path, [string]$Arguments)

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "无法启动 $Path" }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "$Path 返回错误代码 $($process.ExitCode)。" }
}

# 创建冒烟测试使用的标记文件及父目录。
function New-MarkerFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    Set-Content -LiteralPath $Path -Value 'Open Skills GUI CI smoke marker' -Encoding UTF8
}

# 只删除测试自行创建的目录联接，不进入联接目标。
function Remove-SmokeJunction {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "冒烟测试拒绝把非联接目录作为联接清理：$Path"
    }
    Remove-Item -LiteralPath $Path -Force
}

if (Test-Path -LiteralPath $AppDirectory) { throw 'CI 环境中已存在 Open Skills GUI 安装目录。' }
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw '找不到待测试安装程序。' }
foreach ($testOwnedPath in @($CanonicalSkill, $ClaudeSkill, $WindsurfSkill)) {
    if (Test-Path -LiteralPath $testOwnedPath) { throw "CI 环境中已存在测试保留路径：$testOwnedPath" }
}

try {
    Invoke-SetupProcess -Path $InstallerPath -Arguments $SetupArguments
    if (-not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) { throw '静默安装后找不到主程序。' }
    if (-not (Test-Path -LiteralPath $Uninstaller -PathType Leaf)) { throw '静默安装后找不到卸载程序。' }

    foreach ($marker in $Preserved) { New-MarkerFile -Path $marker }
    Invoke-SetupProcess -Path $InstallerPath -Arguments $SetupArguments
    foreach ($marker in $Preserved) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "覆盖升级错误删除了用户数据：$marker" }
    }

    foreach ($marker in $Disposable) { New-MarkerFile -Path $marker }
    New-MarkerFile -Path (Join-Path $CanonicalSkill 'SKILL.md')
    New-Item -ItemType Directory -Path (Split-Path -Parent $ClaudeSkill), (Split-Path -Parent $WindsurfSkill) -Force | Out-Null
    New-Item -ItemType Junction -Path $ClaudeSkill -Target $CanonicalSkill | Out-Null
    New-Item -ItemType Junction -Path $WindsurfSkill -Target $CanonicalSkill | Out-Null

    Invoke-SetupProcess -Path $Uninstaller -Arguments $UninstallArguments
    foreach ($marker in $Preserved) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "卸载错误删除了用户数据：$marker" }
    }
    foreach ($root in $DisposableRoots) {
        if (Test-Path -LiteralPath $root) { throw "卸载未完整清理可再生目录：$root" }
    }
    foreach ($skillPath in @($CanonicalSkill, $ClaudeSkill, $WindsurfSkill)) {
        if (-not (Test-Path -LiteralPath $skillPath)) { throw "卸载错误删除了 Skill 或联接：$skillPath" }
    }
    if (Test-Path -LiteralPath $AppDirectory) { throw '卸载后程序安装目录仍然存在。' }
    Write-Host '安装、覆盖升级与卸载冒烟测试通过：用户数据和 Skill 联接均保留。'
}
finally {
    try { Remove-SmokeJunction -Path $ClaudeSkill } catch { Write-Warning $_.Exception.Message }
    try { Remove-SmokeJunction -Path $WindsurfSkill } catch { Write-Warning $_.Exception.Message }
    Remove-Item -LiteralPath $CanonicalSkill -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($marker in $Preserved) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
}
