const assert = require("node:assert/strict")
const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `debug-history-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `debug-history-${stamp}.jsonl`)

const extractText = (result) => {
	const content = result && Array.isArray(result.content) ? result.content : []
	return content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
}

const parseJson = (text) => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				return text
			}
		}
		return text
	}
}

const withTimeout = (promise, timeoutMs, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
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

	const client = new Client({ name: "debug-history-check", version: "1.0.0" })
	let stderr = ""
	transport.on?.("error", (error) => {
		stderr += `${error.message}\n`
	})
	if (transport.stderr) {
		transport.stderr.on("data", (chunk) => {
			stderr += chunk.toString()
		})
	}

	const call = async (tool, action, params = {}, timeoutMs = 60000) => {
		const result = await withTimeout(
			client.callTool({ name: tool, arguments: { action, params } }),
			timeoutMs,
			`${tool}.${action}`,
		)
		const text = extractText(result)
		const json = parseJson(text)
		console.log(`--- ${tool}.${action} ---`)
		console.log(text.slice(0, 1500))
		return { text, json }
	}

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		const tools = await withTimeout(client.listTools(), 10000, "listTools")
		console.log(`[PASS] ${tools.tools.length} tools registered`)

		const health = await call("manage_debug", "health")
		assert.equal(health.json.success, true, "health did not succeed")
		assert.equal(health.json.safety.historyPath, historyPath, "history path mismatch")
		assert.equal(health.json.safety.supervisor.connected, true, "supervisor client is not connected")
		assert.equal(health.json.remote.connected, true, "remote execution is not connected")
		assert.equal(typeof health.json.supervisor.editorPid, "number", "supervisor did not return an editor pid")
		assert.match(JSON.stringify(health.json.python), /4\.27\.2/, "engine version not reported by Python health")
		console.log("[PASS] Debug health reports Python, supervisor, and remote execution")

		const supervisor = await call("manage_debug", "supervisor")
		assert.equal(typeof supervisor.json.editorPid, "number", "supervisor status missing editorPid")
		assert.equal(typeof supervisor.json.logPath, "string", "supervisor status missing logPath")
		assert.ok(Array.isArray(supervisor.json.activeCalls), "supervisor status missing activeCalls")
		console.log("[PASS] Supervisor status request")

		const editorLog = await call("manage_debug", "logs", { source: "editor", lines: 50 })
		assert.equal(editorLog.json.success, true, "editor log read failed")
		assert.ok(String(editorLog.json.content).length > 0, "editor log is empty")
		const supervisorLog = await call("manage_debug", "logs", { source: "supervisor", lines: 50 })
		assert.equal(supervisorLog.json.success, true, "supervisor log read failed")
		assert.ok(String(supervisorLog.json.content).length > 0, "supervisor log is empty")
		const auditLog = await call("manage_debug", "logs", { source: "audit", lines: 50 })
		assert.equal(auditLog.json.success, true, "audit log read failed")
		assert.ok(Array.isArray(auditLog.json.entries), "audit log entries missing")
		console.log("[PASS] Log tails for editor, supervisor, and audit")

		const lastCalls = await call("manage_debug", "last_calls", { limit: 20 })
		assert.equal(lastCalls.json.success, true, "last_calls failed")
		assert.ok(lastCalls.json.entries.length > 0, "last_calls returned no entries")
		console.log("[PASS] Recent call history")

		const existing = await call("manage_actor", "list")
		for (const label of ["MCP_History_Test_Actor", "MCP_Manual_Undo_Test"]) {
			if (existing.text.includes(label)) {
				const cleanup = await call("manage_actor", "delete", { name: label })
				console.log(`[INFO] Removed pre-existing ${label}: ${cleanup.text.slice(0, 200)}`)
			}
		}

		const spawn = await call("manage_actor", "spawn", {
			type: "StaticMeshActor",
			name: "MCP_History_Test_Actor",
			location: { x: 0, y: 0, z: 100 },
		})
		assert.equal(spawn.json.success, true, `spawn failed: ${spawn.text}`)
		const actorLabel = spawn.json.actor?.label ?? spawn.json.actor?.name ?? "MCP_History_Test_Actor"
		console.log(`[PASS] Spawned actor: ${actorLabel}`)

		const history = await call("manage_history", "list", { tool: "manage_actor", action: "spawn", limit: 10 })
		assert.equal(history.json.success, true, "history list failed")
		const spawnEntry = history.json.entries.find((entry) => entry.tool === "manage_actor" && entry.action === "spawn")
		assert.ok(spawnEntry, "spawn entry not found in history")
		assert.equal(spawnEntry.undo, "native", "spawn is not marked native-undoable")
		assert.match(String(spawnEntry.transactionLabel), /^MCP: manage_actor\.spawn/, "transaction label missing")
		console.log(`[PASS] Native transaction entry: ${spawnEntry.id}`)

		const afterSpawn = await call("manage_actor", "list")
		assert.ok(afterSpawn.text.includes(actorLabel), "actor not present after spawn")

		const undo = await call("manage_history", "undo", { targetId: spawnEntry.id })
		assert.equal(undo.json.success, true, `undo failed: ${undo.text}`)
		const afterUndo = await call("manage_actor", "list")
		assert.ok(!afterUndo.text.includes(actorLabel), "actor still present after native undo")
		const undoneEntry = await call("manage_history", "get", { id: spawnEntry.id })
		assert.equal(undoneEntry.json.entry.undone, true, "history entry not marked undone")
		console.log("[PASS] Native undo removed the spawned actor")

		const redo = await call("manage_history", "redo", { targetId: spawnEntry.id })
		assert.equal(redo.json.success, true, `redo failed: ${redo.text}`)
		const afterRedo = await call("manage_actor", "list")
		assert.ok(afterRedo.text.includes(actorLabel), "actor not restored after native redo")
		console.log("[PASS] Native redo restored the spawned actor")

		const python = await call("manage_editor", "run_python", { code: "print('HISTORY_SCRIPT_OK')" })
		assert.ok(python.text.includes("HISTORY_SCRIPT_OK"), "supervised Python did not run")
		const scripts = await call("manage_debug", "scripts", { limit: 20 })
		assert.equal(scripts.json.success, true, "scripts lookup failed")
		assert.ok(JSON.stringify(scripts.json.entries).includes("HISTORY_SCRIPT_OK"), "recent script code not recorded")
		console.log("[PASS] Recent supervised Python script recorded")

		const deleted = await call("manage_actor", "delete", { name: actorLabel })
		assert.equal(deleted.json.success, true, `cleanup delete failed: ${deleted.text}`)
		const finalList = await call("manage_actor", "list")
		assert.ok(!finalList.text.includes(actorLabel), "actor still present after cleanup")
		console.log("[PASS] Cleanup complete")

		const finalHistory = await call("manage_history", "list", { limit: 20 })
		console.log(`[PASS] History entries: ${finalHistory.json.entries.length}`)
		console.log("Debug/history live check completed successfully.")
	} catch (error) {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error))
		if (stderr.trim()) {
			console.error("Server stderr:")
			console.error(stderr.slice(-6000))
		}
		process.exitCode = 1
	} finally {
		try {
			await client.close()
		} catch {
			// Ignore close errors.
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error))
	process.exit(1)
})
