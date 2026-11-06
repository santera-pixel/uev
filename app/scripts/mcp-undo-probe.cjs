const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `undo-probe-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `undo-probe-${stamp}.jsonl`)

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

	const client = new Client({ name: "undo-probe", version: "1.0.0" })
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
		console.log(text.slice(0, 1200))
		return { text, json }
	}

	const cleanup = async () => {
		const list = await call("manage_actor", "list")
		for (const label of [
			"MCP_History_Test_Actor",
			"MCP_Manual_Undo_Test",
			"MCP_Wrapper_Undo_Test",
		]) {
			if (list.text.includes(label)) {
				const deleted = await call("manage_actor", "delete", { name: label })
				console.log(`[CLEANUP] ${label}: ${deleted.text.slice(0, 200)}`)
			}
		}
	}

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		await cleanup()

		const manualScript = [
			"import unreal",
			'with unreal.ScopedEditorTransaction("MCP manual undo probe"):',
			"    actor = unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0, 0, 200), unreal.Rotator(0, 0, 0))",
			'    actor.set_actor_label("MCP_Manual_Undo_Test")',
			'print("MANUAL_SPAWNED:" + actor.get_name())',
		].join("\n")
		await call("manage_editor", "run_python", { code: manualScript })
		let list = await call("manage_actor", "list")
		console.log(`[CHECK] manual actor present before undo: ${list.text.includes("MCP_Manual_Undo_Test")}`)

		await call("manage_editor", "console_command", { command: "UNDO" })
		list = await call("manage_actor", "list")
		console.log(`[CHECK] manual actor present after console UNDO: ${list.text.includes("MCP_Manual_Undo_Test")}`)

		if (list.text.includes("MCP_Manual_Undo_Test")) {
			const directUndo = [
				"import unreal",
				"world = unreal.EditorLevelLibrary.get_editor_world()",
				'unreal.SystemLibrary.execute_console_command(world, "UNDO")',
				'print("DIRECT_UNDO_SENT")',
			].join("\n")
			await call("manage_editor", "run_python", { code: directUndo })
			list = await call("manage_actor", "list")
			console.log(`[CHECK] manual actor present after direct Python UNDO: ${list.text.includes("MCP_Manual_Undo_Test")}`)
		}

		await cleanup()

		const wrapperSpawn = await call("manage_actor", "spawn", {
			type: "StaticMeshActor",
			name: "MCP_Wrapper_Undo_Test",
			location: { x: 0, y: 0, z: 250 },
		})
		const remote = await call("manage_debug", "remote")
		console.log(`[PROBE] last command: ${JSON.stringify(remote.json.lastCommand, null, 2)}`)
		const history = await call("manage_history", "list", { tool: "manage_actor", action: "spawn", limit: 5 })
		const entry = history.json.entries && history.json.entries[0]
		console.log(`[PROBE] wrapper history entry: ${JSON.stringify(entry, null, 2)}`)
		if (entry) {
			await call("manage_history", "undo", { targetId: entry.id })
			list = await call("manage_actor", "list")
			console.log(`[CHECK] wrapper actor present after native undo: ${list.text.includes("MCP_Wrapper_Undo_Test")}`)
		}
		await cleanup()
		console.log("Undo probe complete.")
	} catch (error) {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error))
		if (stderr.trim()) {
			console.error("Server stderr:")
			console.error(stderr.slice(-4000))
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
