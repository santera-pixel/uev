const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `inline-probe-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `inline-probe-${stamp}.jsonl`)

const extractText = (result) => {
	const content = result && Array.isArray(result.content) ? result.content : []
	return content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
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

	const client = new Client({ name: "inline-undo-probe", version: "1.0.0" })
	let stderr = ""
	transport.on?.("error", (error) => {
		stderr += `${error.message}\n`
	})
	if (transport.stderr) {
		transport.stderr.on("data", (chunk) => {
			stderr += chunk.toString()
		})
	}

	const script = [
		"import json",
		"import unreal",
		"target = None",
		"for actor in unreal.EditorLevelLibrary.get_all_level_actors():",
		'    if actor.get_name() == "1M_Cube_Chamfer_2" or actor.get_actor_label() in ("1M_Cube_Chamfer", "MCP_Modify_Undo_Test"):',
		"        target = actor",
		"        break",
		'if target is None:',
		'    print(json.dumps({"success": False, "reason": "actor not found"}))',
		"else:",
		'    before = {"name": target.get_name(), "label": target.get_actor_label()}',
		'    with unreal.ScopedEditorTransaction("MCP inline modify probe"):',
		"        target.modify()",
		'        target.set_actor_label("MCP_Modify_Undo_Test")',
		'    after_set = {"name": target.get_name(), "label": target.get_actor_label()}',
		"    world = unreal.EditorLevelLibrary.get_editor_world()",
		'    unreal.SystemLibrary.execute_console_command(world, "UNDO")',
		'    after_undo = {"name": target.get_name(), "label": target.get_actor_label()}',
		'    if after_undo["label"] != "1M_Cube_Chamfer":',
		'        target.set_actor_label("1M_Cube_Chamfer")',
		'    restored = {"name": target.get_name(), "label": target.get_actor_label()}',
		'    print(json.dumps({"success": True, "before": before, "after_set": after_set, "after_undo": after_undo, "restored": restored}, indent=2))',
	].join("\n")

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		const result = await withTimeout(
			client.callTool({
				name: "manage_editor",
				arguments: { action: "run_python", params: { code: script } },
			}),
			60000,
			"manage_editor.run_python",
		)
		console.log(extractText(result))
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
