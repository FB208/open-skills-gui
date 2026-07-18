[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$MinimumNodeVersion = [version]'22.20.0'
$DataRoot = Join-Path $env:LOCALAPPDATA 'OpenSkillsGUI'
$AppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PrivateNode = Join-Path $DataRoot 'runtime\node\node.exe'
$BackendEntry = Join-Path $PSScriptRoot 'backend.cjs'

# 检查指定 Node 可执行文件是否满足最低版本要求。
function Test-NodeRuntime {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    try {
        $rawVersion = (& $Path --version 2>$null | Select-Object -First 1)
        return ([version]($rawVersion.Trim().TrimStart('v'))) -ge $MinimumNodeVersion
    }
    catch {
        return $false
    }
}

# 优先选择私有 Node，缺失时再查找合格的系统 Node。
function Find-NodeRuntime {
    if (Test-NodeRuntime -Path $PrivateNode) {
        return $PrivateNode
    }

    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $systemNode -and (Test-NodeRuntime -Path $systemNode.Source)) {
        return $systemNode.Source
    }

    throw 'Node.js 22.20.0 or newer is required.'
}

# 从标准输入读取一份完整且有效的 Neutralino 扩展连接信息。
function Read-NeutralinoConnectionJson {
    $builder = New-Object Text.StringBuilder
    $started = $false
    $depth = 0
    $insideString = $false
    $escaped = $false

    while ($true) {
        $value = [Console]::In.Read()
        if ($value -lt 0) {
            throw 'Neutralino connection data ended before one JSON object was received.'
        }

        $character = [char]$value
        if (-not $started) {
            if ([char]::IsWhiteSpace($character)) {
                continue
            }
            if ($character -ne '{') {
                throw 'Neutralino connection data must start with a JSON object.'
            }
            $started = $true
            $depth = 1
            [void]$builder.Append($character)
            continue
        }

        [void]$builder.Append($character)
        if ($insideString) {
            if ($escaped) {
                $escaped = $false
            }
            elseif ($character -eq '\') {
                $escaped = $true
            }
            elseif ($character -eq '"') {
                $insideString = $false
            }
            continue
        }

        if ($character -eq '"') {
            $insideString = $true
        }
        elseif ($character -eq '{' -or $character -eq '[') {
            $depth++
        }
        elseif ($character -eq '}' -or $character -eq ']') {
            $depth--
            if ($depth -eq 0) {
                $json = $builder.ToString()
                $parsed = $json | ConvertFrom-Json
                if ($null -eq $parsed.nlPort -or $null -eq $parsed.nlToken -or $null -eq $parsed.nlConnectToken -or $null -eq $parsed.nlExtensionId) {
                    throw 'Neutralino connection data is missing required fields.'
                }
                return $json
            }
        }

        if ($depth -lt 0) {
            throw 'Neutralino connection data contains unbalanced brackets.'
        }
    }
}

try {
    if (-not (Test-Path -LiteralPath $BackendEntry -PathType Leaf)) {
        throw "Backend bundle was not found: $BackendEntry"
    }

    $nodePath = Find-NodeRuntime
    $connectionPayload = Read-NeutralinoConnectionJson

    $env:OPEN_SKILLS_APP_ROOT = $AppRoot
    $env:DISABLE_TELEMETRY = '1'
    $env:DO_NOT_TRACK = '1'
    $env:NO_UPDATE_NOTIFIER = '1'
    $env:npm_config_update_notifier = 'false'
    $env:npm_config_fund = 'false'
    $env:npm_config_audit = 'false'
    $env:npm_config_cache = Join-Path $DataRoot 'cache\npm'

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = '"' + $BackendEntry.Replace('"', '\"') + '"'
    $startInfo.WorkingDirectory = $AppRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.CreateNoWindow = $true

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'Unable to start backend process.'
    }

    $process.StandardInput.Write($connectionPayload)
    $process.StandardInput.Close()
    $process.WaitForExit()
    exit $process.ExitCode
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
