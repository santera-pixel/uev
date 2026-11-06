import path from "node:path"

import { z } from "zod"

import { tryRunCommand } from "./remote-execution.js"
import type { RegistrationContext } from "./registration-context.js"
import { getCallContext } from "./safety/context.js"
import {
	buildCompileSwitchStatus,
	getViteCvarDefinition,
	parseViteCvarValue,
	renderStateCvarNames,
	viteCvarCatalog,
	viteCompileSwitches,
	type ViteCvarReading,
} from "./vite/cvar-catalog.js"
import {
	normalizeViteCvarMap,
	normalizeViteCvarValue,
	previousViteCvarValue,
} from "./vite/values.js"
import { getVitePreset, vitePresets } from "./vite/presets.js"
import {
	auditConfig,
	auditCvars,
	auditPlugins,
	buildProjectAudit,
	flattenCvarSettings,
	readProjectFiles,
	type ProjectFiles,
} from "./vite/project-audit.js"

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
				// Fall through to raw text.
			}
		}
		return text
	}
}

const catalogNames = viteCvarCatalog.map((definition) => definition.name)
const compileProbeNames = [
	...new Set(viteCompileSwitches.flatMap((definition) => definition.probeCvars ?? [])),
]

export function registerViteAuditNamespaces(ctx: RegistrationContext) {
	const { directDispatch, editorTools, pluginRegistry, pythonDispatch, registerToolNamespace } = ctx

	const readCvars = async (names: string[]): Promise<Record<string, ViteCvarReading>> => {
		const uniqueNames = [...new Set(names.filter((name) => name.trim().length > 0))]
		if (uniqueNames.length === 0) {
			return {}
		}
		const text = await tryRunCommand(editorTools.UEViteCvars(uniqueNames))
		const parsed = parsePythonJson(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Unexpected cvar response: ${text.slice(0, 200)}`)
		}
		return parsed as Record<string, ViteCvarReading>
	}

	const getProjectPaths = async (): Promise<{ projectDir: string; projectName?: string }> => {
		const text = await tryRunCommand(editorTools.UEDebugPaths())
		const parsed = parsePythonJson(text) as { project_dir?: unknown; project_name?: unknown } | undefined
		if (!parsed || typeof parsed.project_dir !== "string") {
			throw new Error("Could not resolve the project directory.")
		}
		return {
			projectDir: path.resolve(parsed.project_dir),
			projectName: typeof parsed.project_name === "string" ? parsed.project_name : undefined,
		}
	}

	const readProjectContext = async (): Promise<ProjectFiles> => {
		const { projectDir, projectName } = await getProjectPaths()
		return readProjectFiles(projectDir, projectName)
	}

	const runProjectAudit = async () => {
		const files = await readProjectContext()
		const settings = flattenCvarSettings(files.ini)
		const names = [
			...new Set([...catalogNames, ...renderStateCvarNames, ...compileProbeNames, ...Object.keys(settings)]),
		]
		const availability = await readCvars(names)
		return buildProjectAudit(files, availability)
	}

	const compileSwitchReport = (availability: Record<string, ViteCvarReading>) => {
		const status = buildCompileSwitchStatus(viteCompileSwitches, availability)
		return viteCompileSwitches.map((definition) => ({
			...definition,
			detected: status[definition.name],
			probeResults: (definition.probeCvars ?? []).map((name) => ({
				name,
				...availability[name],
			})),
		}))
	}

	const setViteCvar = async (name: string, value: unknown) => {
		const definition = getViteCvarDefinition(name)
		const normalized = normalizeViteCvarValue(name, value, definition)
		const reading = (await readCvars([name]))[name]
		const previous = previousViteCvarValue(definition, reading)
		const context = getCallContext()
		if (context) {
			context.history = {
				undo: "semantic",
				inverse: { tool: "manage_vite", action: "cvar_set", params: { name, value: previous } },
				forward: { tool: "manage_vite", action: "cvar_set", params: { name, value: normalized } },
			}
		}
		return pythonDispatch(editorTools.UEViteCvarSet(name, normalized))
	}

	const setViteCvars = async (values: Record<string, unknown>) => {
		const normalized = normalizeViteCvarMap(values)
		const names = Object.keys(normalized)
		const availability = await readCvars(names)
		const previous: Record<string, unknown> = {}
		for (const name of names) {
			previous[name] = previousViteCvarValue(getViteCvarDefinition(name), availability[name])
		}
		const context = getCallContext()
		if (context) {
			context.history = {
				undo: "semantic",
				inverse: { tool: "manage_vite", action: "preset_restore", params: { values: previous } },
				forward: { tool: "manage_vite", action: "preset_restore", params: { values: normalized } },
			}
		}
		return pythonDispatch(editorTools.UEViteCvarSetMany(normalized))
	}

	registerToolNamespace(
		"manage_vite",
		"Unreal Engine Vite renderer inspection and controlled writes: cvars, render state, compile switches, presets, project audit, and allowlisted console commands.",
		{
			capabilities: {
				handler: async () => {
					const health = parsePythonJson(await tryRunCommand(editorTools.UEDebugHealth()))
					const files = await readProjectContext()
					return directDispatch({
						success: true,
						health,
						project: {
							projectFile: files.projectFile,
							projectDir: files.projectDir,
							projectName: files.projectName,
						},
						plugins: auditPlugins(files.uproject),
						config: auditConfig(files.uproject, files.ini),
						catalogSize: viteCvarCatalog.length,
						compileSwitches: viteCompileSwitches.map((definition) => definition.name),
						presets: vitePresets.map((preset) => preset.name),
					})
				},
			},
			cvar_catalog: {
				handler: async () => {
					const availability = await readCvars(catalogNames)
					const cvars = viteCvarCatalog.map((definition) => ({
						...definition,
						available: availability[definition.name]?.available === true,
						current: parseViteCvarValue(definition, availability[definition.name]),
						raw: availability[definition.name],
					}))
					return directDispatch({
						success: true,
						generatedAt: new Date().toISOString(),
						cvars,
						compileSwitches: compileSwitchReport(availability),
					})
				},
			},
			cvar_get: {
				paramsSchema: z
					.object({
						name: z
							.string()
							.min(1)
							.max(200)
							.regex(/^[A-Za-z0-9_.]+$/, "Cvar names may only contain letters, numbers, underscores, and dots."),
					})
					.strict(),
				handler: async (params) => {
					const name = String((params as { name: string }).name).trim()
					const availability = await readCvars([name])
					const definition = getViteCvarDefinition(name)
					const reading = availability[name]
					return directDispatch({
						success: true,
						name,
						defined: Boolean(definition),
						available: reading?.available === true,
						current: parseViteCvarValue(definition, reading),
						definition,
						raw: reading,
					})
				},
			},
			render_state: {
				handler: async () => {
					const availability = await readCvars(renderStateCvarNames)
					const state = renderStateCvarNames.map((name) => {
						const definition = getViteCvarDefinition(name)
						const reading = availability[name]
						return {
							name,
							group: definition?.group,
							available: reading?.available === true,
							value: parseViteCvarValue(definition, reading),
							raw: reading,
						}
					})
					return directDispatch({ success: true, state })
				},
			},
			compile_switches: {
				handler: async () => {
					const availability = await readCvars(compileProbeNames)
					return directDispatch({
						success: true,
						switches: compileSwitchReport(availability),
					})
				},
			},
			project_audit: {
				handler: async () => {
					const audit = await runProjectAudit()
					return directDispatch({ success: true, audit })
				},
			},
			preset_list: {
				handler: () => directDispatch({ success: true, presets: vitePresets }),
			},
			preset_preview: {
				paramsSchema: z.object({ name: z.string().min(1).max(100) }).strict(),
				handler: async (params) => {
					const presetName = String((params as { name: string }).name).trim()
					const preset = getVitePreset(presetName)
					if (!preset) {
						throw new Error(`Unknown Vite preset: ${presetName}`)
					}
					const availability = await readCvars(Object.keys(preset.values))
					const changes = Object.entries(preset.values).map(([name, proposed]) => {
						const definition = getViteCvarDefinition(name)
						const reading = availability[name]
						const current = parseViteCvarValue(definition, reading)
						return {
							name,
							current,
							proposed,
							changed: String(current) !== String(proposed),
							available: reading?.available === true,
						}
					})
					return directDispatch({
						success: true,
						preset: preset.name,
						description: preset.description,
						changes,
						changedCount: changes.filter((change) => change.changed).length,
					})
				},
			},
			cvar_set: {
				paramsSchema: z
					.object({
						name: z
							.string()
							.min(1)
							.max(200)
							.regex(/^[A-Za-z0-9_.]+$/, "Cvar names may only contain letters, numbers, underscores, and dots."),
						value: z.union([z.boolean(), z.number()]),
					})
					.strict(),
				handler: async (params) => {
					const { name, value } = params as { name: string; value: boolean | number }
					return setViteCvar(name, value)
				},
			},
			cvar_restore: {
				paramsSchema: z
					.object({
						name: z
							.string()
							.min(1)
							.max(200)
							.regex(/^[A-Za-z0-9_.]+$/, "Cvar names may only contain letters, numbers, underscores, and dots."),
						value: z.union([z.boolean(), z.number()]),
					})
					.strict(),
				handler: async (params) => {
					const { name, value } = params as { name: string; value: boolean | number }
					return setViteCvar(name, value)
				},
			},
			preset_apply: {
				paramsSchema: z.object({ name: z.string().min(1).max(100) }).strict(),
				handler: async (params) => {
					const presetName = String((params as { name: string }).name).trim()
					const preset = getVitePreset(presetName)
					if (!preset) {
						throw new Error(`Unknown Vite preset: ${presetName}`)
					}
					return setViteCvars(preset.values)
				},
			},
			preset_restore: {
				paramsSchema: z
					.object({
						values: z.record(z.string(), z.union([z.boolean(), z.number()])),
					})
					.strict(),
				handler: async (params) => {
					const values = (params as { values: Record<string, unknown> }).values
					return setViteCvars(values)
				},
			},
			console: {
				paramsSchema: z
					.object({
						command: z.enum([
							"stat unit",
							"stat gpu",
							"stat scenerendering",
							"stat physics",
							"stat memory",
							"profilegpu",
						]),
					})
					.strict(),
				handler: async (params) => {
					const command = String((params as { command: string }).command)
					return pythonDispatch(editorTools.UEConsoleCommand(command))
				},
			},
		},
	)

	registerToolNamespace(
		"manage_audit",
		"Read-only project audits for required plugins, remote-execution config, Vite cvars, and a consolidated summary.",
		{
			plugin_audit: {
				handler: async () => {
					const files = await readProjectContext()
					const runtime = await pluginRegistry.refresh()
					return directDispatch({ success: true, ...auditPlugins(files.uproject), runtime })
				},
			},
			config_audit: {
				handler: async () => {
					const files = await readProjectContext()
					return directDispatch({ success: true, ...auditConfig(files.uproject, files.ini) })
				},
			},
			cvar_audit: {
				handler: async () => {
					const files = await readProjectContext()
					const settings = flattenCvarSettings(files.ini)
					const names = [
						...new Set([...catalogNames, ...compileProbeNames, ...Object.keys(settings)]),
					]
					const availability = await readCvars(names)
					const compileSwitches = buildCompileSwitchStatus(viteCompileSwitches, availability)
					const audit = auditCvars(settings, availability, compileSwitches)
					return directDispatch({
						success: true,
						...audit,
						compileSwitches,
					})
				},
			},
			project_summary: {
				handler: async () => {
					const audit = await runProjectAudit()
					return directDispatch({ success: true, audit })
				},
			},
		},
	)
}
