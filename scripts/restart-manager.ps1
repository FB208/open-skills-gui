[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Path
)

$ErrorActionPreference = 'Stop'

$restartManagerSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class OpenSkillsRestartManager
{
    private const int ErrorMoreData = 234;
    private const int SessionKeyLength = 32;
    private const int RegistrationBatchSize = 256;

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    private enum RmAppType
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
        public RmUniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ApplicationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
        public RmAppType ApplicationType;
        public uint ApplicationStatus;
        public uint TerminalServicesSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    public sealed class ProcessInfo
    {
        public int Pid { get; set; }
        public string Name { get; set; }
        public string ApplicationName { get; set; }
        public string ServiceShortName { get; set; }
        public bool Restartable { get; set; }
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        IntPtr applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] RmProcessInfo[] affectedApplications,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint sessionHandle);

    public static ProcessInfo[] GetLockingProcesses(string[] fileNames)
    {
        uint sessionHandle;
        var sessionKey = new StringBuilder(SessionKeyLength + 1);
        int result = RmStartSession(out sessionHandle, 0, sessionKey);
        if (result != 0)
            throw new InvalidOperationException("Restart Manager session failed with code " + result + ".");

        try
        {
            for (var offset = 0; offset < fileNames.Length; offset += RegistrationBatchSize)
            {
                var count = Math.Min(RegistrationBatchSize, fileNames.Length - offset);
                var batch = new string[count];
                Array.Copy(fileNames, offset, batch, 0, count);
                result = RmRegisterResources(sessionHandle, (uint)count, batch, 0, IntPtr.Zero, 0, null);
                if (result != 0)
                    throw new InvalidOperationException("Restart Manager registration failed with code " + result + ".");
            }

            for (var attempt = 0; attempt < 3; attempt++)
            {
                uint needed;
                uint count = 0;
                uint rebootReasons = 0;
                result = RmGetList(sessionHandle, out needed, ref count, null, ref rebootReasons);
                if (result == 0)
                    return new ProcessInfo[0];
                if (result != ErrorMoreData)
                    throw new InvalidOperationException("Restart Manager query failed with code " + result + ".");

                var nativeProcesses = new RmProcessInfo[needed];
                count = needed;
                result = RmGetList(sessionHandle, out needed, ref count, nativeProcesses, ref rebootReasons);
                if (result == ErrorMoreData)
                    continue;
                if (result != 0)
                    throw new InvalidOperationException("Restart Manager query failed with code " + result + ".");

                var unique = new Dictionary<int, ProcessInfo>();
                for (var index = 0; index < count; index++)
                {
                    var item = nativeProcesses[index];
                    var name = item.ApplicationName;
                    try { name = Process.GetProcessById(item.Process.ProcessId).ProcessName; }
                    catch { }
                    unique[item.Process.ProcessId] = new ProcessInfo
                    {
                        Pid = item.Process.ProcessId,
                        Name = name,
                        ApplicationName = item.ApplicationName,
                        ServiceShortName = item.ServiceShortName,
                        Restartable = item.Restartable
                    };
                }
                var values = new ProcessInfo[unique.Count];
                unique.Values.CopyTo(values, 0);
                return values;
            }
            throw new InvalidOperationException("Restart Manager process list changed too frequently.");
        }
        finally
        {
            RmEndSession(sessionHandle);
        }
    }
}
'@

# 输出后端可稳定解析的单行 JSON 结果。
function Write-JsonResult {
    param([bool]$Ok, [object]$Data, [object]$ErrorData)

    $result = [ordered]@{ ok = $Ok }
    if ($Ok) { $result.data = $Data } else { $result.error = $ErrorData }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
}

# 逐层枚举目录，明确跳过目录联接和目录符号链接。
function Expand-RegisteredFiles {
    param([Parameter(Mandatory = $true)][string[]]$InputPaths)

    $files = New-Object 'Collections.Generic.List[string]'
    foreach ($inputPath in $InputPaths) {
        $resolved = [IO.Path]::GetFullPath($inputPath)
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        if (-not $item.PSIsContainer) {
            $files.Add($item.FullName)
            continue
        }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }

        $queue = New-Object 'Collections.Generic.Queue[string]'
        $queue.Enqueue($item.FullName)
        while ($queue.Count -gt 0) {
            $directory = $queue.Dequeue()
            foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                if ($child.PSIsContainer) {
                    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                        $queue.Enqueue($child.FullName)
                    }
                }
                else {
                    $files.Add($child.FullName)
                }
            }
        }
    }
    return @($files | Sort-Object -Unique)
}

try {
    Add-Type -TypeDefinition $restartManagerSource -Language CSharp
    $registeredFiles = @(Expand-RegisteredFiles -InputPaths $Path)
    if ($registeredFiles.Count -eq 0) {
        Write-JsonResult -Ok $true -Data ([ordered]@{ processes = @() }) -ErrorData $null
        exit 0
    }

    $processes = @([OpenSkillsRestartManager]::GetLockingProcesses([string[]]$registeredFiles) | ForEach-Object {
        [ordered]@{
            pid = $_.Pid
            name = $_.Name
            applicationName = $_.ApplicationName
            serviceShortName = $_.ServiceShortName
            restartable = $_.Restartable
        }
    })
    Write-JsonResult -Ok $true -Data ([ordered]@{ processes = $processes }) -ErrorData $null
    exit 0
}
catch {
    Write-JsonResult -Ok $false -Data $null -ErrorData ([ordered]@{
        code = 'RESTART_MANAGER_FAILED'
        message = $_.Exception.Message
    })
    exit 1
}
