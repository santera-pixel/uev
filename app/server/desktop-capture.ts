import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { installRootFolder } from "./identity.js"

const execFileAsync = promisify(execFile)

export interface DesktopCaptureResult {
	success: boolean
	path?: string
	width?: number
	height?: number
	error?: string
}

const captureScript = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class McpCaptureWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$targetTitle = $env:MCP_CAPTURE_TITLE
$target = [IntPtr]::Zero
if ($targetTitle) {
    $global:McpCaptureTitle = $targetTitle
    $global:McpCaptureFound = [IntPtr]::Zero
    $callback = {
        param($hwnd, $lparam)
        if ([McpCaptureWin32]::IsWindowVisible($hwnd)) {
            $builder = New-Object System.Text.StringBuilder 512
            [McpCaptureWin32]::GetWindowText($hwnd, $builder, 512) | Out-Null
            $title = $builder.ToString()
            if ($title.IndexOf($global:McpCaptureTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $global:McpCaptureFound = $hwnd
                return $false
            }
        }
        return $true
    }
    [McpCaptureWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    $target = $global:McpCaptureFound
}
if ($target -eq [IntPtr]::Zero) {
    $process = Get-Process UE4Editor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($process) { $target = $process.MainWindowHandle }
}
if ($target -eq [IntPtr]::Zero) { throw "Target window not found." }
$topmost = 0x0002 -bor 0x0001 -bor 0x0040
[McpCaptureWin32]::ShowWindow($target, 9) | Out-Null
[McpCaptureWin32]::SetWindowPos($target, [IntPtr](-1), 0, 0, 0, 0, $topmost) | Out-Null
[McpCaptureWin32]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 900
$rect = New-Object McpCaptureWin32+RECT
[McpCaptureWin32]::GetWindowRect($target, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "Target window has an invalid size." }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($env:MCP_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[McpCaptureWin32]::SetWindowPos($target, [IntPtr](-2), 0, 0, 0, 0, $topmost) | Out-Null
Write-Output "captured=$($width)x$($height)"
`

const macCaptureScript = `
set targetTitle to system attribute "MCP_CAPTURE_TITLE"
tell application "System Events"
	set targetProcess to first application process whose frontmost is true
	if targetTitle is not "" then
		repeat with candidate in application processes
			if name of candidate contains targetTitle then
				set targetProcess to candidate
				exit repeat
			end if
		end repeat
	end if
	set targetWindow to front window of targetProcess
	set {originX, originY} to position of targetWindow
	set {windowWidth, windowHeight} to size of targetWindow
		return (originX as text) & "," & (originY as text) & "," & (windowWidth as text) & "," & (windowHeight as text)
end tell
`

const linuxCaptureScript = `
set -eu
title="\${MCP_CAPTURE_TITLE:-UE4Editor}"
out="$MCP_CAPTURE_PATH"
if command -v xdotool >/dev/null 2>&1; then
  window_id=$(xdotool search --name "$title" 2>/dev/null | head -n 1 || true)
  if [ -n "$window_id" ]; then
    if command -v import >/dev/null 2>&1; then
      import -window "$window_id" "$out"
      if command -v identify >/dev/null 2>&1; then identify -format 'captured=%wx%h' "$out"; fi
      exit 0
    fi
    if command -v gnome-screenshot >/dev/null 2>&1; then
      gnome-screenshot -w -f "$out"
      if command -v identify >/dev/null 2>&1; then identify -format 'captured=%wx%h' "$out"; fi
      exit 0
    fi
  fi
fi
if command -v gnome-screenshot >/dev/null 2>&1; then
  gnome-screenshot -f "$out"
elif command -v scrot >/dev/null 2>&1; then
  scrot "$out"
elif command -v import >/dev/null 2>&1; then
  import -window root "$out"
else
  echo "No supported screen capture command (xdotool/import, gnome-screenshot, or scrot)." >&2
  exit 1
fi
if command -v identify >/dev/null 2>&1; then
  identify -format 'captured=%wx%h' "$out"
fi
`

export async function captureWindow(options: { windowTitle?: string } = {}): Promise<DesktopCaptureResult> {
	const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")
	const outputDirectory = path.join(localAppData, installRootFolder, "captures")
	const outputPath = path.join(outputDirectory, `MCP_UI_${Date.now()}.png`)

	try {
		fs.mkdirSync(outputDirectory, { recursive: true })

		if (process.platform === "win32") {
			const { stdout } = await execFileAsync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", captureScript],
				{
					env: {
						...process.env,
						MCP_CAPTURE_TITLE: options.windowTitle ?? "",
						MCP_CAPTURE_PATH: outputPath,
					},
					maxBuffer: 1024 * 1024,
					timeout: 30000,
					windowsHide: true,
				},
			)
			const match = /captured=(\d+)x(\d+)/.exec(stdout)
			if (!match) {
				return { success: false, error: `Unexpected capture output: ${stdout.trim()}` }
			}
			return {
				success: true,
				path: outputPath,
				width: Number(match[1]),
				height: Number(match[2]),
			}
		}

		if (process.platform === "darwin") {
			const { stdout: bounds } = await execFileAsync(
				"osascript",
				["-e", macCaptureScript],
				{
					env: { ...process.env, MCP_CAPTURE_TITLE: options.windowTitle ?? "" },
					timeout: 30000,
				},
			)
			const match = /^\s*(-?\d+),(-?\d+),(\d+),(\d+)\s*$/.exec(bounds.trim())
			if (!match) {
				return { success: false, error: `Unexpected window bounds: ${bounds.trim()}` }
			}
			await execFileAsync(
				"screencapture",
				["-x", "-R", `${match[1]},${match[2]},${match[3]},${match[4]}`, outputPath],
				{ timeout: 30000 },
			)
			return {
				success: true,
				path: outputPath,
				width: Number(match[3]),
				height: Number(match[4]),
			}
		}

		if (process.platform === "linux") {
			const { stdout } = await execFileAsync("sh", ["-c", linuxCaptureScript], {
				env: {
					...process.env,
					MCP_CAPTURE_TITLE: options.windowTitle ?? "UE4Editor",
					MCP_CAPTURE_PATH: outputPath,
				},
				timeout: 30000,
			})
			const match = /captured=(\d+)x(\d+)/.exec(stdout)
			return {
				success: true,
				path: outputPath,
				width: match ? Number(match[1]) : undefined,
				height: match ? Number(match[2]) : undefined,
			}
		}

		return { success: false, error: `Desktop capture is not implemented on ${process.platform}.` }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
