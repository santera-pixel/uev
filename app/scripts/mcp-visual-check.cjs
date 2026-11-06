const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const projectDir = "D:\\Uprojects\\ViteMCPTest"
const screenshotsRoot = path.join(projectDir, "Saved", "Screenshots")
const capturesDir = path.resolve(repoRoot, "..", "captures")
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `visual-audit-${Date.now()}.jsonl`)

const extractText = (result) => {
	if (!result || !Array.isArray(result.content)) {
		return ""
	}

	return result.content
		.filter((item) => item?.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim()
}

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	])

const assert = (condition, message) => {
	if (!condition) {
		throw new Error(message)
	}
}

const callTool = async (client, name, args, timeoutMs = 60000) => {
	const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
	const text = extractText(result)
	console.log(`--- ${name} ---`)
	console.log(text.slice(0, 2000))
	return text
}

const findNewestPng = (root) => {
	if (!fs.existsSync(root)) {
		return undefined
	}

	let newest
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
				const stat = fs.statSync(fullPath)
				if (!newest || stat.mtimeMs > newest.mtimeMs) {
					newest = { path: fullPath, mtimeMs: stat.mtimeMs }
				}
			}
		}
	}

	walk(root)
	return newest?.path
}

async function main() {
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
			UEV_SUPERVISOR_PIPE: "\\\\.\\pipe\\uev-supervisor",
		},
	})

	const client = new Client({ name: "unreal-mcp-visual-check", version: "0.1.0" })

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		const tools = await withTimeout(client.listTools(), 10000, "listTools")
		console.log(`[PASS] Connect to the MCP server (${tools.tools.length} tools)`)

		const cleanupExistingScript = [
			"import unreal",
			"for actor in unreal.EditorLevelLibrary.get_all_level_actors():",
			'    if actor.get_actor_label() == "MCP_Supervisor_Test_Cube":',
			"        name = actor.get_name()",
			"        unreal.EditorLevelLibrary.destroy_actor(actor)",
			'        print("CLEANED:" + name)',
		].join("\n")
		const cleanupExisting = await callTool(client, "manage_editor", {
			action: "run_python",
			params: { code: cleanupExistingScript },
		})
		if (cleanupExisting.includes("CLEANED:")) {
			console.log("[PASS] Removed a previous test cube")
		}

		const camera = await callTool(client, "manage_editor", {
			action: "move_camera",
			params: {
				location: { x: -500, y: 0, z: 300 },
				rotation: { pitch: -20, yaw: 0, roll: 0 },
			},
		})
		assert(!camera.includes('"success": false'), `move_camera failed: ${camera}`)
		console.log("[PASS] Move the viewport camera")

		const spawnScript = [
			"import unreal",
			'cube = unreal.load_asset("/Engine/BasicShapes/Cube.Cube")',
			"actor = unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0, 0, 100), unreal.Rotator(0, 0, 0))",
			"component = actor.get_component_by_class(unreal.StaticMeshComponent)",
			"component.set_static_mesh(cube)",
			'actor.set_actor_label("MCP_Supervisor_Test_Cube")',
			'print("SPAWNED:" + actor.get_name())',
		].join("\n")

		const spawn = await callTool(client, "manage_editor", {
			action: "run_python",
			params: { code: spawnScript },
		})
		const spawnMatch = spawn.match(/SPAWNED:([^\r\n]+)/)
		assert(spawnMatch, `spawn did not return an actor name: ${spawn}`)
		const actorName = spawnMatch[1].trim()
		console.log(`[PASS] Spawn visible cube: ${actorName}`)

		const screenshot = await callTool(client, "manage_editor", {
			action: "screenshot",
			params: {},
		})
		const screenshotLine = screenshot
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.toLowerCase().endsWith(".png"))
		let screenshotPath = screenshotLine
		if (screenshotPath && !path.isAbsolute(screenshotPath)) {
			screenshotPath = path.resolve(projectDir, screenshotPath)
		}
		if (!screenshotPath || !fs.existsSync(screenshotPath)) {
			screenshotPath = findNewestPng(screenshotsRoot)
		}
		assert(screenshotPath && fs.existsSync(screenshotPath), `screenshot file not found: ${screenshot}`)
		fs.mkdirSync(capturesDir, { recursive: true })
		const capturePath = path.join(capturesDir, "visual-check-2.png")
		fs.copyFileSync(screenshotPath, capturePath)
		console.log(`[PASS] Screenshot: ${screenshotPath}`)
		console.log(`[PASS] Screenshot copied to: ${capturePath}`)

		const actorList = await callTool(client, "manage_actor", { action: "list", params: {} })
		assert(actorList.includes(actorName), `actor list does not include ${actorName}`)
		console.log("[PASS] Actor list includes the spawned cube")

		const deleted = await callTool(client, "manage_actor", {
			action: "delete",
			params: { name: actorName },
		})

		if (deleted.includes('"success": false')) {
			console.warn("manage_actor.delete reported failure; trying Python cleanup")
			const cleanupScript = [
				"import unreal",
				'name = ""',
				"for actor in unreal.EditorLevelLibrary.get_all_level_actors():",
				'    if actor.get_actor_label() == "MCP_Supervisor_Test_Cube":',
				"        name = actor.get_name()",
				"        unreal.EditorLevelLibrary.destroy_actor(actor)",
				'        print("DELETED:" + name)',
				"        break",
			].join("\n")
			const cleanup = await callTool(client, "manage_editor", {
				action: "run_python",
				params: { code: cleanupScript },
			})
			assert(cleanup.includes("DELETED:"), `python cleanup did not delete the cube: ${cleanup}`)
		}
		console.log("[PASS] Cube cleanup requested")

		const afterList = await callTool(client, "manage_actor", { action: "list", params: {} })
		assert(!afterList.includes(actorName), `cube still present after cleanup: ${actorName}`)
		console.log("[PASS] Cube removed from the level")

		const python = await callTool(client, "manage_editor", {
			action: "run_python",
			params: { code: 'print("SUPERVISED_PYTHON_OK")' },
		})
		assert(python.includes("SUPERVISED_PYTHON_OK"), `supervised python check failed: ${python}`)
		console.log("[PASS] Supervised Python execution")

		console.log(`Audit log: ${auditPath}`)
		console.log(`Screenshot: ${screenshotPath}`)
	} finally {
		try {
			await client.close()
		} catch {}
	}
}

main().catch((error) => {
	console.error("MCP visual check failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
