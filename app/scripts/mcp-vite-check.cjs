const assert = require("node:assert/strict")
const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `vite-check-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `vite-check-history-${stamp}.jsonl`)

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
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				// Fall through.
			}
		}
		return undefined
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
			UEV_PROFILE: "unattended",
			UEV_AUDIT_LOG: auditPath,
			UEV_HISTORY_LOG: historyPath,
			UEV_SUPERVISOR_PIPE: "\\\\.\\pipe\\uev-supervisor",
		},
	})

	const client = new Client({ name: "mcp-vite-check", version: "1.0.0" })
	const stderrChunks = []
	if (transport.stderr) {
		transport.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()))
	}

	const call = async (name, args, timeoutMs = 120_000) => {
		const result = await withTimeout(
			client.callTool({ name, arguments: args || {} }),
			timeoutMs,
			`${name}`,
		)
		const text = extractText(result)
		const json = parseJson(text)
		return { text, json }
	}

	try {
		await withTimeout(client.connect(transport), 15_000, "connect")
		const tools = await withTimeout(client.listTools(), 10_000, "listTools")
		assert.equal(tools.tools.length, 38, `expected 38 tools, got ${tools.tools.length}`)
		console.log("[PASS] 38 tools registered")

		const capabilities = await call("manage_vite", { action: "capabilities", params: {} })
		assert.equal(capabilities.json.success, true)
		assert.equal(capabilities.json.project.projectName, "ViteMCPTest")
		assert.deepEqual(capabilities.json.plugins.missing, [])
		assert.deepEqual(capabilities.json.config.findings, [])
		assert.match(JSON.stringify(capabilities.json.health), /4\.27\.2/)
		console.log("[PASS] manage_vite capabilities")

		const catalog = await call("manage_vite", { action: "cvar_catalog", params: {} })
		assert.equal(catalog.json.success, true)
		assert.ok(Array.isArray(catalog.json.cvars))
		const ddgi = catalog.json.cvars.find((entry) => entry.name === "r.RTXGI.DDGI")
		assert.ok(ddgi, "r.RTXGI.DDGI missing from catalog")
		assert.equal(ddgi.available, true)
		assert.notEqual(ddgi.current, undefined)
		const dlssSwitch = catalog.json.compileSwitches.find((entry) => entry.name === "VITE_DLSS_PATCH")
		assert.ok(dlssSwitch, "VITE_DLSS_PATCH missing")
		console.log(`[PASS] cvar catalog: ${catalog.json.cvars.length} cvars, DDGI=${ddgi.current}`)

		const cvarGet = await call("manage_vite", {
			action: "cvar_get",
			params: { name: "r.RTXGI.DDGI" },
		})
		assert.equal(cvarGet.json.defined, true)
		assert.equal(cvarGet.json.available, true)
		assert.notEqual(cvarGet.json.current, undefined)
		console.log(`[PASS] cvar_get r.RTXGI.DDGI=${cvarGet.json.current}`)

		const renderState = await call("manage_vite", { action: "render_state", params: {} })
		assert.equal(renderState.json.success, true)
		assert.ok(renderState.json.state.some((entry) => entry.name === "r.RTXGI.DDGI"))
		console.log(`[PASS] render_state: ${renderState.json.state.length} entries`)

		const switches = await call("manage_vite", { action: "compile_switches", params: {} })
		assert.equal(switches.json.success, true)
		assert.ok(switches.json.switches.some((entry) => entry.name === "VITE_DLSS_PATCH"))
		assert.ok(switches.json.switches.some((entry) => entry.name === "VITE_PHYSX_FIXED_TIMESTEP"))
		console.log("[PASS] compile_switches")

		const projectAudit = await call("manage_vite", { action: "project_audit", params: {} })
		assert.equal(projectAudit.json.success, true)
		assert.deepEqual(projectAudit.json.audit.plugins.missing, [])
		assert.deepEqual(projectAudit.json.audit.config.findings, [])
		assert.equal(projectAudit.json.audit.ok, true)
		console.log(`[PASS] project_audit: ok=${projectAudit.json.audit.ok}, cvar findings=${projectAudit.json.audit.cvars.findings.length}`)

		const presetList = await call("manage_vite", { action: "preset_list", params: {} })
		assert.equal(presetList.json.success, true)
		assert.ok(presetList.json.presets.some((preset) => preset.name === "performance"))
		assert.ok(presetList.json.presets.some((preset) => preset.name === "quality"))
		console.log(`[PASS] preset list: ${presetList.json.presets.length} presets`)

		const preview = await call("manage_vite", {
			action: "preset_preview",
			params: { name: "performance" },
		})
		assert.equal(preview.json.success, true)
		assert.equal(preview.json.preset, "performance")
		assert.ok(Array.isArray(preview.json.changes))
		assert.ok(preview.json.changes.length > 0)
		console.log(`[PASS] preset preview: ${preview.json.changedCount} changes`)

		const pluginAudit = await call("manage_audit", { action: "plugin_audit", params: {} })
		assert.deepEqual(pluginAudit.json.missing, [])
		console.log("[PASS] audit plugin_audit")

		const configAudit = await call("manage_audit", { action: "config_audit", params: {} })
		assert.equal(configAudit.json.pythonRemoteExecution.enabled, true)
		assert.equal(configAudit.json.pythonRemoteExecution.bindAddress, "127.0.0.1")
		assert.equal(configAudit.json.pythonRemoteExecution.ttl, "0")
		assert.deepEqual(configAudit.json.findings, [])
		console.log("[PASS] audit config_audit")

		const cvarAudit = await call("manage_audit", { action: "cvar_audit", params: {} })
		assert.equal(cvarAudit.json.success, true)
		assert.ok(cvarAudit.json.settings && typeof cvarAudit.json.settings === "object")
		assert.ok(Array.isArray(cvarAudit.json.findings))
		console.log(`[PASS] audit cvar_audit: ${Object.keys(cvarAudit.json.settings).length} settings, ${cvarAudit.json.findings.length} findings`)

		const summary = await call("manage_audit", { action: "project_summary", params: {} })
		assert.equal(summary.json.audit.ok, true)
		console.log("[PASS] audit project_summary")

		console.log("")
		console.log("Vite read-only live check completed successfully.")
	} catch (error) {
		console.error("[FAIL]", error instanceof Error ? error.message : String(error))
		const stderr = stderrChunks.join("")
		if (stderr.trim()) {
			console.error("--- server stderr ---")
			console.error(stderr.slice(-4000))
		}
		process.exitCode = 1
	} finally {
		await client.close().catch(() => {})
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
