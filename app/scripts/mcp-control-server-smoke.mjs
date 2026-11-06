#!/usr/bin/env node

import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-mcp-control-"))
const descriptorPath = path.join(tempDir, "control.json")
const auditPath = path.join(tempDir, "audit.jsonl")
const historyPath = path.join(tempDir, "history.jsonl")

const fail = (message) => {
	throw new Error(message)
}

const assert = (condition, message) => {
	if (!condition) {
		fail(message)
	}
}

const assertEqual = (actual, expected, message) => {
	if (actual !== expected) {
		fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
	}
}

const logPass = (name, detail = "") => {
	const suffix = detail ? `: ${detail}` : ""
	console.log(`[PASS] ${name}${suffix}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForDescriptor = async (timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (fs.existsSync(descriptorPath)) {
			try {
				return JSON.parse(fs.readFileSync(descriptorPath, "utf8"))
			} catch {
				// Keep waiting for a complete write.
			}
		}
		await delay(100)
	}

	fail(`Control descriptor was not written at ${descriptorPath}.`)
}

const request = async (url, { method = "GET", token, body, headers = {} } = {}) => {
	const requestHeaders = { ...headers }
	if (token) {
		requestHeaders.Authorization = `Bearer ${token}`
	}
	if (body !== undefined) {
		requestHeaders["Content-Type"] = "application/json"
	}

	const response = await fetch(url, {
		method,
		headers: requestHeaders,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()

	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}

	return { status: response.status, text, json }
}

async function main() {
	if (!fs.existsSync(serverEntry)) {
		fail(`Built MCP server entry not found at ${serverEntry}. Run "npm run build" first.`)
	}

	const child = spawn(process.execPath, [serverEntry, "--control"], {
		cwd: repoRoot,
		env: {
			...process.env,
			UEV_CONTROL_PORT: "0",
			UEV_CONTROL_DESCRIPTOR: descriptorPath,
			UEV_SUPERVISOR: "0",
			UEV_PROFILE: "unattended",
			UEV_AUDIT_LOG: auditPath,
			UEV_HISTORY_LOG: historyPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	})

	const stderrLines = []
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString()
		if (text) {
			stderrLines.push(...text.split(/\r?\n/).filter(Boolean))
			while (stderrLines.length > 40) {
				stderrLines.shift()
			}
		}
	})
	child.on("error", (error) => {
		stderrLines.push(`process error: ${error.message}`)
	})

	try {
		const descriptor = await waitForDescriptor()
		assert(Number.isInteger(descriptor.port) && descriptor.port > 0, "Control descriptor has no valid port.")
		assert(typeof descriptor.token === "string" && descriptor.token.length >= 32, "Control descriptor has no token.")
		logPass("Control descriptor", `127.0.0.1:${descriptor.port}`)

		const base = `http://127.0.0.1:${descriptor.port}`
		const token = descriptor.token

		let result = await request(`${base}/api/health`)
		assertEqual(result.status, 401, "Missing token must be rejected")
		logPass("Reject missing bearer token")

		result = await request(`${base}/api/health`, { token: "wrong-token" })
		assertEqual(result.status, 401, "Invalid token must be rejected")

		result = await request(`${base}/api/health`, {
			token,
			headers: { Origin: "http://example.invalid" },
		})
		assertEqual(result.status, 403, "Browser-origin requests must be rejected")
		logPass("Reject browser-origin requests")

		result = await request(`${base}/api/health`, { token })
		assertEqual(result.status, 200, "Health request failed")
		assertEqual(result.json?.ok, true, "Health response is not ok")
		assertEqual(result.json?.profile, "unattended", "Unexpected safety profile")
		logPass("Health", `profile=${result.json.profile}`)

		result = await request(`${base}/api/catalog`, { token })
		assertEqual(result.status, 200, "Catalog request failed")
		const tools = result.json?.tools
		assert(Array.isArray(tools) && tools.length > 0, "Catalog has no tools")

		const historyTool = tools.find((tool) => tool.name === "manage_history")
		assert(historyTool, "Catalog is missing manage_history")
		const historyStatus = historyTool.actions.find((action) => action.name === "status")
		assert(historyStatus, "manage_history.status is missing from the catalog")
		assertEqual(historyStatus.mode, "read", "manage_history.status must be read")
		assertEqual(historyStatus.allowed, true, "manage_history.status must be allowed in unattended")

		const actorTool = tools.find((tool) => tool.name === "manage_actor")
		assert(actorTool, "Catalog is missing manage_actor")
		const actorSpawn = actorTool.actions.find((action) => action.name === "spawn")
		assert(actorSpawn, "manage_actor.spawn is missing from the catalog")
		assertEqual(actorSpawn.mode, "write", "manage_actor.spawn must be a write")
		assertEqual(actorSpawn.allowed, false, "manage_actor.spawn must be blocked in unattended")
		logPass("Catalog and policy metadata", `${tools.length} tools`)

		result = await request(`${base}/api/call`, {
			token,
			method: "POST",
			body: { tool: "manage_history", action: "status", params: {} },
		})
		assertEqual(result.status, 200, "Direct handler call failed")
		assertEqual(result.json?.ok, true, "Direct handler call did not succeed")
		assert(
			typeof result.json?.text === "string" && result.json.text.includes('"entryCount"'),
			"Direct handler response does not look like manage_history.status",
		)
		logPass("Call existing handler directly")

		result = await request(`${base}/api/call`, {
			token,
			method: "POST",
			body: { tool: "manage_actor", action: "spawn", params: { name: "MCP_Smoke_Blocked" } },
		})
		assertEqual(result.status, 200, "Blocked call should return a structured response")
		assertEqual(result.json?.ok, false, `Blocked call must report ok=false; text=${result.json?.text}`)
		assert(
			typeof result.json?.text === "string" &&
				(result.json.text.includes('"success": false') || result.json.text.includes('"success":false')) &&
				result.json.text.toLowerCase().includes("safety"),
			"Blocked call did not return a safety failure",
		)
		logPass("Blocked write returns a structured failure")

		result = await request(`${base}/api/history?limit=5`, { token })
		assertEqual(result.status, 200, "History request failed")
		assert(Array.isArray(result.json?.entries), "History response has no entries array")
		assert(result.json.entries.length >= 1, "History response is empty after a call")
		logPass("History", `${result.json.entries.length} entries`)

		result = await request(`${base}/api/call`, {
			token,
			method: "POST",
			body: { tool: "not_a_tool", action: "nope", params: {} },
		})
		assertEqual(result.status, 404, "Unknown tools must return 404")

		result = await request(`${base}/api/panic`, {
			token,
			method: "POST",
			body: { reason: "control-server smoke" },
		})
		assertEqual(result.status, 409, "Panic must reject when the supervisor is disabled")
		logPass("Panic rejects when the supervisor is disabled")
	} catch (error) {
		if (stderrLines.length > 0) {
			console.error("Control server stderr:")
			for (const line of stderrLines) {
				console.error(`  ${line}`)
			}
		}
		throw error
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGTERM")
			await Promise.race([once(child, "exit"), delay(5000)])
		}
		if (child.exitCode === null) {
			child.kill("SIGKILL")
			await Promise.race([once(child, "exit"), delay(2000)])
		}
		fs.rmSync(tempDir, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error))
	process.exitCode = 1
})
