export const ELEVATED_INPUT_HELPER_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$PipeName,
  [Parameter(Mandatory=$true)][string]$GameProcessName
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CyreneGameBotInput {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);

  public static void EnablePerMonitorV2() {
    try {
      if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
    } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
}
'@

[CyreneGameBotInput]::EnablePerMonitorV2()

function Activate-GameWindow {
  $game = Get-Process -Name $GameProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($null -ne $game) {
    [void][CyreneGameBotInput]::ShowWindow($game.MainWindowHandle, 9)
    [void][CyreneGameBotInput]::SetForegroundWindow($game.MainWindowHandle)
  }
  Start-Sleep -Milliseconds 120
}

function Get-VirtualKey([string]$name) {
  switch ($name.ToLowerInvariant()) {
    'escape' { return 27 }
    'esc' { return 27 }
    'enter' { return 13 }
    'return' { return 13 }
    'space' { return 32 }
    'tab' { return 9 }
    'v' { return 86 }
    default { throw "Unsupported key: $name" }
  }
}

$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(30000)
$reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8)
$writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$writer.WriteLine('{"ready":true}')

try {
  while (($line = $reader.ReadLine()) -ne $null) {
    $request = $null
    try {
      $request = $line | ConvertFrom-Json
      if ($request.op -eq 'shutdown') { break }
      Activate-GameWindow
      switch ($request.op) {
        'click' {
          if (-not [CyreneGameBotInput]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'SetCursorPos failed' }
          Start-Sleep -Milliseconds 60
          [CyreneGameBotInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 50
          [CyreneGameBotInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        }
        'drag' {
          if (-not [CyreneGameBotInput]::SetCursorPos([int]$request.startX, [int]$request.startY)) { throw 'SetCursorPos failed' }
          Start-Sleep -Milliseconds 100
          [CyreneGameBotInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 180
          for ($step = 1; $step -le 12; $step++) {
            $x = [int][Math]::Round([double]$request.startX + ([double]$request.endX - [double]$request.startX) * $step / 12)
            $y = [int][Math]::Round([double]$request.startY + ([double]$request.endY - [double]$request.startY) * $step / 12)
            [void][CyreneGameBotInput]::SetCursorPos($x, $y)
            Start-Sleep -Milliseconds 28
          }
          Start-Sleep -Milliseconds 160
          [CyreneGameBotInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        }
        'key' {
          $key = [byte](Get-VirtualKey ([string]$request.combo))
          [CyreneGameBotInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 50
          [CyreneGameBotInput]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
        }
        default { throw "Unsupported operation: $($request.op)" }
      }
      $writer.WriteLine((@{ id = $request.id; ok = $true } | ConvertTo-Json -Compress))
    } catch {
      $writer.WriteLine((@{ id = $request.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
  }
} finally {
  $writer.Dispose()
  $reader.Dispose()
  $pipe.Dispose()
}
`;
