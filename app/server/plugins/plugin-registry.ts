import fs from "node:fs"

import defaultManifest from "./plugins.manifest.json"
import { envValue } from "../identity.js"

export type PluginSourceKind = "engine" | "debloat" | "integration" | "project"
export type RequirementKind = "plugin" | "module"

export interface PluginSourceDefinition {
	kind: PluginSourceKind
	path: string
}

export interface PluginDefinition {
	name: string
	required?: boolean
	optionalReference?: boolean
	copyToProject?: boolean
	checkBuildId?: boolean
	pythonProbes?: string[]
	sources: PluginSourceDefinition[]
	description?: string
}

export interface ModuleDefinition {
	name: string
	required?: boolean
	description?: string
}

export interface PluginManifest {
	version: number
	pythonPlugin: string
	plugins: PluginDefinition[]
	modules: ModuleDefinition[]
	namespaceRequirements: Record<string, string[]>
	actionRequirements: Record<string, string[]>
}

export interface PluginRequirement {
	kind: RequirementKind
	name: string
}

export interface PluginProbeResult {
	source: string
	plugins: string[]
	modules?: Record<string, boolean | null>
	pluginDetails?: Record<string, unknown>
}

export type PluginProbe = (
	probes: Record<string, string[]>,
	modules: string[],
) => Promise<PluginProbeResult>

export interface PluginAvailability {
	plugins: string[]
	modules: string[]
	source: string
	probedAt: string
	pluginDetails?: Record<string, unknown>
	moduleDetails?: Record<string, boolean | null>
}

export interface PluginRegistryStatus {
	manifestVersion: number
	pythonPlugin: string
	plugins: Array<{
		name: string
		required: boolean
		optionalReference: boolean
		available: boolean | undefined
		probes: string[]
	}>
	modules: Array<{
		name: string
		required: boolean
		available: boolean | undefined
	}>
	requirements: {
		namespaces: Record<string, string[]>
		actions: Record<string, string[]>
	}
	availability?: PluginAvailability
	error?: string
}

export interface PluginRegistry {
	requirementsFor: (tool: string, action?: string) => PluginRequirement[]
	missingRequirements: (
		requirements: PluginRequirement[],
		availability: PluginAvailability,
	) => PluginRequirement[]
	ensureAvailability: (force?: boolean) => Promise<PluginAvailability>
	refresh: () => Promise<PluginRegistryStatus>
	reload: () => Promise<PluginRegistryStatus>
	getStatus: () => PluginRegistryStatus
	getManifest: () => PluginManifest
}

const DEFAULT_CACHE_MS = 30_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined
	}

	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

const normalizeRequirements = (value: unknown): Record<string, string[]> => {
	if (!isRecord(value)) {
		return {}
	}

	const result: Record<string, string[]> = {}
	for (const [key, raw] of Object.entries(value)) {
		const names = readStringArray(raw)
		if (names) {
			result[key] = names
		}
	}
	return result
}

const validateManifest = (value: unknown): PluginManifest => {
	if (!isRecord(value)) {
		throw new Error("Plugin manifest must be a JSON object.")
	}

	const pluginsRaw = value.plugins
	if (!Array.isArray(pluginsRaw) || pluginsRaw.length === 0) {
		throw new Error("Plugin manifest must contain a non-empty plugins array.")
	}

	const plugins: PluginDefinition[] = []
	const seenPlugins = new Set<string>()
	for (const rawPlugin of pluginsRaw) {
		if (!isRecord(rawPlugin) || typeof rawPlugin.name !== "string" || rawPlugin.name.trim().length === 0) {
			throw new Error("Each plugin manifest entry must have a non-empty name.")
		}

		const name = rawPlugin.name.trim()
		if (seenPlugins.has(name.toLowerCase())) {
			throw new Error(`Duplicate plugin manifest entry: ${name}`)
		}
		seenPlugins.add(name.toLowerCase())

		const sourcesRaw = rawPlugin.sources
		if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
			throw new Error(`Plugin ${name} must define at least one source.`)
		}

		const sources: PluginSourceDefinition[] = []
		for (const rawSource of sourcesRaw) {
			if (
				!isRecord(rawSource) ||
				typeof rawSource.kind !== "string" ||
				typeof rawSource.path !== "string"
			) {
				throw new Error(`Plugin ${name} has an invalid source entry.`)
			}

			const kind = rawSource.kind
			if (kind !== "engine" && kind !== "debloat" && kind !== "integration" && kind !== "project") {
				throw new Error(`Plugin ${name} has an unsupported source kind: ${kind}`)
			}

			sources.push({ kind, path: rawSource.path })
		}

		plugins.push({
			name,
			required: rawPlugin.required === true,
			optionalReference: rawPlugin.optionalReference === true,
			copyToProject: rawPlugin.copyToProject === true,
			checkBuildId: rawPlugin.checkBuildId === true,
			pythonProbes: readStringArray(rawPlugin.pythonProbes) ?? [],
			sources,
			description: typeof rawPlugin.description === "string" ? rawPlugin.description : undefined,
		})
	}

	const modulesRaw = Array.isArray(value.modules) ? value.modules : []
	const modules: ModuleDefinition[] = []
	for (const rawModule of modulesRaw) {
		if (!isRecord(rawModule) || typeof rawModule.name !== "string" || rawModule.name.trim().length === 0) {
			throw new Error("Each module manifest entry must have a non-empty name.")
		}
		modules.push({
			name: rawModule.name.trim(),
			required: rawModule.required === true,
			description: typeof rawModule.description === "string" ? rawModule.description : undefined,
		})
	}

	return {
		version: typeof value.version === "number" ? value.version : 1,
		pythonPlugin:
			typeof value.pythonPlugin === "string" && value.pythonPlugin.trim().length > 0
				? value.pythonPlugin.trim()
				: "PythonScriptPlugin",
		plugins,
		modules,
		namespaceRequirements: normalizeRequirements(value.namespaceRequirements),
		actionRequirements: normalizeRequirements(value.actionRequirements),
	}
}

export const loadPluginManifest = (overridePath = envValue("PLUGIN_MANIFEST")): PluginManifest => {
	const configuredPath = overridePath?.trim()
	if (configuredPath) {
		const text = fs.readFileSync(configuredPath, "utf8")
		return validateManifest(JSON.parse(text))
	}

	return validateManifest(defaultManifest)
}

export const createPluginRegistry = (options: {
	manifest?: PluginManifest
	probe: PluginProbe
}): PluginRegistry => {
	let manifest = options.manifest ?? loadPluginManifest()
	let pluginProbes = buildProbeMap(manifest)
	let moduleNames = manifest.modules.map((module) => module.name)
	let availability: PluginAvailability | undefined
	let lastError: string | undefined
	let probedAtMs = 0

	const requirementsFor = (tool: string, action?: string): PluginRequirement[] => {
		const key = action ? `${tool}.${action}` : tool
		const names =
			manifest.actionRequirements[key] ??
			manifest.namespaceRequirements[tool] ??
			[]

		const moduleNameSet = new Set(manifest.modules.map((module) => module.name.toLowerCase()))
		return names.map((name) => ({
			kind: moduleNameSet.has(name.toLowerCase()) ? "module" : "plugin",
			name,
		}))
	}

	const ensureAvailability = async (force = false): Promise<PluginAvailability> => {
		if (!force && availability && Date.now() - probedAtMs < DEFAULT_CACHE_MS) {
			return availability
		}

		try {
			const result = await options.probe(pluginProbes, moduleNames)
			const pluginMap = new Map<string, string>()
			for (const name of result.plugins ?? []) {
				if (typeof name === "string" && name.trim().length > 0) {
					pluginMap.set(name.toLowerCase(), name)
				}
			}

			const moduleDetails: Record<string, boolean | null> = {}
			for (const [name, loaded] of Object.entries(result.modules ?? {})) {
				moduleDetails[name] = loaded === true ? true : loaded === false ? false : null
			}

			availability = {
				plugins: [...pluginMap.values()].sort((a, b) => a.localeCompare(b)),
				modules: Object.entries(moduleDetails)
					.filter(([, loaded]) => loaded === true)
					.map(([name]) => name)
					.sort((a, b) => a.localeCompare(b)),
				source: result.source,
				probedAt: new Date().toISOString(),
				pluginDetails: result.pluginDetails,
				moduleDetails,
			}
			lastError = undefined
			probedAtMs = Date.now()
			return availability
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
			throw error
		}
	}

	const missingRequirements = (
		requirements: PluginRequirement[],
		probed: PluginAvailability,
	): PluginRequirement[] => {
		const availablePlugins = new Set(probed.plugins.map((name) => name.toLowerCase()))
		const availableModules = new Set(probed.modules.map((name) => name.toLowerCase()))
		return requirements.filter((requirement) =>
			requirement.kind === "module"
				? !availableModules.has(requirement.name.toLowerCase())
				: !availablePlugins.has(requirement.name.toLowerCase()),
		)
	}

	const getStatus = (): PluginRegistryStatus => {
		const availablePlugins = new Set((availability?.plugins ?? []).map((name) => name.toLowerCase()))
		const availableModules = new Set((availability?.modules ?? []).map((name) => name.toLowerCase()))

		return {
			manifestVersion: manifest.version,
			pythonPlugin: manifest.pythonPlugin,
			plugins: manifest.plugins.map((plugin) => ({
				name: plugin.name,
				required: plugin.required === true,
				optionalReference: plugin.optionalReference === true,
				available: availability ? availablePlugins.has(plugin.name.toLowerCase()) : undefined,
				probes: plugin.pythonProbes ?? [],
			})),
			modules: manifest.modules.map((module) => ({
				name: module.name,
				required: module.required === true,
				available: availability ? availableModules.has(module.name.toLowerCase()) : undefined,
			})),
			requirements: {
				namespaces: manifest.namespaceRequirements,
				actions: manifest.actionRequirements,
			},
			availability,
			error: lastError,
		}
	}

	const refresh = async (): Promise<PluginRegistryStatus> => {
		await ensureAvailability(true)
		return getStatus()
	}

	const reload = async (): Promise<PluginRegistryStatus> => {
		manifest = loadPluginManifest()
		pluginProbes = buildProbeMap(manifest)
		moduleNames = manifest.modules.map((module) => module.name)
		availability = undefined
		lastError = undefined
		probedAtMs = 0
		await ensureAvailability(true)
		return getStatus()
	}

	return {
		requirementsFor,
		missingRequirements,
		ensureAvailability,
		refresh,
		reload,
		getStatus,
		getManifest: () => manifest,
	}
}

const buildProbeMap = (manifest: PluginManifest): Record<string, string[]> => {
	const probes: Record<string, string[]> = {}
	for (const plugin of manifest.plugins) {
		probes[plugin.name] = plugin.pythonProbes ?? []
	}
	return probes
}
