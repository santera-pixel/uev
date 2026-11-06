import fs from "node:fs"
import path from "node:path"

import {
	buildCompileSwitchStatus,
	getViteCvarDefinition,
	viteCompileSwitches,
	type ViteCvarReading,
} from "./cvar-catalog.js"

export interface ProjectPluginAudit {
	required: string[]
	enabled: string[]
	missing: string[]
	optionalMissing: string[]
}

export interface ProjectConfigAudit {
	engineAssociation?: string
	pythonRemoteExecution?: {
		enabled?: boolean
		bindAddress?: string
		ttl?: string
	}
	findings: string[]
}

export interface ProjectCvarFinding {
	cvar: string
	value: string
	issue: string
	severity: "warning" | "info"
	detail: string
}

export interface ProjectCvarAudit {
	settings: Record<string, string>
	findings: ProjectCvarFinding[]
}

export interface ProjectFiles {
	projectFile: string
	projectDir: string
	projectName: string
	uproject: Record<string, unknown>
	ini: Record<string, Record<string, string>>
}

export interface ProjectAuditResult {
	projectFile: string
	projectDir: string
	plugins: ProjectPluginAudit
	config: ProjectConfigAudit
	cvars: ProjectCvarAudit
	compileSwitches: Record<string, boolean | undefined>
	ok: boolean
	generatedAt: string
}

const REQUIRED_PLUGINS = ["PythonScriptPlugin", "EditorScriptingUtilities", "UEVNative"]
const OPTIONAL_PLUGINS = ["SequencerScripting"]

const findProjectFile = (projectDir: string, projectName?: string): string => {
	const candidate = projectName?.trim()
		? path.join(projectDir, `${projectName.trim()}.uproject`)
		: undefined
	if (candidate && fs.existsSync(candidate)) {
		return candidate
	}

	const files = fs
		.readdirSync(projectDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject"))
	if (files.length === 0) {
		throw new Error(`No .uproject found in ${projectDir}`)
	}

	return path.join(projectDir, files[0].name)
}

export const parseIni = (text: string): Record<string, Record<string, string>> => {
	const sections: Record<string, Record<string, string>> = {}
	let currentSection = ""

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith(";") || line.startsWith("#")) {
			continue
		}
		if (line.startsWith("[") && line.endsWith("]")) {
			currentSection = line.slice(1, -1)
			sections[currentSection] ??= {}
			continue
		}
		const equalsIndex = line.indexOf("=")
		if (equalsIndex <= 0 || !currentSection) {
			continue
		}
		const key = line.slice(0, equalsIndex).trim().replace(/^[+.-]/, "")
		const value = line.slice(equalsIndex + 1).trim()
		sections[currentSection][key] = value
	}

	return sections
}

export const readProjectFiles = (projectDir: string, projectName?: string): ProjectFiles => {
	const resolvedDir = path.resolve(projectDir)
	const projectFile = findProjectFile(resolvedDir, projectName)
	const name = path.basename(projectFile, ".uproject")
	const uproject = JSON.parse(fs.readFileSync(projectFile, "utf8")) as Record<string, unknown>
	const iniPath = path.join(resolvedDir, "Config", "DefaultEngine.ini")
	const ini = fs.existsSync(iniPath) ? parseIni(fs.readFileSync(iniPath, "utf8")) : {}

	return {
		projectFile,
		projectDir: resolvedDir,
		projectName: name,
		uproject,
		ini,
	}
}

const normalizePluginList = (uproject: Record<string, unknown>): Array<{ name: string; enabled: boolean }> => {
	const rawPlugins = uproject.Plugins
	if (!Array.isArray(rawPlugins)) {
		return []
	}

	return rawPlugins
		.filter((plugin): plugin is Record<string, unknown> => Boolean(plugin) && typeof plugin === "object")
		.map((plugin) => ({
			name: typeof plugin.Name === "string" ? plugin.Name : "",
			enabled: plugin.Enabled !== false,
		}))
		.filter((plugin) => plugin.name.length > 0)
}

export const auditPlugins = (uproject: Record<string, unknown>): ProjectPluginAudit => {
	const plugins = normalizePluginList(uproject)
	const enabledNames = new Set(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.name))
	const missing = REQUIRED_PLUGINS.filter((name) => !enabledNames.has(name))
	const optionalMissing = OPTIONAL_PLUGINS.filter((name) => !enabledNames.has(name))

	return {
		required: [...REQUIRED_PLUGINS],
		enabled: [...enabledNames].sort(),
		missing,
		optionalMissing,
	}
}

const getIniValue = (
	ini: Record<string, Record<string, string>>,
	sectionName: string,
	key: string,
): string | undefined => {
	const sectionKey = Object.keys(ini).find((section) => section.toLowerCase() === sectionName.toLowerCase())
	if (!sectionKey) {
		return undefined
	}
	const entryKey = Object.keys(ini[sectionKey]).find((entry) => entry.toLowerCase() === key.toLowerCase())
	return entryKey ? ini[sectionKey][entryKey] : undefined
}

const truthy = (value: string | undefined): boolean =>
	value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes"

export const auditConfig = (uproject: Record<string, unknown>, ini: Record<string, Record<string, string>>): ProjectConfigAudit => {
	const engineAssociation =
		typeof uproject.EngineAssociation === "string" ? uproject.EngineAssociation : undefined
	const enabledValue = getIniValue(
		ini,
		"/Script/PythonScriptPlugin.PythonScriptPluginSettings",
		"bRemoteExecution",
	)
	const bindAddress = getIniValue(
		ini,
		"/Script/PythonScriptPlugin.PythonScriptPluginSettings",
		"RemoteExecutionMulticastBindAddress",
	)
	const ttl = getIniValue(
		ini,
		"/Script/PythonScriptPlugin.PythonScriptPluginSettings",
		"RemoteExecutionMulticastTtl",
	)
	const findings: string[] = []

	if (!truthy(enabledValue)) {
		findings.push("Python remote execution is not enabled in Config/DefaultEngine.ini.")
	}
	if (bindAddress !== "127.0.0.1") {
		findings.push("Python remote execution is not bound to 127.0.0.1.")
	}
	if (ttl !== "0") {
		findings.push("Python remote execution multicast TTL is not 0.")
	}

	return {
		engineAssociation,
		pythonRemoteExecution: {
			enabled: truthy(enabledValue),
			bindAddress,
			ttl,
		},
		findings,
	}
}

export const flattenCvarSettings = (ini: Record<string, Record<string, string>>): Record<string, string> => {
	const settings: Record<string, string> = {}
	for (const section of Object.values(ini)) {
		for (const [key, value] of Object.entries(section)) {
			if (key.startsWith("r.") || key.startsWith("p.")) {
				settings[key] = value
			}
		}
	}
	return settings
}

export const auditCvars = (
	settings: Record<string, string>,
	availability: Record<string, ViteCvarReading>,
	compileSwitchStatus: Record<string, boolean | undefined>,
): ProjectCvarAudit => {
	const findings: ProjectCvarFinding[] = []

	for (const [cvar, value] of Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))) {
		const definition = getViteCvarDefinition(cvar)
		const reading = availability[cvar]

		if (definition) {
			if (definition.readOnly) {
				findings.push({
					cvar,
					value,
					issue: "read_only",
					severity: "warning",
					detail: "This cvar is read-only; a configured value is not meaningful.",
				})
			}
			if (definition.compiledOutByDefault && reading?.available !== true) {
				findings.push({
					cvar,
					value,
					issue: "compiled_out",
					severity: "warning",
					detail: "This cvar is compiled out in this Vite build; the configured value has no effect.",
				})
			}
			if (definition.requires) {
				const switchState = compileSwitchStatus[definition.requires]
				if (switchState === false || reading?.available !== true) {
					findings.push({
						cvar,
						value,
						issue: "requires_switch",
						severity: "warning",
						detail: `Requires ${definition.requires}. Verify that the build enables it.`,
					})
				}
			}
		} else if (cvar.startsWith("p.VitePhysXFixedTimestep.")) {
			const switchState = compileSwitchStatus.VITE_PHYSX_FIXED_TIMESTEP
			findings.push({
				cvar,
				value,
				issue: switchState === false ? "requires_switch" : "requires_unknown",
				severity: "warning",
				detail: "Requires VITE_PHYSX_FIXED_TIMESTEP. Verify the build flag before relying on this cvar.",
			})
		} else if (cvar.startsWith("r.Vite.")) {
			findings.push({
				cvar,
				value,
				issue: "unknown_vite_cvar",
				severity: "info",
				detail: "This Vite cvar is not in the current catalog. Verify it against the Vite documentation.",
			})
		}
	}

	return { settings, findings }
}

export const buildProjectAudit = (
	files: ProjectFiles,
	availability: Record<string, ViteCvarReading>,
): ProjectAuditResult => {
	const compileSwitches = buildCompileSwitchStatus(viteCompileSwitches, availability)
	const settings = flattenCvarSettings(files.ini)
	const plugins = auditPlugins(files.uproject)
	const config = auditConfig(files.uproject, files.ini)
	const cvars = auditCvars(settings, availability, compileSwitches)

	return {
		projectFile: files.projectFile,
		projectDir: files.projectDir,
		plugins,
		config,
		cvars,
		compileSwitches,
		ok: plugins.missing.length === 0 && config.findings.length === 0,
		generatedAt: new Date().toISOString(),
	}
}
