const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `transform-probe-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `transform-probe-${stamp}.jsonl`)

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

	const client = new Client({ name: "transform-undo-probe", version: "1.0.0" })
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
		const actor = Array.isArray(before.json?.actors)
			? before.json.actors.find((entry) => entry.label === "1M_Cube_Chamfer") ?? before.json.actors[0]
			: undefined
		if (!actor) {
			throw new Error("Could not find a template actor to transform.")
		}
		console.log(`[INFO] Using actor ${actor.name} (${actor.label}) at ${JSON.stringify(actor.location)}`)
		const original = { ...actor.location }
		const moved = { x: original.x, y: original.y, z: original.z + 100 }

		const transform = await call("manage_actor", "transform", { name: actor.name, location: moved })
		console.log(`[TRANSFORM] ${transform.text.slice(0, 500)}`)
		const afterMove = await call("manage_actor", "list")
		const movedActor = findActor(afterMove.json, actor.name)
		console.log(`[CHECK] moved z=${movedActor?.location?.z} (expected ${moved.z})`)

		const history = await call("manage_history", "list", { tool: "manage_actor", action: "transform", limit: 5 })
		const entry = history.json?.entries?.[0]
		console.log(`[HISTORY] ${JSON.stringify(entry, null, 2)}`)
		if (entry) {
			const undo = await call("manage_history", "undo", { targetId: entry.id })
			console.log(`[UNDO] ${undo.text.slice(0, 500)}`)
			const afterUndo = await call("manage_actor", "list")
			const undoneActor = findActor(afterUndo.json, actor.name)
			console.log(`[CHECK] z after undo=${undoneActor?.location?.z} (expected ${original.z})`)
			if (undoneActor && Math.abs(undoneActor.location.z - original.z) > 0.01) {
				console.log("[INFO] Undo did not restore the transform; restoring manually.")
				await call("manage_actor", "transform", { name: actor.name, location: original })
			}
		}
		console.log("Transform undo probe complete.")
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
