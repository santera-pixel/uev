import { randomUUID } from "node:crypto"

import { appendAudit, hashArgs } from "./audit.js"
import { decidePolicy, resolvePolicy } from "./allowlist.js"
import { runWithCallContext, type CallContext } from "./context.js"
import { createHistoryJournal, type HistoryJournal } from "./history.js"
import { createSupervisorClient } from "./supervisor-client.js"
import type { ActionPolicy, SafetyConfig, SafetyStatus } from "./types.js"
import { validateToolArgs } from "./validation.js"

export interface SafetyGuardOptions {
	tool: string
	action?: string
	args: unknown
	callback: () => unknown | Promise<unknown>
}

export interface SafetyGateway {
	guard: (options: SafetyGuardOptions) => Promise<unknown>
	getStatus: () => SafetyStatus
	history: HistoryJournal
	supervisorPanic: (reason: string) => void
	getSupervisorStatus: () => Promise<Record<string, unknown>>
	resetCircuit: () => void
	close: () => void
}

class SafetyTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Tool call timed out after ${timeoutMs}ms.`)
		this.name = "SafetyTimeoutError"
	}
}

const textResponse = (text: string) => ({
	content: [{ type: "text" as const, text }],
})

const jsonResponse = (payload: Record<string, unknown>) => textResponse(JSON.stringify(payload, null, 2))

const byteLength = (value: unknown): number => {
	try {
		return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8")
	} catch {
		return -1
	}
}

const withTimeout = async <T>(callback: () => Promise<T> | T, timeoutMs: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SafetyTimeoutError(timeoutMs)), timeoutMs)
	})

	try {
		return await Promise.race([Promise.resolve().then(callback), timeout])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}

export const createSafetyGateway = (config: SafetyConfig): SafetyGateway => {
	let consecutiveFailures = 0
	let degraded = false
	const supervisor = config.supervisorPipe
		? createSupervisorClient({ pipePath: config.supervisorPipe })
		: undefined
	const history = createHistoryJournal({ path: config.historyPath })

	const resolveUndo = (policy: ActionPolicy) =>
		policy.undo ?? (policy.mode === "read" || policy.transactional === false ? "none" : "native")

	const summarizeArgs = (value: unknown): string | undefined => {
		try {
			const text = JSON.stringify(value ?? {})
			return text.length > 2048 ? `${text.slice(0, 2048)}...` : text
		} catch {
			return undefined
		}
	}

	const summarizeResult = (result: unknown): string => {
		const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content
		if (!Array.isArray(content)) {
			return "ok"
		}

		const text = content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
		return typeof text === "string" ? text.slice(0, 4096) : "ok"
	}

	const extractCode = (tool: string, action: string | undefined, args: unknown): string | undefined => {
		if (tool !== "manage_editor" || action !== "run_python") {
			return undefined
		}

		const code = (args as { code?: unknown })?.code
		return typeof code === "string" ? code.slice(0, 16 * 1024) : undefined
	}

	const record = (
		tool: string,
		action: string | undefined,
		mode: SafetyConfig["allowlist"]["defaultMode"],
		status: "blocked" | "success" | "error" | "timeout",
		startedAt: number,
		argsBytes: number,
		argsHash: string,
		code?: string,
		message?: string,
	) => {
		appendAudit(config.auditPath, {
			timestamp: new Date().toISOString(),
			tool,
			action,
			profile: config.profile,
			mode,
			status,
			durationMs: Date.now() - startedAt,
			argsBytes,
			argsHash,
			code,
			message,
		})
	}

	const guard = async ({ tool, action, args, callback }: SafetyGuardOptions): Promise<unknown> => {
		const startedAt = Date.now()
		const argsBytes = byteLength(args)
		const argsHash = hashArgs(args)
		const policy = resolvePolicy(config.allowlist, tool, action)
		const decision = decidePolicy(config.profile, policy, config.readOnly)
		const undo = resolveUndo(policy)
		const transactional = policy.mode !== "read" && (policy.transactional ?? undo === "native")

		if (!decision.allowed) {
			record(tool, action, policy.mode, "blocked", startedAt, argsBytes, argsHash, "safety.blocked", decision.reason)
			return jsonResponse({
				success: false,
				code: "safety.blocked",
				tool,
				action,
				profile: config.profile,
				mode: policy.mode,
				message: decision.reason,
				hint: "Use UEV_PROFILE=supervised for write actions, or extend the allowlist if this is intentional.",
			})
		}

		if (policy.mode !== "read" && degraded && !policy.recovery) {
			record(
				tool,
				action,
				policy.mode,
				"blocked",
				startedAt,
				argsBytes,
				argsHash,
				"safety.circuit_open",
				"Mutating actions are paused after repeated failures.",
			)
			return jsonResponse({
				success: false,
				code: "safety.circuit_open",
				tool,
				action,
				profile: config.profile,
				mode: policy.mode,
				message: "Mutating actions are paused after repeated failures. Run a successful read to reset, or restart the server.",
			})
		}

		const validation = validateToolArgs(args, config.allowlist.limits)
		if (!validation.ok) {
			record(tool, action, policy.mode, "blocked", startedAt, argsBytes, argsHash, validation.code, validation.message)
			return jsonResponse({
				success: false,
				code: validation.code,
				tool,
				action,
				profile: config.profile,
				mode: policy.mode,
				message: validation.message,
			})
		}

		const pluginRegistry = config.pluginRegistry
		if (pluginRegistry) {
			const requirements = pluginRegistry.requirementsFor(tool, action)
			if (requirements.length > 0) {
				let availability
				try {
					availability = await pluginRegistry.ensureAvailability()
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					record(
						tool,
						action,
						policy.mode,
						"blocked",
						startedAt,
						argsBytes,
						argsHash,
						"plugin.probe_failed",
						message,
					)
					return jsonResponse({
						success: false,
						code: "plugin.probe_failed",
						tool,
						action,
						profile: config.profile,
						mode: policy.mode,
						message,
						hint: "The plugin availability probe could not reach the editor. Start the editor and retry, or run manage_debug.refresh_plugins.",
					})
				}

				const missing = pluginRegistry.missingRequirements(requirements, availability)
				if (missing.length > 0) {
					const message = `This action requires ${missing.map((requirement) => `${requirement.kind} ${requirement.name}`).join(", ")}.`
					record(
						tool,
						action,
						policy.mode,
						"blocked",
						startedAt,
						argsBytes,
						argsHash,
						"plugin.unavailable",
						message,
					)
					return jsonResponse({
						success: false,
						code: "plugin.unavailable",
						tool,
						action,
						profile: config.profile,
						mode: policy.mode,
						missing,
						availablePlugins: availability.plugins,
						availableModules: availability.modules,
						message,
						hint: "Enable the plugin or module in the project manifest, or use an action that does not require it.",
					})
				}
			}
		}

		const timeoutMs = Math.min(
			policy.timeoutMs ?? config.allowlist.limits.defaultCallTimeoutMs,
			config.allowlist.limits.maxCallTimeoutMs,
		)
		const callId = randomUUID()
		const transactionLabel = transactional
			? `MCP: ${tool}${action ? `.${action}` : ""} ${callId}`
			: undefined
		supervisor?.notifyCallStart({ id: callId, tool, action, timeoutMs })

		const callContext: CallContext = {
			tool,
			action,
			mode: policy.mode,
			profile: config.profile,
			allowRetry: policy.mode === "read" && !config.readOnly,
			callId,
			transactional,
			transactionLabel,
		}

		try {
			const result = await runWithCallContext(callContext, () => withTimeout(callback, timeoutMs))

			consecutiveFailures = 0
			degraded = false
			record(tool, action, policy.mode, "success", startedAt, argsBytes, argsHash)
			history.appendCall({
				id: callId,
				tool,
				action,
				mode: policy.mode,
				profile: config.profile,
				status: "success",
				durationMs: Date.now() - startedAt,
				argsHash,
				argsPreview: summarizeArgs(args),
				code: extractCode(tool, action, args),
				resultSummary: summarizeResult(result),
				undo: callContext.history?.undo ?? undo,
				inverse: callContext.history?.inverse,
				forward: callContext.history?.forward,
				transactionLabel,
			})

			if (
				tool === "manage_history" &&
				(action === "undo" || action === "redo") &&
				typeof (args as { targetId?: unknown })?.targetId === "string"
			) {
				history.appendEvent({
					type: action,
					targetId: (args as { targetId: string }).targetId,
					status: "success",
				})
			}

			if (tool === "manage_debug" && action === "reset") {
				consecutiveFailures = 0
				degraded = false
			}

			return result
		} catch (error) {
			const isTimeout = error instanceof SafetyTimeoutError
			const message = error instanceof Error ? error.message : String(error)
			consecutiveFailures += 1
			if (isTimeout || consecutiveFailures >= 3) {
				degraded = true
			}

			record(
				tool,
				action,
				policy.mode,
				isTimeout ? "timeout" : "error",
				startedAt,
				argsBytes,
				argsHash,
				isTimeout ? "safety.timeout" : "safety.error",
				message,
			)
			history.appendCall({
				id: callId,
				tool,
				action,
				mode: policy.mode,
				profile: config.profile,
				status: isTimeout ? "timeout" : "error",
				durationMs: Date.now() - startedAt,
				argsHash,
				argsPreview: summarizeArgs(args),
				code: extractCode(tool, action, args),
				resultSummary: message,
				undo,
				transactionLabel,
			})

			return jsonResponse({
				success: false,
				code: isTimeout ? "safety.timeout" : "safety.error",
				tool,
				action,
				profile: config.profile,
				mode: policy.mode,
				message,
				retry_recommended: !isTimeout && policy.mode === "read",
				state: degraded ? "degraded" : "unknown",
			})
		} finally {
			supervisor?.notifyCallEnd(callId)
		}
	}

	return {
		guard,
		getStatus: () => {
			const historyStatus = history.getStatus()
			return {
				profile: config.profile,
				readOnly: config.readOnly,
				degraded,
				consecutiveFailures,
				allowlistVersion: config.allowlist.version,
				auditPath: config.auditPath,
				historyPath: config.historyPath,
				sessionId: historyStatus.sessionId,
				supervisor: supervisor?.getStatus(),
			}
		},
		history,
		supervisorPanic: (reason) => supervisor?.panic(reason),
		getSupervisorStatus: () =>
			supervisor?.requestStatus(2000) ??
			Promise.resolve({ connected: false, message: "Supervisor is disabled." }),
		resetCircuit: () => {
			consecutiveFailures = 0
			degraded = false
		},
		close: () => {
			supervisor?.close()
		},
	}
}
