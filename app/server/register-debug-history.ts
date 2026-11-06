import path from "node:path"

import { z } from "zod"

import { findNewestLog, readAuditEntries, tailFile } from "./debug/log-reader.js"
import { getRemoteExecutionStatus, tryRunCommand } from "./remote-execution.js"
import type { RegistrationContext } from "./registration-context.js"
import { normalizeViteCvarMap, normalizeViteCvarValue } from "./vite/values.js"

const parsePythonJson = (text: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				// Fall through to the raw text.
			}
		}
		return text
	}
}

export function registerDebugHistoryNamespaces(ctx: RegistrationContext) {
	const { directDispatch, editorTools, pluginRegistry, pythonDispatch, registerToolNamespace, safety } = ctx

	const buildSemanticCommand = (metadata: Record<string, unknown> | undefined): string => {
		if (!metadata) {
			throw new Error("This semantic history entry has no inverse metadata.")
		}

		const tool = String(metadata.tool ?? "")
		const action = String(metadata.action ?? "")
		const params = (metadata.params ?? {}) as Record<string, unknown>

		if (tool === "manage_vite" && action === "cvar_set") {
			const name = String(params.name ?? "")
			const value = normalizeViteCvarValue(name, params.value)
			return editorTools.UEViteCvarSet(name, value)
		}

		if (tool === "manage_vite" && action === "preset_restore") {
			const values = normalizeViteCvarMap((params.values ?? {}) as Record<string, unknown>)
			return editorTools.UEViteCvarSetMany(values)
		}

		throw new Error(`Unsupported semantic history action '${tool}.${action}'.`)
	}

	registerToolNamespace(
		"manage_debug",
		"Editor health, plugin availability, supervisor status, log tails, recent scripts, and panic/reset controls.",
		{
			health: {
				handler: async () => {
					const python = await tryRunCommand(editorTools.UEDebugHealth())
					return directDispatch({
						success: true,
						python: parsePythonJson(python),
						safety: safety.getStatus(),
						plugins: pluginRegistry.getStatus(),
						supervisor: await safety.getSupervisorStatus(),
						remote: getRemoteExecutionStatus(),
					})
				},
			},
			supervisor: {
				handler: async () => directDispatch(await safety.getSupervisorStatus()),
			},
			remote: {
				handler: () => directDispatch(getRemoteExecutionStatus()),
			},
			python: {
				handler: async () => {
					const python = await tryRunCommand(editorTools.UEDebugPythonEnv())
					return directDispatch({ success: true, python: parsePythonJson(python) })
				},
			},
			ping: {
				handler: async () => {
					const startedAt = Date.now()
					const output = await tryRunCommand(editorTools.UEDebugPing())
					return directDispatch({
						success: output.includes("rrmcp:pong"),
						latencyMs: Date.now() - startedAt,
						output,
					})
				},
			},
			logs: {
				paramsSchema: z
					.object({
						source: z.enum(["editor", "supervisor", "audit"]).optional(),
						lines: z.number().int().min(1).max(500).optional(),
						filter: z.string().max(200).optional(),
					})
					.strict(),
				handler: async (params) => {
					const source = params.source ?? "editor"
					const lines = params.lines ?? 200
					if (source === "editor") {
						const pathsText = await tryRunCommand(editorTools.UEDebugPaths())
						const paths = parsePythonJson(pathsText) as { saved_dir?: string }
						if (!paths.saved_dir) {
							return directDispatch({ success: false, message: "Could not resolve the project saved directory." })
						}
						const logPath = findNewestLog(path.join(paths.saved_dir, "Logs"))
						if (!logPath) {
							return directDispatch({ success: false, message: "No editor log found." })
						}
						return directDispatch({
							success: true,
							source,
							path: logPath,
							content: tailFile(logPath, lines, params.filter),
						})
					}

					if (source === "supervisor") {
						const status = await safety.getSupervisorStatus()
						const logPath = typeof status.logPath === "string" ? status.logPath : undefined
						if (!logPath) {
							return directDispatch({ success: false, message: "Supervisor log path is not available." })
						}
						return directDispatch({
							success: true,
							source,
							path: logPath,
							content: tailFile(logPath, lines, params.filter),
						})
					}

					return directDispatch({
						success: true,
						source,
						entries: readAuditEntries(safety.getStatus().auditPath, {
							limit: lines,
							filter: params.filter,
						}),
					})
				},
			},
			last_calls: {
				paramsSchema: z
					.object({
						limit: z.number().int().min(1).max(200).optional(),
						tool: z.string().optional(),
						action: z.string().optional(),
						status: z.enum(["success", "error", "timeout", "blocked"]).optional(),
					})
					.strict(),
				handler: (params) =>
					directDispatch({
						success: true,
						entries: readAuditEntries(safety.getStatus().auditPath, params),
					}),
			},
			scripts: {
				paramsSchema: z
					.object({
						limit: z.number().int().min(1).max(200).optional(),
						id: z.string().optional(),
					})
					.strict(),
				handler: (params) => {
					if (params.id) {
						const entry = safety.history.get(params.id)
						return directDispatch(
							entry
								? { success: true, entry }
								: { success: false, message: `History entry '${params.id}' was not found.` },
						)
					}
					const entries = safety.history
						.list({ limit: params.limit ?? 20 })
						.filter((entry) => Boolean(entry.code))
					return directDispatch({ success: true, entries })
				},
			},
			panic: {
				paramsSchema: z
					.object({
						reason: z.string().max(500).optional(),
					})
					.strict(),
				handler: (params) => {
					safety.supervisorPanic(params.reason ?? "MCP panic request")
					return directDispatch({ success: true, message: "Panic sent to supervisor." })
				},
			},
			reset: {
				handler: () => {
					safety.resetCircuit()
					return directDispatch({ success: true, message: "Circuit reset." })
				},
			},
			plugins: {
				handler: async () => {
					const status = await pluginRegistry.refresh()
					return directDispatch({ success: true, ...status })
				},
			},
			refresh_plugins: {
				handler: async () => {
					const status = await pluginRegistry.reload()
					return directDispatch({ success: true, ...status })
				},
			},
		},
	)

	registerToolNamespace(
		"manage_history",
		"Action history with native editor undo/redo and semantic undo metadata.",
		{
			list: {
				paramsSchema: z
					.object({
						limit: z.number().int().min(1).max(200).optional(),
						tool: z.string().optional(),
						action: z.string().optional(),
						status: z.enum(["success", "error", "timeout"]).optional(),
					})
					.strict(),
				handler: (params) =>
					directDispatch({
						success: true,
						entries: safety.history.list({
							limit: params.limit,
							tool: params.tool,
							action: params.action,
							status: params.status,
						}),
					}),
			},
			get: {
				paramsSchema: z.object({ id: z.string().min(1) }).strict(),
				handler: (params) => {
					const entry = safety.history.get(params.id)
					return directDispatch(
						entry
							? { success: true, entry }
							: { success: false, message: `History entry '${params.id}' was not found.` },
					)
				},
			},
			undo: {
				paramsSchema: z.object({ targetId: z.string().min(1) }).strict(),
				handler: (params) => {
					const entry = safety.history.get(params.targetId)
					if (!entry) {
						throw new Error(`History entry '${params.targetId}' was not found.`)
					}
					if (entry.undo === "none") {
						throw new Error("This action is not undoable.")
					}
					if (entry.undo === "semantic") {
						return pythonDispatch(buildSemanticCommand(entry.inverse))
					}
					return pythonDispatch(editorTools.UEHistory("undo"))
				},
			},
			redo: {
				paramsSchema: z.object({ targetId: z.string().min(1) }).strict(),
				handler: (params) => {
					const entry = safety.history.get(params.targetId)
					if (!entry) {
						throw new Error(`History entry '${params.targetId}' was not found.`)
					}
					if (!entry.undone) {
						throw new Error("This action is not currently undone.")
					}
					if (entry.undo === "semantic") {
						return pythonDispatch(buildSemanticCommand(entry.forward))
					}
					if (entry.undo !== "native") {
						throw new Error("Only native or semantic actions can be redone.")
					}
					return pythonDispatch(editorTools.UEHistory("redo"))
				},
			},
			clear: {
				handler: () => {
					safety.history.clear()
					return directDispatch({ success: true, message: "History cleared." })
				},
			},
			status: {
				handler: () => directDispatch({ success: true, ...safety.history.getStatus() }),
			},
		},
	)
}
