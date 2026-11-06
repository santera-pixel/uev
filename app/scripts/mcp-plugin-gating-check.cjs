const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const sourceManifestPath = path.join(repoRoot, "server", "plugins", "plugins.manifest.json")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-mcp-plugin-gating-"))
const auditPath = path.join(tempDir, "audit.jsonl")
const historyPath = path.join(tempDir, "history.jsonl")
const manifestPath = path.join(tempDir, "plugins.manifest.json")

const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"))
manifest.actionRequirements = {
	...(manifest.actionRequirements ?? {}),
	"manage_vite.preset_list": ["MCP_Test_MissingPlugin"],
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

const extractText = (result) =>
	(result.content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")

const parseJson = (result) => {
	const text = extractText(result)
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				return { raw: text }
			}
		}
		return { raw: text }
	}
}

const withTimeout = (promise, timeoutMs, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
	])

const assert = require("node:assert/strict")

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
			UEV_PLUGIN_MANIFEST: manifestPath,
		},
	})
	const client = new Client({ name: "plugin-gating-check", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const toolList = await withTimeout(client.listTools(), 10000, "listTools")
	assert.ok(toolList.tools.length >= 38, `expected at least 38 tools, got ${toolList.tools.length}`)
	console.log(`[PASS] ${toolList.tools.length} tools registered`)

	const pluginStatus = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_debug", arguments: { action: "plugins", params: {} } }),
			30000,
			"manage_debug.plugins",
		),
	)
	assert.equal(pluginStatus.success, true)
	const availability = pluginStatus.availability ?? {}
	const detected = Array.isArray(availability.plugins) ? availability.plugins : []
	for (const required of ["PythonScriptPlugin", "EditorScriptingUtilities", "UEVNative"]) {
		assert.ok(detected.includes(required), `plugin probe did not detect ${required}: ${detected.join(", ")}`)
	}
	console.log(`[PASS] plugin probe: ${detected.join(", ")}`)

	const refreshed = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_debug", arguments: { action: "refresh_plugins", params: {} } }),
			30000,
			"manage_debug.refresh_plugins",
		),
	)
	assert.equal(refreshed.success, true)
	assert.equal(refreshed.manifestVersion, 1)
	console.log("[PASS] manifest reload and plugin refresh")

	const catalog = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_vite", arguments: { action: "cvar_catalog", params: {} } }),
			60000,
			"manage_vite.cvar_catalog",
		),
	)
	assert.equal(catalog.success, true)
	assert.ok(Array.isArray(catalog.cvars) && catalog.cvars.length > 0)
	console.log(`[PASS] ungated Vite catalog: ${catalog.cvars.length} cvars`)

	const gated = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_vite", arguments: { action: "preset_list", params: {} } }),
			30000,
			"manage_vite.preset_list",
		),
	)
	assert.equal(gated.success, false)
	assert.equal(gated.code, "plugin.unavailable")
	assert.ok(Array.isArray(gated.missing) && gated.missing.some((item) => item.name === "MCP_Test_MissingPlugin"))
	console.log(`[PASS] fake missing plugin gated: ${gated.missing.map((item) => item.name).join(", ")}`)

	const projectInfo = extractText(
		await withTimeout(
			client.callTool({ name: "manage_editor", arguments: { action: "project_info", params: {} } }),
			60000,
			"manage_editor.project_info",
		),
	)
	assert.ok(projectInfo.includes("ViteMCPTest"), "project_info did not return the project")
	console.log("[PASS] EditorScriptingUtilities-gated action allowed with plugin present")

	const python = extractText(
		await withTimeout(
			client.callTool({
				name: "manage_editor",
				arguments: { action: "run_python", params: { code: 'print("PLUGIN_GATE_PYTHON_OK")' } },
			}),
			60000,
			"manage_editor.run_python",
		),
	)
	assert.ok(python.includes("PLUGIN_GATE_PYTHON_OK"), "run_python did not execute")
	console.log("[PASS] run_python remains available without plugin requirements")

	const history = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_history", arguments: { action: "list", params: { limit: 10 } } }),
			30000,
			"manage_history.list",
		),
	)
	assert.equal(history.success, true)
	console.log(`[PASS] history list: ${history.entries.length} entries`)

	const audit = parseJson(
		await withTimeout(
			client.callTool({ name: "manage_audit", arguments: { action: "plugin_audit", params: {} } }),
			60000,
			"manage_audit.plugin_audit",
		),
	)
	assert.equal(audit.success, true)
	assert.ok(audit.runtime && Array.isArray(audit.runtime.plugins))
	console.log("[PASS] runtime plugin audit")

	await client.close()
	console.log("[PASS] plugin gating live check completed")
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error))
	process.exit(1)
})
