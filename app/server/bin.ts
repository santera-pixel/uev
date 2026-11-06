#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { projectVersion } from "./version.js"
import { envFlag, productTitle } from "./identity.js"
import { markStartup, startupSummary } from "./startup-timing.js"

const cliArgs = process.argv.slice(2)
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
	console.log(projectVersion)
	process.exit(0)
}

let shutdownInProgress = false
let shutdownRemoteExecution: (() => Promise<void>) | undefined
let shutdownSafety: (() => void) | undefined
let shutdownControlServer: (() => Promise<void>) | undefined

async function main() {
	const serverModule = await import("./")
	shutdownRemoteExecution = serverModule.shutdownRemoteExecution
	shutdownSafety = serverModule.shutdownSafety

	const controlEnabled = cliArgs.includes("--control") || envFlag("CONTROL")
	if (controlEnabled) {
		const { startControlServer } = await import("./control-server.js")
		const handle = await startControlServer({
			runtime: serverModule.sharedRuntime,
			context: serverModule.registrationContext,
		})
		shutdownControlServer = handle.close
	}

	const transport = new StdioServerTransport()
	await serverModule.server.connect(transport)
}

const shutdown = async () => {
	if (shutdownInProgress) {
		return
	}

	shutdownInProgress = true
	if (shutdownControlServer) {
		await shutdownControlServer()
		shutdownControlServer = undefined
	}
	shutdownSafety?.()
	if (shutdownRemoteExecution) {
		await shutdownRemoteExecution()
	}
}

process.once("SIGINT", () => {
	void shutdown().finally(() => process.exit(0))
})

process.once("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0))
})

process.once("beforeExit", () => {
	void shutdown()
})

process.once("exit", () => {
	void shutdown()
})

void main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`Failed to start ${productTitle}: ${message}`)
	process.exit(1)
})
