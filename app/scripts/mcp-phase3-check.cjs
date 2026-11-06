const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const assert = require("node:assert/strict")
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `phase3-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `phase3-history-${stamp}.jsonl`)

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
		if (start >= 0 && end > start) {
			return JSON.parse(text.slice(start, end + 1))
		}
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

	const client = new Client({ name: "phase3-check", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const call = async (name, args = {}, timeoutMs = 60000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 1200))
		return { text, json: parseJson(text) }
	}

	const callText = async (name, args = {}, timeoutMs = 60000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 1200))
		return text
	}

	const screen = await call("manage_vite", { action: "cvar_get", params: { name: "r.ScreenPercentage" } })
	const originalScreen = screen.json.current
	assert.equal(typeof originalScreen, "number")
	console.log(`[PASS] original r.ScreenPercentage=${originalScreen}`)

	await call("manage_vite", { action: "cvar_set", params: { name: "r.ScreenPercentage", value: 90 } })
	const setScreen = await call("manage_vite", { action: "cvar_get", params: { name: "r.ScreenPercentage" } })
	assert.equal(setScreen.json.current, 90)
	console.log("[PASS] cvar_set changed r.ScreenPercentage to 90")

	const cvarHistory = await call("manage_history", {
		action: "list",
		params: { tool: "manage_vite", action: "cvar_set", limit: 10 },
	})
	const cvarEntry = cvarHistory.json.entries.find(
		(entry) => entry.forward && entry.forward.params && entry.forward.params.value === 90,
	)
	assert.ok(cvarEntry, "cvar_set history entry not found")
	assert.equal(cvarEntry.undo, "semantic")
	console.log(`[PASS] semantic history entry ${cvarEntry.id}`)

	await call("manage_history", { action: "undo", params: { targetId: cvarEntry.id } })
	const undoneScreen = await call("manage_vite", { action: "cvar_get", params: { name: "r.ScreenPercentage" } })
	assert.equal(undoneScreen.json.current, originalScreen)
	const undoneEntry = await call("manage_history", { action: "get", params: { id: cvarEntry.id } })
	assert.equal(undoneEntry.json.entry.undone, true)
	console.log("[PASS] semantic undo restored the cvar")

	await call("manage_history", { action: "redo", params: { targetId: cvarEntry.id } })
	const redoneScreen = await call("manage_vite", { action: "cvar_get", params: { name: "r.ScreenPercentage" } })
	assert.equal(redoneScreen.json.current, 90)
	console.log("[PASS] semantic redo reapplied the cvar")

	await call("manage_vite", { action: "cvar_set", params: { name: "r.ScreenPercentage", value: originalScreen } })

	const presetNames = [
		"r.RTXGI.DDGI",
		"r.RayTracing",
		"r.HBAO.Enable",
		"r.Vite.SMAA.Mode",
		"r.ScreenPercentage",
		"r.VolumetricFog",
	]
	const beforePreset = {}
	for (const name of presetNames) {
		const reading = await call("manage_vite", { action: "cvar_get", params: { name } })
		beforePreset[name] = reading.json.current
	}

	await call("manage_vite", { action: "preset_apply", params: { name: "performance" } })
	const presetDdgi = await call("manage_vite", { action: "cvar_get", params: { name: "r.RTXGI.DDGI" } })
	assert.equal(presetDdgi.json.current, 0)
	console.log("[PASS] performance preset applied")

	const presetHistory = await call("manage_history", {
		action: "list",
		params: { tool: "manage_vite", action: "preset_apply", limit: 10 },
	})
	const presetEntry = presetHistory.json.entries.find(
		(entry) =>
			entry.forward &&
			entry.forward.params &&
			entry.forward.params.values &&
			entry.forward.params.values["r.RTXGI.DDGI"] === 0,
	)
	assert.ok(presetEntry, "preset_apply history entry not found")
	assert.equal(presetEntry.undo, "semantic")

	await call("manage_history", { action: "undo", params: { targetId: presetEntry.id } })
	const presetUndone = await call("manage_vite", { action: "cvar_get", params: { name: "r.RTXGI.DDGI" } })
	assert.equal(presetUndone.json.current, beforePreset["r.RTXGI.DDGI"])
	console.log("[PASS] preset undo restored prior values")

	await call("manage_history", { action: "redo", params: { targetId: presetEntry.id } })
	const presetRedone = await call("manage_vite", { action: "cvar_get", params: { name: "r.RTXGI.DDGI" } })
	assert.equal(presetRedone.json.current, 0)
	await call("manage_history", { action: "undo", params: { targetId: presetEntry.id } })
	const presetRestored = await call("manage_vite", { action: "cvar_get", params: { name: "r.RTXGI.DDGI" } })
	assert.equal(presetRestored.json.current, beforePreset["r.RTXGI.DDGI"])
	console.log("[PASS] preset redo and second undo")

	await call("manage_vite", { action: "console", params: { command: "stat unit" } })
	console.log("[PASS] allowlisted console command")

	const screenshot = await callText("manage_editor", { action: "screenshot", params: {} })
	assert.match(screenshot.toLowerCase(), /\.png/)
	await new Promise((resolve) => setTimeout(resolve, 700))
	console.log(`[PASS] Vite screenshot ${screenshot}${fs.existsSync(screenshot) ? " (file written)" : " (still writing)"}`)

	let ddgiVolumes = (await call("manage_ddgi", { action: "list_volumes" })).json.volumes ?? []
	if (ddgiVolumes.length === 0) {
		const spawn = await call("manage_actor", {
			action: "spawn",
			params: { type: "DDGIVolume", name: "MCP_DDGI_Test", location: { x: 0, y: 0, z: 0 } },
		})
		assert.equal(spawn.json.success, true, `DDGIVolume spawn failed: ${spawn.text}`)
		ddgiVolumes = (await call("manage_ddgi", { action: "list_volumes" })).json.volumes ?? []
		assert.ok(ddgiVolumes.length > 0, "spawned DDGIVolume was not listed")
	}

	const ddgiStats = await call("manage_ddgi", { action: "stats" })
	assert.equal(ddgiStats.json.success, true)
	const ddgiValidation = await call("manage_ddgi", { action: "validate" })
	assert.equal(ddgiValidation.json.success, true)
	if (ddgiVolumes.length > 0) {
		const volume = ddgiVolumes[0]
		const volumeName = volume.label || volume.actor_name
		const inspected = await call("manage_ddgi", { action: "inspect_volume", params: { name: volumeName } })
		assert.equal(inspected.json.success, true)
		assert.ok(inspected.json.volume)
		console.log(`[PASS] DDGI inspect ${volumeName}`)
	} else {
		assert.ok(
			ddgiValidation.json.issues.some((issue) => issue.code === "no_volumes"),
			"DDGI validation did not report the empty level",
		)
		console.log("[PASS] DDGI validation reports no volumes")
	}
	console.log("[PASS] DDGI list/stats/validate")

	if (ddgiVolumes.some((volume) => volume.label === "MCP_DDGI_Test")) {
		await call("manage_actor", { action: "delete", params: { name: "MCP_DDGI_Test" } })
	}

	const cleanup = await callText("manage_editor", {
		action: "run_python",
		params: {
			code: [
				"import unreal",
				"saved = unreal.EditorLevelLibrary.save_current_level()",
				'print("level_saved={0}".format(saved))',
			].join("\n"),
		},
	})
	assert.match(cleanup, /level_saved=True/i)
	console.log("[PASS] test level saved clean")

	const capture = await call("manage_profile", {
		action: "capture_stats",
		params: { stats: ["stat unit"], durationMs: 500 },
	})
	assert.equal(capture.json.success, true)
	assert.ok(capture.json.logPath)
	assert.ok(capture.json.artifact || capture.json.lineCount > 0, "capture_stats produced no artifact or lines")
	console.log(
		`[PASS] profile capture_stats (${capture.json.lineCount} matching lines; artifact=${capture.json.artifact ?? "none"})`,
	)

	const budget = await call("manage_profile", {
		action: "budget_check",
		params: { frameTimeMs: 16, targetFps: 60 },
	})
	assert.equal(budget.json.meetsBudget, true)
	const comparison = await call("manage_profile", {
		action: "compare",
		params: { beforeFrameTimeMs: 20, afterFrameTimeMs: 16, targetFps: 60 },
	})
	assert.equal(comparison.json.improved, true)
	assert.equal(comparison.json.meetsBudget, true)
	console.log("[PASS] profile compare and budget_check")

	const frame = await call("manage_profile", { action: "capture_frame", params: { waitMs: 1200 } })
	assert.equal(frame.json.success, true)
	assert.ok(frame.json.gpuTimeMs === undefined || typeof frame.json.gpuTimeMs === "number")
	console.log(
		`[PASS] profile capture_frame (profilegpu; gpuTimeMs=${frame.json.gpuTimeMs ?? "not parsed"}; warnings=${frame.json.warnings.length})`,
	)

	await client.close()
	console.log("[PASS] Phase 3 controlled writes, DDGI, and profiling live check")
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error))
	process.exit(1)
})
