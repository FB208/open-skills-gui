[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Utf8NoBom = New-Object Text.UTF8Encoding($false, $true)
$Utf8Bom = New-Object Text.UTF8Encoding($true, $true)

# 将指定文本文件规范化为带 BOM 的 UTF-8。
function Convert-FileEncoding {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
    $text = $Utf8NoBom.GetString($bytes, $offset, $bytes.Length - $offset)
    [IO.File]::WriteAllText($Path, $text, $Utf8Bom)
}

$files = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'scripts'), (Join-Path $ProjectRoot 'extensions') -Filter '*.ps1' -File -Recurse)
foreach ($file in $files) { Convert-FileEncoding -Path $file.FullName }
Write-Host "UTF-8 BOM ensured for $($files.Count) PowerShell files."
