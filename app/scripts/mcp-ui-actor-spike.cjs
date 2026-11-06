const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const assert = require("node:assert/strict")
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const projectDir = "D:\\Uprojects\\ViteMCPTest"
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `ui-actor-spike-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `ui-actor-spike-history-${stamp}.jsonl`)

const widgetName = "MCPStatusWidget"
const widgetPath = `/Game/MCP/UI/${widgetName}`
const textBlockName = "MCPStatusText"
const actorName = "MCP_LiveCoding_Actor"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const captureEditorWindow = (outputPath) => {
	const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class McpWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$proc = Get-Process UE4Editor | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'UE4Editor window not found' }
$global:McpTargetPid = [uint32]$proc.Id
$global:McpMainHwnd = $proc.MainWindowHandle
$callback = {
  param($child, $lparam)
  [uint32]$windowPid = 0
  [McpWin32]::GetWindowThreadProcessId($child, [ref]$windowPid) | Out-Null
  if ($windowPid -eq $global:McpTargetPid) {
    $buffer = New-Object System.Text.StringBuilder 256
    [McpWin32]::GetWindowText($child, $buffer, 256) | Out-Null
    $title = $buffer.ToString()
    if ($title -eq 'Plugins' -or $title -eq 'GPU Visualizer') {
      [McpWin32]::PostMessage($child, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
  }
  return $true
}
[McpWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 800
$hwnd = $global:McpMainHwnd
[McpWin32]::ShowWindow($hwnd, 9) | Out-Null
[McpWin32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1200
$rect = New-Object McpWin32+RECT
[McpWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($env:MCP_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output "captured $width x $height"
`
	execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		env: { ...process.env, MCP_CAPTURE_PATH: outputPath },
		stdio: "inherit",
	})
}

const extractText = (result) => {
	const content = result && Array.isArray(result.content) ? result.content : []
	return content
		.filter((item) => item && item.type === "text")
		.map((item) => item.text || "")
		.join("\n")
}

const parseJson = (text) => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
		throw new Error(`Expected JSON, got: ${text.slice(0, 300)}`)
	}
}

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	])

const main = async () => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverEntry],
		cwd: repoRoot,
		stderr: "pipe",
		env: {
			...process.env,
			UEV_BIND_ADDRESS: "127.0.0.1",
			UEV_COMMAND_ADDRESS: "127.0.0.1",
			UEV_MULTICAST_TTL: "0",
			UEV_PROFILE: "supervised",
			UEV_AUDIT_LOG: auditPath,
			UEV_HISTORY_LOG: historyPath,
			UEV_SUPERVISOR_PIPE: "\\\\.\\pipe\\uev-supervisor",
		},
	})

	const client = new Client({ name: "ui-actor-spike", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const call = async (name, args = {}, timeoutMs = 180000, quiet = false) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		if (!quiet) {
			console.log(`--- ${name} ${JSON.stringify(args)} ---`)
			console.log(text.slice(0, 2600))
		}
		return { text, json: parseJson(text) }
	}

	const callText = async (name, args = {}, timeoutMs = 180000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 2600))
		return text
	}

	const pieStatus = async (quiet = true) => {
		const result = await call("manage_editor", { action: "is_pie_running" }, 30000, quiet)
		return Boolean(result.json.is_pie_running)
	}

	const waitForPie = async (running, timeoutMs = 30000) => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if ((await pieStatus()) === running) return true
			await delay(500)
		}
		return false
	}

	const ensurePieStopped = async () => {
		if (!(await pieStatus())) return
		console.log("[INFO] PIE is running; stopping it before widget authoring")
		await call("manage_editor", { action: "stop_pie", params: {} }, 60000, true)
		assert.equal(await waitForPie(false, 20000), true, "PIE did not stop")
	}

	const ensurePieRunning = async () => {
		if (await pieStatus()) return
		const started = await call("manage_editor", { action: "start_pie", params: {} }, 60000, true)
		assert.notEqual(started.json.success, false, started.text)
		assert.equal(await waitForPie(true, 30000), true, "PIE did not start")
	}

	const inspectTree = async () => {
		const result = await call("manage_widget", {
			action: "inspect_tree",
			params: { widget_blueprint: widgetPath },
		}, 60000, true)
		return result.json
	}

	let actorSpawned = false

	try {
		await ensurePieStopped()

		const widget = await call("manage_widget", {
			action: "create_widget_blueprint",
			params: { widget_name: widgetName, path: "/Game/MCP/UI" },
		})
		if (widget.json.success !== true) {
			assert.equal(widget.json.reason, "asset_already_exists", widget.text)
			assert.notEqual(widget.json.persisted, false, `Widget exists but is not persisted: ${widget.text}`)
			console.log(`[PASS] reusing persisted widget ${widgetPath}`)
		} else {
			console.log(`[PASS] created widget ${widget.json.asset_path || widgetPath}`)
		}

		const treeBefore = await inspectTree()
		assert.equal(treeBefore.success, true, JSON.stringify(treeBefore))
		const hasTextBlock = (treeBefore.widgets || []).some((entry) => entry.name === textBlockName)
		if (!hasTextBlock) {
			const textBlock = await call("manage_widget", {
				action: "add_text_block",
				params: {
					widget_blueprint: widgetPath,
					text_block_name: textBlockName,
					text: "MCP Live Coding + UI OK",
					font_size: 28,
					color: [0.1, 0.8, 1.0, 1.0],
					position: [40, 40],
					size: [640, 120],
				},
			})
			assert.equal(textBlock.json.success, true, textBlock.text)
			console.log(`[PASS] added ${textBlockName}`)
		} else {
			console.log(`[PASS] ${textBlockName} already present`)
		}

		const treeAfter = await inspectTree()
		assert.equal(treeAfter.success, true, JSON.stringify(treeAfter))
		assert.equal(
			(treeAfter.widgets || []).some((entry) => entry.name === textBlockName),
			true,
			`Widget tree does not contain ${textBlockName}: ${JSON.stringify(treeAfter.widgets)}`,
		)
		console.log("[PASS] widget asset is loadable and its tree is persisted")

		const spawn = await call("manage_actor", {
			action: "spawn",
			params: {
				type: "MCPLiveCodingTestActor",
				name: actorName,
				location: { x: 300, y: 0, z: 100 },
			},
		})
		if (spawn.json.success !== true) {
			console.log("[WARN] short actor class name failed; retrying with /Script class path")
			const fallback = await call("manage_actor", {
				action: "spawn",
				params: {
					type: "/Script/ViteMCPTest.MCPLiveCodingTestActor",
					name: actorName,
					location: { x: 300, y: 0, z: 100 },
				},
			})
			assert.equal(fallback.json.success, true, fallback.text)
			actorSpawned = true
		} else {
			actorSpawned = true
		}
		console.log("[PASS] spawned Live-Coded C++ actor through manage_actor")

		const color = await callText("manage_editor", {
			action: "run_python",
			params: {
				code: [
					"import unreal",
					"actors = [a for a in unreal.EditorLevelLibrary.get_all_level_actors() if a.get_actor_label() == 'MCP_LiveCoding_Actor']",
					"actor = actors[0]",
					"actor.set_mcp_test_color(unreal.LinearColor(1.0, 0.25, 0.05, 1.0))",
					"print('color_set={0}'.format(actor.get_name()))",
				].join("\n"),
			},
		})
		assert.match(color, /color_set=/)
		console.log("[PASS] called the Live-Coded UCLASS method")

		await ensurePieRunning()

		let viewport = null
		for (let attempt = 1; attempt <= 6; attempt += 1) {
			viewport = await call("manage_widget", {
				action: "add_to_viewport",
				params: {
					widget_blueprint: widgetPath,
					z_order: 100,
					start_pie_if_needed: false,
					timeout_seconds: 15,
				},
			}, 60000)
			if (viewport.json.success === true) break
			assert.notEqual(viewport.json.retry_recommended, true, viewport.text)
			await delay(1000)
		}
		assert.equal(viewport.json.success, true, viewport.text)
		console.log("[PASS] widget added to the PIE viewport")
		console.log(`[INFO] retained=${viewport.json.retained} in_viewport=${viewport.json.in_viewport}`)

		const widgetDiag = await callText("manage_editor", {
			action: "run_python",
			params: {
				code: [
					"import unreal",
					"count = unreal.UEVLibrary.get_retained_object_count()",
					"widgets = [unreal.UEVLibrary.get_retained_object(i) for i in range(count)]",
					"print('retained_count={0}'.format(count))",
					"print('in_viewport={0}'.format([w.is_in_viewport() for w in widgets]))",
				].join("\n"),
			},
		})
		assert.match(widgetDiag, /in_viewport=\[True\]/)

		await delay(1500)

		const uiShot = await callText("manage_editor", { action: "screenshot", params: {} })
		const uiShotPath = uiShot
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.toLowerCase().endsWith(".png"))
		assert.ok(uiShotPath, `Screenshot did not return a png path: ${uiShot}`)
		const screenshotDeadline = Date.now() + 20000
		while (Date.now() < screenshotDeadline && !fs.existsSync(uiShotPath)) {
			await delay(500)
		}
		assert.equal(fs.existsSync(uiShotPath), true, `Screenshot was not written: ${uiShotPath}`)
		assert.ok(fs.statSync(uiShotPath).size > 0, `Screenshot is empty: ${uiShotPath}`)
		console.log(`[PASS] UI/actor screenshot ${uiShotPath} (${fs.statSync(uiShotPath).size} bytes)`)

		const windowShotPath = path.resolve(repoRoot, "..", "captures", "ui-actor-spike-window.png")
		captureEditorWindow(windowShotPath)
		assert.equal(fs.existsSync(windowShotPath), true, `Editor window capture was not written: ${windowShotPath}`)
		assert.ok(fs.statSync(windowShotPath).size > 0, `Editor window capture is empty: ${windowShotPath}`)
		console.log(`[PASS] editor window capture ${windowShotPath} (${fs.statSync(windowShotPath).size} bytes)`)

		const profile = await call("manage_profile", {
			action: "capture_stats",
			params: { stats: ["stat unit"], durationMs: 500 },
		})
		assert.equal(profile.json.success, true, profile.text)
		console.log(`[PASS] UI/actor profiling capture (${profile.json.lineCount} lines)`)

		const frame = await call("manage_profile", { action: "capture_frame", params: { waitMs: 1200 } })
		assert.equal(frame.json.success, true, frame.text)
		console.log(`[PASS] UI/actor GPU frame capture (gpuTimeMs=${frame.json.gpuTimeMs})`)
	} finally {
		try {
			if (await pieStatus()) {
				await call("manage_editor", { action: "stop_pie", params: {} }, 60000, true)
				if (!(await waitForPie(false, 20000))) console.error("[WARN] PIE did not stop during cleanup")
			}
			console.log("[INFO] PIE stopped")
		} catch (error) {
			console.error(`[WARN] PIE cleanup failed: ${error.message}`)
		}

		try {
			const released = await call("manage_widget", { action: "release_viewport_widgets", params: {} }, 30000, true)
			console.log(`[INFO] released retained widgets=${released.json.released ?? 0}`)
		} catch (error) {
			console.error(`[WARN] widget release failed: ${error.message}`)
		}

		try {
			if (actorSpawned) {
				await call("manage_actor", { action: "delete", params: { name: actorName } }, 60000, true)
				console.log("[INFO] actor deleted")
			}
		} catch (error) {
			console.error(`[WARN] actor cleanup failed: ${error.message}`)
		}

		try {
			const save = await callText("manage_editor", {
				action: "run_python",
				params: {
					code: [
						"import unreal",
						"saved = unreal.EditorLevelLibrary.save_current_level()",
						'print("level_saved={0}".format(saved))',
					].join("\n"),
				},
			})
			if (!/level_saved=True/i.test(save)) console.error("[WARN] level was not saved during cleanup")
		} catch (error) {
			console.error(`[WARN] level save failed: ${error.message}`)
		}

		await client.close()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
