import os from "node:os"

import { RemoteExecution, RemoteExecutionConfig } from "unreal-remote-execution"

import { getCallContext } from "./safety/context.js"
import { envValue } from "./identity.js"

const DEFAULT_MULTICAST_TTL = 1
const DEFAULT_MULTICAST_ADDRESS = "239.0.0.1"
const DEFAULT_MULTICAST_PORT = 6766
const DEFAULT_COMMAND_PORT = 6776
const DEFAULT_RETRY_COUNT = 3
const DEFAULT_RETRY_DELAY_MS = 2000
const TRANSACTION_MARKER = "# MCP_SCRIPT_BODY_START"

interface RemoteExecutionInfo {
	bindAddress: string
	commandAddress: string
	commandPort: number
	multicastAddress: string
	multicastPort: number
	multicastTTL: number
}

interface LastCommandStatus {
	commandPreview: string
	startedAt: string
	durationMs: number
	success: boolean
	error?: string
	transactional?: boolean
	transactionWrapped?: boolean
}

let remoteExecutionInfo: RemoteExecutionInfo | undefined
let lastCommandStatus: LastCommandStatus | undefined
let lastRemoteError: string | undefined

const wrapTransactionalCommand = (command: string, label: string): string => {
	const markerIndex = command.indexOf(TRANSACTION_MARKER)
	if (markerIndex < 0) {
		return command
	}

	const preludeEnd = markerIndex + TRANSACTION_MARKER.length
	const prelude = command.slice(0, preludeEnd)
	const body = command.slice(preludeEnd).replace(/^\r?\n/, "")
	if (!body.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#"))) {
		return command
	}

	const indentedBody = body
		.split(/\r?\n/)
		.map((line) => (line.length > 0 ? `    ${line}` : line))
		.join("\n")
	const labelLiteral = JSON.stringify(label)

	return [
		prelude,
		"import unreal as _mcp_unreal",
		`_mcp_label = ${labelLiteral}`,
		"_mcp_use_plugin = hasattr(_mcp_unreal, 'UEVLibrary')",
		"_mcp_txn_started = False",
		"if _mcp_use_plugin:",
		"    _mcp_txn_started = bool(_mcp_unreal.UEVLibrary.begin_transaction(_mcp_label))",
		"if not _mcp_txn_started:",
		"    _mcp_use_plugin = False",
		"    _mcp_txn = _mcp_unreal.ScopedEditorTransaction(_mcp_label)",
		"    _mcp_txn.__enter__()",
		"try:",
		indentedBody,
		"except BaseException:",
		"    if _mcp_use_plugin:",
		"        _mcp_unreal.UEVLibrary.cancel_transaction()",
		"    else:",
		"        _mcp_txn.cancel()",
		"    raise",
		"else:",
		"    if _mcp_use_plugin:",
		"        _mcp_unreal.UEVLibrary.end_transaction()",
		"    else:",
		"        _mcp_txn.__exit__(None, None, None)",
	].join("\n")
}

const readIntegerEnv = (name: string, fallback: number) => {
	const value = envValue(name)
	if (!value) {
		return fallback
	}

	const parsedValue = Number.parseInt(value, 10)
	return Number.isFinite(parsedValue) ? parsedValue : fallback
}

const readStringEnv = (name: string) => {
	const value = envValue(name)
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

const resolveRemoteExecutionBindAddress = () => {
	const override = readStringEnv("BIND_ADDRESS")
	if (override) {
		return override
	}

	// With multicast TTL 0 packets never leave the host, so they only arrive
	// on the loopback interface. Binding to a random NIC address in that mode
	// makes every command time out ("Could not find a node within the given
	// time"). Prefer loopback unless the user explicitly opted into a LAN bind.
	const multicastTTL = readIntegerEnv("MULTICAST_TTL", DEFAULT_MULTICAST_TTL)
	if (multicastTTL <= 0) {
		return "127.0.0.1"
	}

	const interfaces = os.networkInterfaces()
	for (const networkInterface of Object.values(interfaces)) {
		for (const addressInfo of networkInterface ?? []) {
			// Skip link-local APIPA addresses: they are not routable and are a
			// common first entry when VPN or virtual adapters are installed.
			if (
				addressInfo.family === "IPv4" &&
				!addressInfo.internal &&
				!addressInfo.address.startsWith("169.254.")
			) {
				return addressInfo.address
			}
		}
	}

	return "127.0.0.1"
}

const createRemoteExecutionConfig = () => {
	const multicastTTL = readIntegerEnv("MULTICAST_TTL", DEFAULT_MULTICAST_TTL)
	const multicastAddress =
		readStringEnv("MULTICAST_ADDRESS") ?? DEFAULT_MULTICAST_ADDRESS
	const multicastPort = readIntegerEnv("MULTICAST_PORT", DEFAULT_MULTICAST_PORT)
	const bindAddress = resolveRemoteExecutionBindAddress()
	const commandAddress = readStringEnv("COMMAND_ADDRESS") ?? bindAddress
	const commandPort = readIntegerEnv("COMMAND_PORT", DEFAULT_COMMAND_PORT)

	return {
		bindAddress,
		commandAddress,
		commandPort,
		multicastAddress,
		multicastPort,
		multicastTTL,
		config: new RemoteExecutionConfig(
			multicastTTL,
			[multicastAddress, multicastPort],
			bindAddress,
			[commandAddress, commandPort],
		),
	}
}

let remoteExecution: RemoteExecution | undefined = undefined
let remoteExecutionStartPromise: Promise<void> | undefined = undefined
let remoteConnectionPromise: Promise<RemoteExecution> | undefined = undefined
let autoLaunchHandler: (() => Promise<unknown>) | undefined = undefined

export const setAutoLaunchHandler = (handler: (() => Promise<unknown>) | undefined) => {
	autoLaunchHandler = handler
}

const ensureRemoteExecutionStarted = async () => {
	if (!remoteExecution) {
		const { bindAddress, commandAddress, commandPort, multicastAddress, multicastPort, multicastTTL, config } =
			createRemoteExecutionConfig()
		remoteExecutionInfo = {
			bindAddress,
			commandAddress,
			commandPort,
			multicastAddress,
			multicastPort,
			multicastTTL,
		}
		remoteExecution = new RemoteExecution(config)
		console.error(
			`Using Unreal Remote Execution bind address: ${bindAddress} (command: ${commandAddress}:${commandPort})`,
		)
	}

	if (!remoteExecutionStartPromise) {
		const runtime = remoteExecution
		remoteExecutionStartPromise = runtime
			.start()
			.catch((error) => {
				if (remoteExecution === runtime) {
					remoteExecution = undefined
				}
				throw error
			})
			.finally(() => {
				remoteExecutionStartPromise = undefined
			})
	}

	await remoteExecutionStartPromise
	return remoteExecution!
}

const connectWithRetry = async (
	maxRetries: number = readIntegerEnv("RETRY_COUNT", DEFAULT_RETRY_COUNT),
	retryDelay: number = readIntegerEnv("RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS),
) => {
	const runtime = await ensureRemoteExecutionStarted()
	let lastError: unknown = undefined

	for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
		try {
			const node = await runtime.getFirstRemoteNode(1000, 5000)
			await runtime.openCommandConnection(node)

			const result = await runtime.runCommand('print("rrmcp:init")')
			if (!result.success) {
				throw new Error(`Failed to run command: ${JSON.stringify(result.result)}`)
			}

			return runtime
		} catch (error) {
			lastError = error
			lastRemoteError = error instanceof Error ? error.message : String(error)
			console.error(`Connection attempt ${attempt} failed:`, error)

			try {
				if (runtime.hasCommandConnection()) {
					runtime.closeCommandConnection()
				}
			} catch (closeError) {
				console.error("Failed to close Unreal command connection after a failed attempt:", closeError)
			}

			if (attempt < maxRetries) {
				console.error(`Retrying in ${retryDelay}ms...`)
				await new Promise((resolve) => setTimeout(resolve, retryDelay))
				retryDelay = Math.min(retryDelay * 1.5, 10000)
			}
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("Unable to connect to your Unreal Engine Editor after multiple attempts")
}

const ensureRemoteConnection = async () => {
	if (remoteExecution?.hasCommandConnection()) {
		return remoteExecution
	}

	if (!remoteConnectionPromise) {
		remoteConnectionPromise = (async () => {
			let retriedAfterAutoLaunch = false
			while (true) {
				try {
					return await connectWithRetry()
				} catch (error) {
					if (retriedAfterAutoLaunch || !autoLaunchHandler) {
						throw error
					}
					retriedAfterAutoLaunch = true
					try {
						await autoLaunchHandler()
					} catch {
						throw error
					}
				}
			}
		})().finally(() => {
			if (!remoteExecution?.hasCommandConnection()) {
				remoteConnectionPromise = undefined
			}
		})
	}

	return remoteConnectionPromise
}

export const shutdownRemoteExecution = async () => {
	const runtime = remoteExecution
	remoteExecution = undefined
	remoteExecutionStartPromise = undefined
	remoteConnectionPromise = undefined

	if (!runtime) {
		return
	}

	try {
		if (runtime.hasCommandConnection()) {
			runtime.closeCommandConnection()
		}
	} catch (error) {
		console.error("Failed to close Unreal command connection during shutdown:", error)
	}

	try {
		runtime.stop()
	} catch (error) {
		console.error("Failed to stop Unreal Remote Execution during shutdown:", error)
	}
}

export const tryRunCommand = async (command: string): Promise<string> => {
	const runtime = await ensureRemoteConnection()
	const callContext = getCallContext()
	// A retry can duplicate a mutation. The safety gateway marks only reads as retryable.
	const allowRetry = callContext?.allowRetry ?? false
	const commandToRun =
		callContext?.transactional
			? wrapTransactionalCommand(
					command,
					callContext.transactionLabel ??
						`MCP: ${callContext.tool}${callContext.action ? `.${callContext.action}` : ""}`,
				)
			: command
	const transactionWrapped = commandToRun !== command
	const startedAt = Date.now()
	const commandPreview = command.slice(0, 200)

	try {
		const result = await runtime.runCommand(commandToRun)
		if (!result.success) {
			throw new Error(`Command failed with: ${result.result}`)
		}

		lastCommandStatus = {
			commandPreview,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			success: true,
			transactional: callContext?.transactional ?? false,
			transactionWrapped,
		}
		lastRemoteError = undefined
		return result.output.map((line) => line.output).join("\n")
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		lastCommandStatus = {
			commandPreview,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			success: false,
			error: message,
			transactional: callContext?.transactional ?? false,
			transactionWrapped,
		}
		lastRemoteError = message

		try {
			if (runtime.hasCommandConnection()) {
				runtime.closeCommandConnection()
			}
		} catch (closeError) {
			console.error("Failed to close stale Unreal command connection:", closeError)
		}

		remoteConnectionPromise = undefined
		const channelUnavailable = /no command channel open|command channel/i.test(message)
		if (!allowRetry && !channelUnavailable) {
			throw error instanceof Error ? error : new Error(String(error))
		}
		if (channelUnavailable) {
			// The command never reached the editor, so a reconnect + retry is safe
			// even for writes. This is the common PIE start/stop transition race.
			await new Promise((resolve) => setTimeout(resolve, 250))
		}

		const retryRuntime = await ensureRemoteConnection()
		const retryResult = await retryRuntime.runCommand(commandToRun)
		if (!retryResult.success) {
			throw error instanceof Error ? error : new Error(String(error))
		}

		lastCommandStatus = {
			commandPreview,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			success: true,
			transactional: callContext?.transactional ?? false,
			transactionWrapped,
		}
		lastRemoteError = undefined
		return retryResult.output.map((line) => line.output).join("\n")
	}
}

export const getRemoteExecutionStatus = () => ({
	started: Boolean(remoteExecution),
	connected: remoteExecution?.hasCommandConnection() ?? false,
	...remoteExecutionInfo,
	lastCommand: lastCommandStatus,
	lastError: lastRemoteError,
})

export const discoverPath = async (command: string, errorMessage: string) => {
	const output = await tryRunCommand(command)
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	const discoveredPath = lines.length > 0 ? lines[lines.length - 1] : ""

	if (!discoveredPath || discoveredPath === "None") {
		throw new Error(errorMessage)
	}

	return discoveredPath
}
