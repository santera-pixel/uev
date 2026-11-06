const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const assert = require("node:assert/strict")
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `phase4-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `phase4-history-${stamp}.jsonl`)

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

	const client = new Client({ name: "phase4-check", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const call = async (name, args = {}, timeoutMs = 120000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 1400))
		return { text, json: parseJson(text) }
	}

	const callText = async (name, args = {}, timeoutMs = 120000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 1400))
		return text
	}

	const volumeLabel = "MCP_DDGI_Phase4"
	const updatedLabel = "MCP_DDGI_Phase4_Updated"
	let spawned = false

	try {
		const audit = await call("manage_build", { action: "audit" }, 60000)
		assert.equal(audit.json.success, true)
		assert.equal(audit.json.engineSourceReadOnlyPolicy, true)
		assert.equal(audit.json.buildExecution, "deferred")
		assert.equal(audit.json.checks.projectFile, true)
		assert.equal(audit.json.checks.viteSetup, true)
		assert.equal(audit.json.checks.buildBat, true)
		assert.equal(audit.json.checks.runUat, true)
		assert.equal(audit.json.checks.editorCmd, true)
		assert.equal(audit.json.ok, true)
		console.log(
			`[PASS] build audit (engine=${audit.json.environment.engineVersion}, buildId=${audit.json.environment.buildId ?? "n/a"}, warnings=${audit.json.warnings.length})`,
		)

		const buildPlan = await call("manage_build", {
			action: "plan",
			params: { action: "build_editor" },
		})
		assert.equal(buildPlan.json.success, true)
		assert.equal(buildPlan.json.blocked, true)
		assert.equal(buildPlan.json.requiresEditorClosed, true)
		assert.match(buildPlan.json.command, /Build\.bat/i)
		assert.match(buildPlan.json.command, /Editor/i)
		console.log("[PASS] build editor plan is generated and correctly blocked")

		const ddcPlan = await call("manage_build", {
			action: "plan",
			params: { action: "ddc_fill" },
		})
		assert.equal(ddcPlan.json.commandlet, true)
		assert.match(ddcPlan.json.command, /UE4Editor-Cmd\.exe/i)
		assert.match(ddcPlan.json.command, /DerivedDataCache/i)
		console.log("[PASS] DDC commandlet plan is isolated in UnrealEditor-Cmd")

		const setupPlan = await call("manage_build", {
			action: "plan",
			params: { action: "vite_setup" },
		})
		assert.equal(setupPlan.json.blocked, true)
		assert.match(setupPlan.json.blockedReason, /Engine source is read-only/i)
		console.log("[PASS] ViteSetup plan is blocked by the engine read-only policy")

		const artifacts = await call("manage_profile", {
			action: "list_artifacts",
			params: { extension: ".ue4stats", limit: 10 },
		})
		assert.equal(artifacts.json.success, true)
		assert.ok(artifacts.json.artifacts.length > 0, "expected at least one .ue4stats artifact")
		const statsArtifact = artifacts.json.artifacts[0]
		const info = await call("manage_profile", {
			action: "artifact_info",
			params: { path: statsArtifact.path },
		})
		assert.equal(info.json.success, true)
		assert.equal(info.json.artifact.path, statsArtifact.path)
		assert.ok(info.json.artifact.size > 0)
		console.log(`[PASS] profiling artifacts (${artifacts.json.artifacts.length} found; newest=${statsArtifact.name})`)

		const before = await call("manage_ddgi", { action: "list_volumes" })
		for (const volume of (before.json.volumes ?? []).filter((entry) =>
			String(entry.label || entry.actor_name || "").startsWith(volumeLabel),
		)) {
			await call("manage_ddgi", {
				action: "delete_volume",
				params: { name: volume.label || volume.actor_name },
			})
		}

		const spawn = await call("manage_ddgi", {
			action: "spawn_volume",
			params: {
				name: volumeLabel,
				location: { x: 0, y: 0, z: 0 },
				properties: {
					probe_counts: { x: 4, y: 4, z: 4 },
					probe_history_weight: 0.9,
					visualize_probes: false,
				},
			},
		})
		assert.equal(spawn.json.success, true)
		assert.equal(spawn.json.volume.probe_count, 64)
		spawned = true
		console.log("[PASS] DDGI spawn_volume with probe settings")

		const inspectSpawn = await call("manage_ddgi", {
			action: "inspect_volume",
			params: { name: volumeLabel },
		})
		assert.equal(inspectSpawn.json.volume.probe_count, 64)
		assert.ok(
			Math.abs(inspectSpawn.json.volume.properties.probe_history_weight - 0.9) < 0.001,
			"probe_history_weight should be approximately 0.9",
		)

		const spawnHistory = await call("manage_history", {
			action: "list",
			params: { tool: "manage_ddgi", action: "spawn_volume", limit: 5 },
		})
		assert.ok(spawnHistory.json.entries.length > 0)
		const spawnEntry = spawnHistory.json.entries[0]
		assert.equal(spawnEntry.undo, "native")

		await call("manage_history", { action: "undo", params: { targetId: spawnEntry.id } })
		const afterSpawnUndo = await call("manage_ddgi", { action: "list_volumes" })
		assert.equal(
			(afterSpawnUndo.json.volumes ?? []).filter((entry) => entry.label === volumeLabel).length,
			0,
		)
		spawned = false
		console.log("[PASS] DDGI spawn native undo")

		await call("manage_history", { action: "redo", params: { targetId: spawnEntry.id } })
		const afterSpawnRedo = await call("manage_ddgi", { action: "list_volumes" })
		assert.equal(
			(afterSpawnRedo.json.volumes ?? []).filter((entry) => entry.label === volumeLabel).length,
			1,
		)
		spawned = true
		console.log("[PASS] DDGI spawn native redo")

		const update = await call("manage_ddgi", {
			action: "update_volume",
			params: {
				name: volumeLabel,
				label: updatedLabel,
				properties: {
					probe_counts: { x: 6, y: 6, z: 6 },
					probe_max_ray_distance: 50000,
					light_multiplier: 1.5,
				},
			},
		})
		assert.equal(update.json.success, true)
		assert.equal(update.json.volume.probe_count, 216)
		assert.equal(update.json.volume.label, updatedLabel)
		assert.equal(update.json.volume.properties.probe_max_ray_distance, 50000)
		console.log("[PASS] DDGI update_volume probe counts and settings")

		const updateHistory = await call("manage_history", {
			action: "list",
			params: { tool: "manage_ddgi", action: "update_volume", limit: 5 },
		})
		const updateEntry = updateHistory.json.entries[0]
		assert.equal(updateEntry.undo, "native")

		await call("manage_history", { action: "undo", params: { targetId: updateEntry.id } })
		const afterUpdateUndo = await call("manage_ddgi", {
			action: "inspect_volume",
			params: { name: volumeLabel },
		})
		assert.equal(afterUpdateUndo.json.volume.probe_count, 64)
		assert.equal(afterUpdateUndo.json.volume.properties.probe_max_ray_distance, 100000)
		console.log("[PASS] DDGI update native undo")

		await call("manage_history", { action: "redo", params: { targetId: updateEntry.id } })
		const afterUpdateRedo = await call("manage_ddgi", {
			action: "inspect_volume",
			params: { name: updatedLabel },
		})
		assert.equal(afterUpdateRedo.json.volume.probe_count, 216)
		console.log("[PASS] DDGI update native redo")

		const deleteResult = await call("manage_ddgi", {
			action: "delete_volume",
			params: { name: updatedLabel },
		})
		assert.equal(deleteResult.json.success, true)
		spawned = false
		const afterDelete = await call("manage_ddgi", { action: "list_volumes" })
		assert.equal(
			(afterDelete.json.volumes ?? []).filter((entry) => entry.label === updatedLabel).length,
			0,
		)
		console.log("[PASS] DDGI delete_volume")

		const deleteHistory = await call("manage_history", {
			action: "list",
			params: { tool: "manage_ddgi", action: "delete_volume", limit: 5 },
		})
		const deleteEntry = deleteHistory.json.entries[0]
		assert.equal(deleteEntry.undo, "native")

		await call("manage_history", { action: "undo", params: { targetId: deleteEntry.id } })
		const afterDeleteUndo = await call("manage_ddgi", { action: "list_volumes" })
		assert.equal(
			(afterDeleteUndo.json.volumes ?? []).filter((entry) => entry.label === updatedLabel).length,
			1,
		)
		spawned = true
		console.log("[PASS] DDGI delete native undo")

		await call("manage_ddgi", { action: "delete_volume", params: { name: updatedLabel } })
		spawned = false
		console.log("[PASS] DDGI test volume removed")
	} finally {
		try {
			const cleanupList = await call("manage_ddgi", { action: "list_volumes" }, 60000)
			for (const volume of (cleanupList.json.volumes ?? []).filter((entry) =>
				String(entry.label || entry.actor_name || "").startsWith(volumeLabel),
			)) {
				await call(
					"manage_ddgi",
					{ action: "delete_volume", params: { name: volume.label || volume.actor_name } },
					60000,
				)
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
		} catch (cleanupError) {
			console.error(`[WARN] cleanup failed: ${cleanupError.message}`)
		}
		await client.close()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
