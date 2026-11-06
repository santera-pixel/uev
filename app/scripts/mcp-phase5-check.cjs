const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const assert = require("node:assert/strict")
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `phase5-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `phase5-history-${stamp}.jsonl`)

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

	const client = new Client({ name: "phase5-check", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const call = async (name, args = {}, timeoutMs = 120000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 1400))
		return { text, json: parseJson(text) }
	}

	try {
		const status = await call("manage_code", { action: "status" }, 60000)
		assert.equal(status.json.success, true)
		assert.ok(status.json.project.projectName)
		assert.ok(status.json.project.projectFile.endsWith(".uproject"))
		assert.ok(status.json.source.count > 0, "expected project source files")
		assert.ok(status.json.logs.count > 0, "expected project log files")
		assert.equal(typeof status.json.liveCoding.moduleLoaded, "boolean")
		assert.ok(Array.isArray(status.json.warnings))
		console.log(
			`[PASS] code status (sources=${status.json.source.count}, logs=${status.json.logs.count}, liveCoding=${status.json.liveCoding.moduleLoaded})`,
		)

		const sources = await call("manage_code", { action: "sources", params: { limit: 20 } })
		assert.equal(sources.json.success, true)
		assert.ok(sources.json.total > 0)
		assert.ok(sources.json.files.some((file) => /ViteMCPTest/.test(file.name)))
		console.log(`[PASS] code source inventory (${sources.json.total} files)`)

		const logs = await call("manage_code", { action: "logs" })
		assert.equal(logs.json.success, true)
		assert.ok(logs.json.total > 0)
		assert.ok(logs.json.editorLog)
		const logTail = await call("manage_code", {
			action: "logs",
			params: { path: logs.json.editorLog, lines: 20, filter: "LiveCoding" },
		})
		assert.equal(logTail.json.success, true)
		assert.equal(typeof logTail.json.text, "string")
		console.log(`[PASS] code log inspection (${logs.json.total} logs)`)

		const tests = await call("manage_code", { action: "tests" })
		assert.equal(tests.json.success, true)
		assert.match(tests.json.automationCommand, /Automation RunTests/)
		assert.ok(Array.isArray(tests.json.files))
		console.log(`[PASS] code test inventory (${tests.json.total} source tests)`)

		const compilePreview = await call("manage_code", { action: "compile", params: {} })
		assert.equal(compilePreview.json.success, true)
		assert.equal(compilePreview.json.preview, true)
		assert.equal(compilePreview.json.command, "LiveCoding.Compile")
		assert.equal(typeof compilePreview.json.available, "boolean")
		console.log(`[PASS] Live Coding compile preview (available=${compilePreview.json.available})`)

		const testPreview = await call("manage_code", {
			action: "run_tests",
			params: { filter: "Project." },
		})
		assert.equal(testPreview.json.success, true)
		assert.equal(testPreview.json.preview, true)
		assert.equal(testPreview.json.command, "Automation RunTests Project.")
		console.log("[PASS] automation test preview")

		const aiStatus = await call("manage_ai", { action: "status" }, 180000)
		assert.equal(aiStatus.json.success, true)
		assert.equal(aiStatus.json.available, true)
		assert.equal(typeof aiStatus.json.counts.ai_controllers, "number")
		assert.ok(Array.isArray(aiStatus.json.warnings))
		console.log(
			`[PASS] AI debug status (controllers=${aiStatus.json.counts.ai_controllers}, assets=${aiStatus.json.counts.ai_assets}, navmesh=${aiStatus.json.counts.navmesh_actors})`,
		)

		const actors = await call("manage_ai", { action: "actors" }, 120000)
		assert.equal(actors.json.success, true)
		assert.ok(Array.isArray(actors.json.ai_controllers))
		console.log("[PASS] AI controller inventory")

		const assets = await call("manage_ai", { action: "assets" }, 120000)
		assert.equal(assets.json.success, true)
		assert.ok(Array.isArray(assets.json.ai_assets))
		console.log("[PASS] AI asset inventory")

		const navmesh = await call("manage_ai", { action: "navmesh" }, 120000)
		assert.equal(navmesh.json.success, true)
		assert.ok(Array.isArray(navmesh.json.navmesh_actors))
		console.log("[PASS] navmesh inventory")

		const perception = await call("manage_ai", { action: "perception" }, 120000)
		assert.equal(perception.json.success, true)
		assert.ok(Array.isArray(perception.json.perception_actors))
		console.log("[PASS] AI perception inventory")

		const debugPreview = await call("manage_ai", {
			action: "toggle_debug",
			params: { mode: "navmesh" },
		})
		assert.equal(debugPreview.json.success, true)
		assert.equal(debugPreview.json.preview, true)
		assert.equal(debugPreview.json.command, "show Navigation")
		console.log("[PASS] AI debugger preview")
	} finally {
		await client.close()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
