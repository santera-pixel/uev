import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import {
	createSafetyGateway,
	createSupervisorClient,
	defaultAllowlist,
	loadSafetyConfig,
	mergeAllowlist,
	resolvePolicy,
	type Allowlist,
	type SafetyConfig,
} from "../server/safety/index.js"

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

const extractText = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
	return (content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n")
}

const parseResponse = (result: unknown): Record<string, any> => JSON.parse(extractText(result))

const pass = (name: string) => console.log(`[PASS] ${name}`)

const main = async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-mcp-safety-"))
	const auditPath = path.join(tempDir, "audit.jsonl")
	const baseConfig: SafetyConfig = {
		allowlist: defaultAllowlist,
		profile: "unattended",
		readOnly: false,
		auditPath,
		historyPath: path.join(tempDir, "history.jsonl"),
	}

	const unattended = createSafetyGateway(baseConfig)
	const readResult = await unattended.guard({
		tool: "manage_editor",
		action: "project_info",
		args: {},
		callback: () => text("project ok"),
	})
	assert.equal(extractText(readResult), "project ok")
	pass("Allow read-only action in unattended profile")

	let writeRan = false
	const blocked = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "start_pie",
			args: {},
			callback: () => {
				writeRan = true
				return text("started")
			},
		}),
	)
	assert.equal(writeRan, false)
	assert.equal(blocked.code, "safety.blocked")
	assert.equal(blocked.mode, "write")
	pass("Block write action in unattended profile")

	const blockedPython = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "run_python",
			args: { code: "print(1)" },
			callback: () => text("ran"),
		}),
	)
	assert.equal(blockedPython.code, "safety.blocked")
	pass("Block run_python in unattended profile")

	const supervised = createSafetyGateway({ ...baseConfig, profile: "supervised" })
	const supervisedWrite = await supervised.guard({
		tool: "manage_editor",
		action: "start_pie",
		args: {},
		callback: () => text("started"),
	})
	assert.equal(extractText(supervisedWrite), "started")
	pass("Allow write action in supervised profile")

	const supervisedPython = await supervised.guard({
		tool: "manage_editor",
		action: "run_python",
		args: { code: "print(1)" },
		callback: () => text("ran python"),
	})
	assert.equal(extractText(supervisedPython), "ran python")
	pass("Allow run_python in supervised profile")

	const readOnly = createSafetyGateway({ ...baseConfig, profile: "supervised", readOnly: true })
	const readOnlyWrite = parseResponse(
		await readOnly.guard({
			tool: "manage_editor",
			action: "start_pie",
			args: {},
			callback: () => text("started"),
		}),
	)
	assert.equal(readOnlyWrite.code, "safety.blocked")
	assert.match(String(readOnlyWrite.message), /read-only/)
	pass("Block writes in read-only mode")

	const unknown = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "definitely_not_real",
			args: {},
			callback: () => text("nope"),
		}),
	)
	assert.equal(unknown.code, "safety.blocked")
	pass("Block unknown actions")

	const huge = "x".repeat(defaultAllowlist.limits.maxStringLength + 1)
	const hugeResult = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "project_info",
			args: { code: huge },
			callback: () => text("nope"),
		}),
	)
	assert.equal(hugeResult.code, "safety.invalid_args")
	pass("Reject oversized string arguments")

	let deep: Record<string, unknown> = {}
	for (let index = 0; index <= defaultAllowlist.limits.maxDepth; index += 1) {
		deep = { deep }
	}
	const deepResult = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "project_info",
			args: deep,
			callback: () => text("nope"),
		}),
	)
	assert.equal(deepResult.code, "safety.invalid_args")
	pass("Reject deeply nested arguments")

	const protoArgs = JSON.parse('{"__proto__":{"polluted":true}}')
	const protoResult = parseResponse(
		await unattended.guard({
			tool: "manage_editor",
			action: "project_info",
			args: protoArgs,
			callback: () => text("nope"),
		}),
	)
	assert.equal(protoResult.code, "safety.invalid_args")
	pass("Reject forbidden object keys")

	const timeoutAllowlist: Allowlist = {
		...defaultAllowlist,
		tools: {
			...defaultAllowlist.tools,
			test_timeout: { direct: { mode: "read", timeoutMs: 20 } },
		},
	}
	const timeoutGateway = createSafetyGateway({ ...baseConfig, allowlist: timeoutAllowlist })
	const timeoutResult = parseResponse(
		await timeoutGateway.guard({
			tool: "test_timeout",
			args: {},
			callback: () => new Promise((resolve) => setTimeout(() => resolve(text("late")), 100)),
		}),
	)
	assert.equal(timeoutResult.code, "safety.timeout")
	assert.equal(timeoutResult.state, "degraded")
	pass("Return a structured timeout and mark the session degraded")

	const circuitAllowlist: Allowlist = {
		...defaultAllowlist,
		tools: {
			...defaultAllowlist.tools,
			test_timeout: { direct: { mode: "read", timeoutMs: 10 } },
		},
	}
	const circuitGateway = createSafetyGateway({
		...baseConfig,
		allowlist: circuitAllowlist,
		profile: "supervised",
	})
	for (let index = 0; index < 3; index += 1) {
		await circuitGateway.guard({
			tool: "test_timeout",
			args: {},
			callback: () => new Promise((resolve) => setTimeout(() => resolve(text("late")), 30)),
		})
	}
	const circuitResult = parseResponse(
		await circuitGateway.guard({
			tool: "manage_editor",
			action: "start_pie",
			args: {},
			callback: () => text("started"),
		}),
	)
	assert.equal(circuitResult.code, "safety.circuit_open")
	pass("Open the circuit after repeated failures")

	const resetResult = await circuitGateway.guard({
		tool: "manage_editor",
		action: "project_info",
		args: {},
		callback: () => text("alive"),
	})
	assert.equal(extractText(resetResult), "alive")
	const afterReset = await circuitGateway.guard({
		tool: "manage_editor",
		action: "start_pie",
		args: {},
		callback: () => text("started"),
	})
	assert.equal(extractText(afterReset), "started")
	assert.equal(circuitGateway.getStatus().degraded, false)
	pass("Reset the circuit after a successful read")

	const auditText = fs.readFileSync(auditPath, "utf8")
	assert.match(auditText, /"tool":"manage_editor"/)
	assert.match(auditText, /"status":"blocked"/)
	assert.match(auditText, /"code":"safety.timeout"/)
	pass("Write audit events")

	const merged = mergeAllowlist(defaultAllowlist, {
		tools: {
			manage_editor: {
				actions: {
					project_info: { mode: "blocked" },
				},
			},
		},
	})
	assert.equal(resolvePolicy(merged, "manage_editor", "project_info").mode, "blocked")
	assert.equal(resolvePolicy(merged, "manage_editor", "map_info").mode, "read")
	pass("Merge an allowlist override without losing unrelated actions")

	const config = loadSafetyConfig({
		UEV_PROFILE: "supervised",
		UEV_READ_ONLY: "1",
		UEV_AUDIT_LOG: auditPath,
	})
	assert.equal(config.profile, "supervised")
	assert.equal(config.readOnly, true)
	assert.equal(config.auditPath, auditPath)
	assert.equal(config.supervisorPipe, "\\\\.\\pipe\\uev-supervisor")
	const disabledSupervisor = loadSafetyConfig({ UEV_SUPERVISOR: "0" })
	assert.equal(disabledSupervisor.supervisorPipe, undefined)
	pass("Load safety configuration from environment variables")

	const pipePath = `\\\\.\\pipe\\uev-supervisor-test-${process.pid}-${Date.now()}`
	const received: string[] = []
	const pipeServer = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			received.push(chunk.toString())
		})
	})
	await new Promise<void>((resolve, reject) => {
		pipeServer.once("error", reject)
		pipeServer.listen(pipePath, () => resolve())
	})
	const supervisorClient = createSupervisorClient({ pipePath, log: () => {} })
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("supervisor client did not connect")), 2000)
		timer.unref()
		pipeServer.once("connection", () => {
			clearTimeout(timer)
			resolve()
		})
	})
	supervisorClient.notifyCallStart({
		id: "test-call",
		tool: "manage_editor",
		action: "project_info",
		timeoutMs: 1000,
	})
	supervisorClient.notifyCallEnd("test-call")
	await new Promise((resolve) => setTimeout(resolve, 100))
	supervisorClient.close()
	await new Promise<void>((resolve) => pipeServer.close(() => resolve()))
	const receivedText = received.join("")
	assert.match(receivedText, /"type":"call_start"/)
	assert.match(receivedText, /"id":"test-call"/)
	assert.match(receivedText, /"type":"call_end"/)
	pass("Send supervisor call_start/call_end events")

	fs.rmSync(tempDir, { recursive: true, force: true })
	console.log("")
	console.log("Safety smoke test completed successfully.")
}

main().catch((error) => {
	console.error("")
	console.error(`Safety smoke test failed: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
