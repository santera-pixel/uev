const os = require("node:os")
const path = require("node:path")

const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `live-audit-${Date.now()}.jsonl`)

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
			UEV_PROFILE: "unattended",
			UEV_AUDIT_LOG: auditPath,
			UEV_SUPERVISOR_PIPE: "\\\\.\\pipe\\uev-supervisor",
		},
	})

	const client = new Client({ name: "unreal-mcp-live-check", version: "0.1.0" })
	const stderrLines = []
	if (transport.stderr) {
		transport.stderr.on("data", (chunk) => {
			const text = chunk.toString()
			if (!text) {
				return
			}
			stderrLines.push(...text.split(/\r?\n/).filter(Boolean))
			while (stderrLines.length > 40) {
				stderrLines.shift()
			}
		})
	}

	try {
		await withTimeout(client.connect(transport), 15000, "connect")
		console.log("[PASS] Connect to the MCP server")

		const tools = await withTimeout(client.listTools(), 10000, "listTools")
		console.log(`[PASS] List ${tools.tools.length} tools`)

		assert(
			!tools.tools.some((tool) => tool.name === "get_unreal_version"),
			"get_unreal_version is retired and must not be listed",
		)
		console.log("[PASS] get_unreal_version is not exposed")

		const projectResult = await withTimeout(
			client.callTool({ name: "manage_editor", arguments: { action: "project_info", params: {} } }),
			20000,
			"manage_editor.project_info",
		)
		const projectText = extractText(projectResult)
		assert(projectText.length > 0, "project_info returned no text")
		console.log(`[PASS] manage_editor.project_info: ${projectText.slice(0, 300)}`)

		const blockedPieResult = await withTimeout(
			client.callTool({ name: "manage_editor", arguments: { action: "start_pie", params: {} } }),
			10000,
			"manage_editor.start_pie",
		)
		const blockedPie = JSON.parse(extractText(blockedPieResult))
		assert(blockedPie.code === "safety.blocked", `start_pie was not blocked: ${JSON.stringify(blockedPie)}`)
		console.log("[PASS] start_pie blocked by the unattended allowlist")

		const blockedPythonResult = await withTimeout(
			client.callTool({
				name: "manage_editor",
				arguments: { action: "run_python", params: { code: "print(1)" } },
			}),
			10000,
			"manage_editor.run_python",
		)
		const blockedPython = JSON.parse(extractText(blockedPythonResult))
		assert(
			blockedPython.code === "safety.blocked",
			`run_python was not blocked: ${JSON.stringify(blockedPython)}`,
		)
		console.log("[PASS] run_python blocked by the unattended allowlist")
		console.log(`Audit log: ${auditPath}`)
	} finally {
		try {
			await client.close()
		} catch {}
	}

	if (stderrLines.some((line) => /error|failed|exception/i.test(line))) {
		console.log("Server stderr:")
		for (const line of stderrLines.slice(-10)) {
			console.log(`  ${line}`)
		}
	}
}

main().catch((error) => {
	console.error("MCP live check failed:", error instanceof Error ? error.message : String(error))
	process.exit(1)
})
