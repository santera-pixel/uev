const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `modify-probe-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `modify-probe-${stamp}.jsonl`)

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

	const client = new Client({ name: "modify-undo-probe", version: "1.0.0" })
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
		return { text, json }
	}

	const findActor = (listJson, name) =>
		Array.isArray(listJson?.actors) ? listJson.actors.find((actor) => actor.name === name) : undefined

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		const before = await call("manage_actor", "list")
		const actor = findActor(before.json, "1M_Cube_Chamfer_2")
		if (!actor) {
			throw new Error("Template actor 1M_Cube_Chamfer_2 not found.")
		}
		const originalLabel = actor.label || "1M_Cube_Chamfer"
		console.log(`[INFO] actor=${actor.name} originalLabel=${originalLabel}`)

		const script = [
			"import unreal",
			"actor = None",
			"for candidate in unreal.EditorLevelLibrary.get_all_level_actors():",
			'    if candidate.get_name() == "1M_Cube_Chamfer_2":',
			"        actor = candidate",
			"        break",
			'if actor is None: raise RuntimeError("actor not found")',
			'with unreal.ScopedEditorTransaction("MCP modify label probe"):',
			"    actor.modify()",
			'    actor.set_actor_label("MCP_Modify_Undo_Test")',
			'print("LABEL_SET:" + actor.get_name())',
		].join("\n")
		const setLabel = await call("manage_editor", "run_python", { code: script })
		console.log(`[SET] ${setLabel.text.slice(0, 500)}`)

		let list = await call("manage_actor", "list")
		let current = findActor(list.json, "1M_Cube_Chamfer_2")
		console.log(`[CHECK] label before undo=${current?.label}`)

		await call("manage_editor", "console_command", { command: "UNDO" })
		list = await call("manage_actor", "list")
		current = findActor(list.json, "1M_Cube_Chamfer_2")
		console.log(`[CHECK] label after undo=${current?.label} (expected ${originalLabel})`)

		if (current && current.label !== originalLabel) {
			console.log("[INFO] Undo did not restore the label; restoring manually.")
			const restore = [
				"import unreal",
				"actor = None",
				"for candidate in unreal.EditorLevelLibrary.get_all_level_actors():",
				'    if candidate.get_name() == "1M_Cube_Chamfer_2":',
				"        actor = candidate",
				"        break",
				'if actor is not None: actor.set_actor_label("' + originalLabel + '")',
				'print("LABEL_RESTORED")',
			].join("\n")
			await call("manage_editor", "run_python", { code: restore })
		}
		console.log("Modify undo probe complete.")
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
