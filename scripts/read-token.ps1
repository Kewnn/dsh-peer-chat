# Read the `dsh web: http://...?token=...` line out of another DSH process's console buffer.
# Companion helper for dsh-peer-chat's `tokenCommand` config. Windows only; ASCII only on purpose
# (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File read-token.ps1 -Port 3090
#   powershell -NoProfile -ExecutionPolicy Bypass -File read-token.ps1 -TargetPid 1234
#
# Output: PID=<pid> / SOURCE=console:<pid> / TOKEN=<token>
# dsh-peer-chat parses the last `token=...` from stdout, so extra lines are harmless.
#
# Caveats:
#   - The console must still own the buffer: a window that was closed (process keeps running
#     headless) has nothing to read, and a process launched without a console cannot be attached.
#   - The token line must still be inside the scrollback. A very chatty console may have scrolled it away.
#   - Prefer `start-logged.cmd` (tee to <DSH_HOME>\web-console.log) when you control the launcher:
#     a file survives restarts and scrolling, a console buffer does not.
param(
  [int]$TargetPid = 0,
  [int]$Port = 0
)

# After AttachConsole the process's standard handles are re-pointed at that console, so anything
# written afterwards (including [Console]::Out) disappears from the pipe exec() gave us.
# Capture the ORIGINAL stdout stream up front and write through it for the rest of the run.
$pipe = [Console]::OpenStandardOutput()
function Emit([string[]]$lines) {
  $bytes = [Text.Encoding]::UTF8.GetBytes((($lines -join "`n") + "`n"))
  $pipe.Write($bytes, 0, $bytes.Length)
  $pipe.Flush()
}

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PeerConsole
{
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(int pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD coord, out uint read);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);

    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 1;
    const uint FILE_SHARE_WRITE = 2;
    const uint OPEN_EXISTING = 3;

    public static string Scoop(int pid, out string note)
    {
        var log = new StringBuilder();
        FreeConsole();
        if (!AttachConsole(pid)) { note = "ATTACH_FAIL:" + Marshal.GetLastWin32Error(); return ""; }
        try
        {
            IntPtr h = CreateFileW("CONOUT$", GENERIC_READ | FILE_SHARE_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (h == new IntPtr(-1)) { note = "CONOUT_FAIL:" + Marshal.GetLastWin32Error(); return ""; }
            try
            {
                CONSOLE_SCREEN_BUFFER_INFO info;
                if (!GetConsoleScreenBufferInfo(h, out info)) { note = "INFO_FAIL:" + Marshal.GetLastWin32Error(); return ""; }
                for (int y = 0; y < info.dwSize.Y; y++)
                {
                    var line = new StringBuilder(info.dwSize.X + 1);
                    uint got;
                    ReadConsoleOutputCharacterW(h, line, (uint)info.dwSize.X, new COORD { X = 0, Y = (short)y }, out got);
                    log.Append(line.ToString().TrimEnd()).Append('\n');
                }
                note = "";
                return log.ToString();
            }
            finally { CloseHandle(h); }
        }
        finally { FreeConsole(); }
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null

if ($TargetPid -eq 0) {
  if ($Port -eq 0) { Emit @('NO_TARGET'); exit 2 }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { Emit @("NO_LISTENER port=$Port"); exit 3 }
  $TargetPid = [int]$conn.OwningProcess
}

$note = ''
$text = [PeerConsole]::Scoop($TargetPid, [ref]$note)
if ($note -ne '') { Emit @("READ_FAIL $note pid=$TargetPid"); exit 4 }

$line = ($text -split "`n") | Where-Object { $_ -match 'dsh web:\s*http://[^\s]*[?&]token=[A-Za-z0-9_-]{20,}' } | Select-Object -Last 1
if (-not $line) { Emit @("NO_TOKEN_LINE pid=$TargetPid"); exit 5 }
if ($line -notmatch 'token=([A-Za-z0-9_-]{20,})') { Emit @('NO_TOKEN_MATCH'); exit 6 }

Emit @("PID=$TargetPid", "SOURCE=console:$TargetPid", "TOKEN=$($Matches[1])")
exit 0
