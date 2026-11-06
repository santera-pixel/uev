import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"

import type { RegistrationContext, RegistrationRuntime } from "./registration-context.js"
import type { NamespaceActionParam } from "./registration-context-dispatch.js"
import { decidePolicy, resolvePolicy } from "./safety/index.js"
import { engineIdentity } from "./compatibility.js"
import { engineCompatibility, productVersion, projectVersion, protocolVersion, serverVersion } from "./version.js"
import { envValue, installRootFolder, productName, productSlug, productTitle, stateDirName } from "./identity.js"
import { markStartup, startupReport } from "./startup-timing.js"

const HOST = "127.0.0.1"
const DEFAULT_PORT = 8765
const SUPERVISOR_STATUS_TTL_MS = 1000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_HISTORY_LIMIT = 200

export interface StartControlServerOptions {
	runtime: RegistrationRuntime
	context: RegistrationContext
	host?: string
	port?: number
	descriptorPath?: string
	token?: string
}

interface ActiveCall {
	id: string
	tool: string
	action?: string
	startedAt: string
	controller: AbortController
}

export interface ControlServerHandle {
	host: string
	port: number
	token: string
	descriptorPath: string
	close: () => Promise<void>
}

interface ActionView {
	name: string
	mode: string
	allowed: boolean
	reason?: string
	note?: string
	undo?: string
	transactional?: boolean
	timeoutMs?: number
	/**
	 * True when the action's params schema declares a boolean `dry_run` flag, i.e. the action can
	 * answer with a preview (wouldDo/affected/warnings) instead of mutating the editor.
	 * Derived from the recorded params schema because the namespace registry does not yet carry an
	 * explicit capability flag; see the 1.5.0 integration notes.
	 */
	supportsDryRun: boolean
	params?: NamespaceActionParam[]
}

interface ToolView {
	name: string
	description: string
	kind: "namespace" | "direct"
	actions: ActionView[]
	direct?: ActionView
}

interface CatalogView {
	version: string
	productName: string
	productTitle: string
	productSlug: string
	productVersion: string
	serverVersion: string
	protocolVersion: number
	engine: typeof engineCompatibility
	profile: string
	readOnly: boolean
	allowlistVersion: number
	tools: ToolView[]
}

const parsePort = (value: string | undefined): number | undefined => {
	if (!value?.trim()) {
		return undefined
	}

	const port = Number(value)
	return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined
}

const defaultDescriptorPath = (): string => {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")
		return path.join(localAppData, installRootFolder, "control.json")
	}

	return path.join(os.homedir(), stateDirName, "control.json")
}

const extractTextContent = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
	if (!Array.isArray(content)) {
		try {
			return JSON.stringify(result, null, 2)
		} catch {
			return String(result)
		}
	}

	return content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim()
}

const textIndicatesFailure = (text: string): boolean => {
	if (/(^|\n)\s*Traceback \(most recent call last\):/.test(text)) {
		return true
	}
	if (/(^|\n)\s*(Error|Exception):/.test(text)) {
		return true
	}
	try {
		const parsed = JSON.parse(text)
		return Boolean(
			parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				(parsed as { success?: unknown }).success === false,
		)
	} catch {
		return false
	}
}

const sendJsonBody = (res: ServerResponse, status: number, body: string) => {
	res.statusCode = status
	res.setHeader("Content-Type", "application/json; charset=utf-8")
	res.setHeader("Content-Length", Buffer.byteLength(body))
	res.end(body)
}

/**
 * `compact` serialises without indentation. The catalog is a fixed, large document that clients
 * parse anyway, so pretty-printing it doubles the bytes on the wire and the CPU it costs to send.
 */
const sendJson = (res: ServerResponse, status: number, payload: unknown, compact = false) => {
	sendJsonBody(res, status, compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2))
}

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = []
	let total = 0

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		total += buffer.length
		if (total > MAX_BODY_BYTES) {
			throw new Error("Request body exceeds the 1 MB limit.")
		}
		chunks.push(buffer)
	}

	if (total === 0) {
		return {}
	}

	return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

/**
 * An action advertises dry-run support by declaring a boolean `dry_run` parameter. The panel only
 * offers (and only forwards) dry runs for actions where this is true; anything else is rejected with
 * `dry_run_unsupported` rather than silently executing.
 */
const declaresDryRun = (params?: NamespaceActionParam[]): boolean =>
	Array.isArray(params) && params.some((param) => param.name === "dry_run" && param.type === "boolean")

const actionView = (
	runtime: RegistrationRuntime,
	tool: string,
	action: string | undefined,
	params?: NamespaceActionParam[],
): ActionView => {
	const policy = resolvePolicy(runtime.safetyConfig.allowlist, tool, action)
	const decision = decidePolicy(runtime.safetyConfig.profile, policy, runtime.safetyConfig.readOnly)

	return {
		name: action ?? tool,
		mode: policy.mode,
		allowed: decision.allowed,
		reason: decision.allowed ? undefined : decision.reason,
		note: policy.note,
		undo: policy.undo,
		transactional: policy.transactional,
		timeoutMs: policy.timeoutMs,
		supportsDryRun: declaresDryRun(params),
		params,
	}
}

const buildCatalog = (runtime: RegistrationRuntime, context: RegistrationContext): CatalogView => {
	const tools = Array.from(context.toolHandlerRegistry.values())
		.filter((tool) => !tool.hidden)
		.map((tool): ToolView => {
			const namespace = context.toolNamespaceRegistry.get(tool.name)
			const actions = (namespace?.supportedActions ?? []).map((action) =>
				actionView(runtime, tool.name, action, namespace?.params[action]),
			)
			const isNamespace = tool.kind === "namespace"

			return {
				name: tool.name,
				description: tool.description,
				kind: tool.kind,
				actions,
				direct: isNamespace ? undefined : actionView(runtime, tool.name, undefined),
			}
		})
		.sort((left, right) => left.name.localeCompare(right.name))

	return {
		version: projectVersion,
		productName,
		productTitle,
		productSlug,
		productVersion,
		serverVersion,
		protocolVersion,
		engine: engineCompatibility,
		profile: runtime.safetyConfig.profile,
		readOnly: runtime.safetyConfig.readOnly,
		allowlistVersion: runtime.safetyConfig.allowlist.version,
		tools,
	}
}

const isAuthorized = (req: IncomingMessage, token: string): boolean => {
	const authorization = req.headers.authorization
	return typeof authorization === "string" && authorization === `Bearer ${token}`
}

const handleRequest = async (
	req: IncomingMessage,
	res: ServerResponse,
	options: {
		token: string
		runtime: RegistrationRuntime
		context: RegistrationContext
		getCatalog: () => CatalogView
		/** Serialised catalog, built once per process. */
		getCatalogJson: () => string
		/** Supervisor status, cached briefly so the ping path never waits on the pipe. */
		getSupervisorStatus: () => Promise<Record<string, unknown> | undefined>
		startedAt: string
		getPort: () => number
		activeCalls: Map<string, ActiveCall>
	},
) => {
	if (req.headers.origin) {
		sendJson(res, 403, { ok: false, error: "Browser-origin requests are not allowed." })
		return
	}

	if (!isAuthorized(req, options.token)) {
		sendJson(res, 401, { ok: false, error: "Unauthorized." })
		return
	}

	const url = new URL(req.url ?? "/", `http://${HOST}`)
	const method = req.method ?? "GET"

	if (method === "GET" && url.pathname === "/api/health") {
		const safety = options.runtime.safety.getStatus()
		let supervisor: Record<string, unknown> =
			(safety.supervisor as Record<string, unknown> | undefined) ?? {
				connected: false,
				message: "Supervisor is disabled.",
			}
		try {
			const details = await options.getSupervisorStatus()
			if (details && typeof details === "object") {
				const detailsRecord = details as Record<string, unknown>
				supervisor = {
					...supervisor,
					...detailsRecord,
					connected: detailsRecord.connected ?? detailsRecord.ok ?? supervisor.connected ?? false,
				}
			}
		} catch (error) {
			supervisor = {
				...supervisor,
				connected: false,
				message: error instanceof Error ? error.message : String(error),
			}
		}

		sendJson(res, 200, {
			ok: true,
			productName,
			productTitle,
			productSlug,
			version: projectVersion,
			productVersion,
			serverVersion,
			protocolVersion,
			engine: engineCompatibility,
			engineIdentity: engineIdentity(
				typeof (safety as unknown as { engineVersion?: unknown }).engineVersion === "string"
					? (safety as unknown as { engineVersion: string }).engineVersion
					: undefined,
			),
			pid: process.pid,
			startedAt: options.startedAt,
			controlPort: options.getPort(),
			profile: options.runtime.safetyConfig.profile,
			readOnly: options.runtime.safetyConfig.readOnly,
			allowlistVersion: options.runtime.safetyConfig.allowlist.version,
			degraded: safety.degraded,
			supervisor,
			safety,
			startup: startupReport(),
		})
		return
	}

	if (method === "GET" && url.pathname === "/api/catalog") {
		sendJsonBody(res, 200, options.getCatalogJson())
		return
	}

	if (method === "GET" && url.pathname === "/api/calls") {
		sendJson(res, 200, {
			ok: true,
			calls: Array.from(options.activeCalls.values()).map((call) => ({
				id: call.id,
				tool: call.tool,
				action: call.action,
				startedAt: call.startedAt,
			})),
		})
		return
	}

	if (method === "POST" && url.pathname === "/api/cancel") {
		if (!req.headers["content-type"]?.toString().toLowerCase().startsWith("application/json")) {
			sendJson(res, 415, { ok: false, error: "Content-Type must be application/json." })
			return
		}
		let body: unknown
		try {
			body = await readJsonBody(req)
		} catch (error) {
			sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
			return
		}
		const callId = body && typeof body === "object" && !Array.isArray(body)
			? (body as Record<string, unknown>).callId
			: undefined
		if (typeof callId !== "string" || !callId.trim()) {
			sendJson(res, 400, { ok: false, error: "'callId' must be a non-empty string." })
			return
		}
		const call = options.activeCalls.get(callId.trim())
		if (!call) {
			sendJson(res, 404, { ok: false, error: `Unknown or finished call '${callId}'.` })
			return
		}
		call.controller.abort()
		sendJson(res, 200, {
			ok: true,
			callId: call.id,
			tool: call.tool,
			action: call.action,
			accepted: true,
			applied: false,
			status: "abandoned",
			note: "Stopped waiting for the editor. The editor call may still be running; no editor execution was interrupted.",
		})
		return
	}

	if (method === "GET" && url.pathname === "/api/history") {
		const requestedLimit = Number(url.searchParams.get("limit") ?? "50")
		const limit = Number.isFinite(requestedLimit)
			? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_HISTORY_LIMIT)
			: 50
		sendJson(res, 200, {
			ok: true,
			entries: options.runtime.safety.history.list({ limit }),
			status: options.runtime.safety.history.getStatus(),
		})
		return
	}

	if (method === "POST" && url.pathname === "/api/call") {
		if (!req.headers["content-type"]?.toString().toLowerCase().startsWith("application/json")) {
			sendJson(res, 415, { ok: false, error: "Content-Type must be application/json." })
			return
		}

		let body: unknown
		try {
			body = await readJsonBody(req)
		} catch (error) {
			sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
			return
		}

		if (!body || typeof body !== "object" || Array.isArray(body)) {
			sendJson(res, 400, { ok: false, error: "Expected a JSON object." })
			return
		}

		const payload = body as Record<string, unknown>
		if (typeof payload.tool !== "string" || !payload.tool.trim()) {
			sendJson(res, 400, { ok: false, error: "'tool' must be a non-empty string." })
			return
		}
		const toolName = payload.tool.trim()

		let action: string | undefined
		if (payload.action !== undefined && payload.action !== null) {
			if (typeof payload.action !== "string" || !payload.action.trim()) {
				sendJson(res, 400, { ok: false, error: "'action' must be a non-empty string when supplied." })
				return
			}
			action = payload.action
		}

		let params: Record<string, unknown> = {}
		if (payload.params !== undefined && payload.params !== null) {
			if (typeof payload.params !== "object" || Array.isArray(payload.params)) {
				sendJson(res, 400, { ok: false, error: "'params' must be a JSON object." })
				return
			}
			params = payload.params as Record<string, unknown>
		}

		const tool = options.context.toolHandlerRegistry.get(toolName)
		if (!tool) {
			const message = `Unknown tool '${toolName}'.`
			sendJson(res, 404, { ok: false, isError: true, error: message, text: message })
			return
		}
		if (tool.kind === "namespace" && !action) {
			const message = `'action' is required for namespace tool '${toolName}'.`
			sendJson(res, 400, { ok: false, isError: true, error: message, text: message })
			return
		}
		if (tool.kind === "direct" && action) {
			const message = `Direct tool '${toolName}' does not accept an action.`
			sendJson(res, 400, { ok: false, isError: true, error: message, text: message })
			return
		}

		const namespace = options.context.toolNamespaceRegistry.get(toolName)
		const actionParams = action ? namespace?.params[action] : undefined
		const supportsDryRun = declaresDryRun(actionParams)
		const dryRunRequested = params.dry_run === true
		if (dryRunRequested && !supportsDryRun) {
			const message = `${toolName}${action ? `.${action}` : ""} does not declare dry-run support; remove 'dry_run' or use an action that reports supportsDryRun.`
			sendJson(res, 400, {
				ok: false,
				isError: true,
				code: "dry_run_unsupported",
				tool: toolName,
				action,
				error: message,
				text: JSON.stringify({ success: false, code: "dry_run_unsupported", error: message }),
			})
			return
		}

		const policy = resolvePolicy(options.runtime.safetyConfig.allowlist, toolName, action)
		if (options.activeCalls.size > 0 && policy.mode !== "read") {
			const existing = Array.from(options.activeCalls.values())[0]
			const message = `Editor is busy with ${existing.tool}${existing.action ? `.${existing.action}` : ""} (call ${existing.id}).`
			sendJson(res, 409, {
				ok: false,
				isError: true,
				code: "editor_busy",
				error: message,
				text: JSON.stringify({ success: false, code: "editor_busy", error: message, activeCall: existing.id }),
				activeCall: { id: existing.id, tool: existing.tool, action: existing.action, startedAt: existing.startedAt },
			})
			return
		}

		const startedAt = Date.now()
		const callId = randomUUID()
		const controller = new AbortController()
		const activeCall: ActiveCall = { id: callId, tool: toolName, action, startedAt: new Date().toISOString(), controller }
		options.activeCalls.set(callId, activeCall)

		const args = tool.kind === "namespace" ? { action: action ?? "", params } : params
		const handlerPromise = Promise.resolve().then(() => tool.handler(args))
		const cleanup = () => {
			if (options.activeCalls.get(callId) === activeCall) {
				options.activeCalls.delete(callId)
			}
		}
		handlerPromise.then(cleanup, cleanup)

		const abandoned = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("Call abandoned by client.")), { once: true })
		})

		try {
			const result = await Promise.race([handlerPromise, abandoned])
			const text = extractTextContent(result)
			const failed = textIndicatesFailure(text)
			let parsed: unknown
			try {
				parsed = JSON.parse(text)
			} catch {
				parsed = undefined
			}
			const structured = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as { data?: unknown; error?: unknown; warnings?: unknown })
				: {}
			sendJson(res, 200, {
				ok: !failed,
				isError: failed,
				callId,
				tool: toolName,
				action,
				dryRun: dryRunRequested,
				supportsDryRun,
				text,
				data: structured.data,
				error: failed ? structured.error : undefined,
				warnings: Array.isArray(structured.warnings) ? structured.warnings : undefined,
				durationMs: Date.now() - startedAt,
			})
		} catch (error) {
			if (controller.signal.aborted) {
				sendJson(res, 200, {
					ok: true,
					isError: false,
					callId,
					tool: toolName,
					action,
					dryRun: dryRunRequested,
					abandoned: true,
					applied: false,
					status: "abandoned",
					note: "Stopped waiting for the editor. The editor call may still be running; no editor execution was interrupted.",
					durationMs: Date.now() - startedAt,
				})
				return
			}
			const message = error instanceof Error ? error.message : String(error)
			sendJson(res, 200, {
				ok: false,
				isError: true,
				callId,
				tool: toolName,
				action,
				error: message,
				text: JSON.stringify({ success: false, error: message }),
				durationMs: Date.now() - startedAt,
			})
		}
		return
	}

	if (method === "POST" && url.pathname === "/api/panic") {
		let reason = "MCP control panel panic request"
		try {
			const body = await readJsonBody(req)
			if (body && typeof body === "object" && !Array.isArray(body)) {
				const requested = (body as Record<string, unknown>).reason
				if (typeof requested === "string" && requested.trim()) {
					reason = requested.trim().slice(0, 500)
				}
			}
		} catch {
			// Use the default reason for an empty/invalid body.
		}

		const safety = options.runtime.safety.getStatus()
		if (!safety.supervisor?.enabled) {
			sendJson(res, 409, { ok: false, error: "Supervisor is not configured." })
			return
		}

		options.runtime.safety.supervisorPanic(reason)
		sendJson(res, 200, { ok: true, message: "Panic sent to supervisor." })
		return
	}

	sendJson(res, 404, { ok: false, error: "Not found." })
}

export async function startControlServer(options: StartControlServerOptions): Promise<ControlServerHandle> {
	const host = options.host?.trim() || HOST
	const port = options.port ?? parsePort(envValue("CONTROL_PORT")) ?? DEFAULT_PORT
	const token =
		options.token?.trim() || envValue("CONTROL_TOKEN") || randomBytes(32).toString("hex")
	const descriptorPath =
		options.descriptorPath?.trim() || envValue("CONTROL_DESCRIPTOR") || defaultDescriptorPath()
	const startedAt = new Date().toISOString()
	const activeCalls = new Map<string, ActiveCall>()
	let catalogJson: string | undefined
	const getCatalog = () => buildCatalog(options.runtime, options.context)
	const getCatalogJson = () => {
		if (!catalogJson) {
			const buildStarted = Date.now()
			catalogJson = JSON.stringify({ ok: true, ...getCatalog() })
			markStartup("catalog")
			console.error(`UEV catalog: built in ${Date.now() - buildStarted}ms; ${Buffer.byteLength(catalogJson)} bytes`)
		}
		return catalogJson
	}

	// The ping path must never block on the supervisor pipe: serve the last status and refresh it
	// in the background once it is older than SUPERVISOR_STATUS_TTL_MS.
	let supervisorStatusCache: { at: number; value: Record<string, unknown> | undefined } | undefined
	let supervisorStatusRefresh: Promise<void> | undefined
	const getSupervisorStatus = async (): Promise<Record<string, unknown> | undefined> => {
		const cached = supervisorStatusCache
		if (cached && Date.now() - cached.at <= SUPERVISOR_STATUS_TTL_MS) {
			return cached.value
		}
		if (cached && !supervisorStatusRefresh) {
			supervisorStatusRefresh = options.runtime.safety
				.getSupervisorStatus()
				.then((value) => {
					supervisorStatusCache = {
						at: Date.now(),
						value: value && typeof value === "object" ? (value as Record<string, unknown>) : undefined,
					}
				})
				.catch(() => {
					supervisorStatusCache = { at: Date.now(), value: undefined }
				})
				.finally(() => {
					supervisorStatusRefresh = undefined
				})
			return cached.value
		}
		const value = await options.runtime.safety.getSupervisorStatus().catch(() => undefined)
		supervisorStatusCache = {
			at: Date.now(),
			value: value && typeof value === "object" ? (value as Record<string, unknown>) : undefined,
		}
		return supervisorStatusCache.value
	}

	let actualPort = port
	const httpServer = http.createServer((req, res) => {
		void handleRequest(req, res, {
			token,
			runtime: options.runtime,
			context: options.context,
			getCatalog,
			getCatalogJson,
			getSupervisorStatus,
			startedAt,
			getPort: () => actualPort,
			activeCalls,
		}).catch((error) => {
			if (!res.headersSent) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
			} else {
				res.destroy()
			}
		})
	})

	// Prewarm before advertising readiness: the descriptor written below tells clients the API is
	// up, so everything a first request needs (the serialised catalog) is built first.
	const prewarmStarted = Date.now()
	getCatalogJson()
	markStartup("prewarm")
	console.error(`UEV prewarm: catalog built in ${Date.now() - prewarmStarted}ms`)

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject)
		httpServer.listen(port, host, () => {
			httpServer.off("error", reject)
			resolve()
		})
	})

	const address = httpServer.address()
	if (address && typeof address === "object") {
		actualPort = address.port
	}

	const descriptor = {
		productName,
		productTitle,
		productSlug,
		version: projectVersion,
		productVersion,
		serverVersion,
		protocolVersion,
		host,
		port: actualPort,
		token,
		pid: process.pid,
		startedAt,
		profile: options.runtime.safetyConfig.profile,
		readOnly: options.runtime.safetyConfig.readOnly,
		allowlistVersion: options.runtime.safetyConfig.allowlist.version,
	}

	fs.mkdirSync(path.dirname(descriptorPath), { recursive: true })
	fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })

	markStartup("control-listen")

	console.error(
		`UEV control API: http://${host}:${actualPort}; descriptor=${descriptorPath}; profile=${options.runtime.safetyConfig.profile}${options.runtime.safetyConfig.readOnly ? " (read-only)" : ""}`,
	)

	// Warm the editor-side plugin probe in the background: without this the first tool call pays a
	// cold supervisor round trip (and retries, since probe failures are not cached).
	if (options.runtime.pluginRegistry) {
		void options.runtime.pluginRegistry
			.ensureAvailability()
			.then(() => markStartup("editor-probe"))
			.catch(() => undefined)
	}

	let closed = false
	const close = async () => {
		if (closed) {
			return
		}
		closed = true

		if (httpServer.listening) {
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve())
			})
		}

		try {
			const existing = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as { pid?: number; token?: string }
			if (existing.pid === process.pid && existing.token === token) {
				fs.unlinkSync(descriptorPath)
			}
		} catch {
			// The descriptor is best-effort cleanup.
		}
	}

	return { host, port: actualPort, token, descriptorPath, close }
}
