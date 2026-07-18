[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$failed = $false
$files = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'scripts'), (Join-Path $ProjectRoot 'extensions') -Filter '*.ps1' -File -Recurse)

foreach ($file in $files) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if (-not $hasBom) {
        [Console]::Error.WriteLine("MISSING_UTF8_BOM $($file.FullName)")
        $failed = $true
    }

    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    foreach ($parseError in @($parseErrors)) {
        [Console]::Error.WriteLine("PARSE_ERROR $($file.FullName):$($parseError.Extent.StartLineNumber):$($parseError.Extent.StartColumnNumber) $($parseError.Message)")
        $failed = $true
    }
}

$installerScript = Join-Path $ProjectRoot 'installer\OpenSkillsGUI.iss'
$installerBytes = [IO.File]::ReadAllBytes($installerScript)
$installerHasBom = $installerBytes.Length -ge 3 -and $installerBytes[0] -eq 0xEF -and $installerBytes[1] -eq 0xBB -and $installerBytes[2] -eq 0xBF
if (-not $installerHasBom) {
    [Console]::Error.WriteLine("MISSING_UTF8_BOM $installerScript")
    $failed = $true
}

if ($failed) { exit 1 }
Write-Host "Validated $($files.Count) PowerShell files with Windows PowerShell parser and verified Inno UTF-8 BOM."
exit 0
