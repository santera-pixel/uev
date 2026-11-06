import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import type { RegistrationContext } from "./registration-context.js"
import { tryRunCommand } from "./remote-execution.js"

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

interface BuildEnvironment {
	projectFile: string
	projectDir: string
	savedDir: string
	projectName: string
	engineDir: string
	engineVersion: string
	buildId?: string
}

interface BuildVersion {
	MajorVersion?: number
	MinorVersion?: number
	PatchVersion?: number
	Changelist?: number
	BranchName?: string
	BuildId?: string
}

const BUILD_ACTIONS = [
	"build_editor",
	"cook",
	"package",
	"ddc_fill",
	"ddc_verify",
	"vite_setup",
	"wipe_shader_cache",
	"debloat",
] as const

const quoteWindows = (value: string) => `"${value.replace(/"/g, '""')}"`

const readBuildEnvironment = async (
	editorTools: RegistrationContext["editorTools"],
): Promise<BuildEnvironment> => {
	const text = await tryRunCommand(editorTools.UEBuildEnv())
	const parsed = parsePythonJson(text)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Unexpected build environment response: ${text.slice(0, 200)}`)
	}
	const raw = parsed as Record<string, unknown>
	const required = [
		"project_file",
		"project_dir",
		"saved_dir",
		"project_name",
		"engine_dir",
		"engine_version",
	]
	for (const key of required) {
		if (typeof raw[key] !== "string" || !String(raw[key]).trim()) {
			throw new Error(`Build environment is missing '${key}'.`)
		}
	}
	return {
		projectFile: String(raw.project_file),
		projectDir: String(raw.project_dir),
		savedDir: String(raw.saved_dir),
		projectName: String(raw.project_name),
		engineDir: String(raw.engine_dir),
		engineVersion: String(raw.engine_version),
		buildId: typeof raw.build_id === "string" ? raw.build_id : undefined,
	}
}

const buildPaths = (environment: BuildEnvironment) => {
	const engineRoot = path.resolve(environment.engineDir, "..")
	return {
		engineRoot,
		engineDir: environment.engineDir,
		projectFile: environment.projectFile,
		projectDir: environment.projectDir,
		savedDir: environment.savedDir,
		engineSource: path.join(engineRoot, "Engine", "Source"),
		viteSetup: path.join(engineRoot, "ViteSetup.bat"),
		viteDefaults: path.join(engineRoot, "ViteDefaults.bat"),
		buildBat: path.join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		runUat: path.join(engineRoot, "RunUAT.bat"),
		editorCmd: path.join(engineRoot, "Engine", "Binaries", "Win64", "UE4Editor-Cmd.exe"),
		editorExe: path.join(engineRoot, "Engine", "Binaries", "Win64", "UE4Editor.exe"),
		buildVersion: path.join(engineRoot, "Engine", "Build", "Build.version"),
		wipeShaderCache: path.join(engineRoot, "WipeShaderCache.bat"),
		excludedPlugins: path.join(engineRoot, "ExcludedPlugins.txt"),
		debloatMoved: "D:\\ViteDebloat_Moved",
	}
}

const readBuildVersion = (filePath: string): BuildVersion | undefined => {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
		return parsed && typeof parsed === "object" ? (parsed as BuildVersion) : undefined
	} catch {
		return undefined
	}
}

const auditBuildEnvironment = async (
	editorTools: RegistrationContext["editorTools"],
) => {
	const environment = await readBuildEnvironment(editorTools)
	const paths = buildPaths(environment)
	const checks = Object.fromEntries(
		Object.entries(paths)
			.filter(
				([key]) =>
					key !== "engineRoot" &&
					key !== "engineDir" &&
					key !== "projectDir" &&
					key !== "savedDir",
			)
			.map(([key, value]) => [key, fs.existsSync(value)]),
	)
	const buildVersion = readBuildVersion(paths.buildVersion)
	const warnings: string[] = []

	const requiredPaths = [
		"projectFile",
		"viteSetup",
		"buildBat",
		"runUat",
		"editorCmd",
		"editorExe",
	] as const
	for (const key of requiredPaths) {
		if (!checks[key]) {
			warnings.push(`Missing required build path: ${paths[key]}`)
		}
	}
	if (!checks.wipeShaderCache) {
		warnings.push(`Shader-cache wipe script not found: ${paths.wipeShaderCache}`)
	}
	if (!checks.excludedPlugins) {
		warnings.push(`Debloat exclusion list not found: ${paths.excludedPlugins}`)
	}
	if (!checks.debloatMoved) {
		warnings.push(`Moved plugin directory not found: ${paths.debloatMoved}`)
	}

	let engineSourceWritable = false
	try {
		fs.accessSync(paths.engineSource, fs.constants.W_OK)
		engineSourceWritable = true
	} catch {
		engineSourceWritable = false
	}
	if (engineSourceWritable) {
		warnings.push("Engine source is writable on disk; the read-only engine policy still applies.")
	}
	if (environment.buildId && buildVersion?.BuildId && environment.buildId !== buildVersion.BuildId) {
		warnings.push(
			`UEVNative BuildId ${environment.buildId} does not match engine BuildId ${buildVersion.BuildId}.`,
		)
	}

	return {
		success: true,
		environment,
		paths,
		checks,
		buildVersion,
		engineSourceWritable,
		engineSourceReadOnlyPolicy: true,
		editorRunning: true,
		buildExecution: "deferred",
		ok: Boolean(
			checks.projectFile &&
				checks.viteSetup &&
				checks.buildBat &&
				checks.runUat &&
				checks.editorCmd &&
				checks.editorExe,
		),
		warnings,
		generatedAt: new Date().toISOString(),
		note: "Build execution is intentionally outside the editor-hosted MCP. Use plan to generate a command and run it from a standalone terminal.",
	}
}

const planBuildAction = async (
	editorTools: RegistrationContext["editorTools"],
	action: (typeof BUILD_ACTIONS)[number],
	archiveDir?: string,
) => {
	const environment = await readBuildEnvironment(editorTools)
	const paths = buildPaths(environment)
	const projectTarget = `${environment.projectName}Editor`
	const packageArchive =
		archiveDir?.trim() ||
		path.join(
			environment.savedDir,
			"MCP",
			"Packages",
			new Date().toISOString().replace(/[:.]/g, "-"),
		)

	const base = {
		success: true,
		action,
		environment,
		paths,
		requiresEditorClosed: false,
		commandlet: false,
		blocked: true,
		blockedReason:
			"This MCP server is hosted inside the editor. Build execution is intentionally deferred; copy this plan into a standalone terminal.",
		writes: [] as string[],
		preconditions: [] as string[],
		notes: [] as string[],
		generatedAt: new Date().toISOString(),
	}

	if (action === "build_editor") {
		const args = [
			projectTarget,
			"Win64",
			"Development",
			`-Project=${paths.projectFile}`,
			"-WaitMutex",
			"-FromMsBuild",
		]
		return {
			...base,
			executable: paths.buildBat,
			cwd: paths.engineRoot,
			command: [paths.buildBat, ...args].map(quoteWindows).join(" "),
			requiresEditorClosed: true,
			writes: [path.join(environment.projectDir, "Binaries"), path.join(environment.projectDir, "Intermediate")],
			preconditions: [
				"Close the editor so project binaries are not locked.",
				"Install the Visual Studio C++ toolchain.",
				"Run ViteSetup if the engine binaries are missing.",
			],
			notes: ["The MCP server cannot safely rebuild the editor process that hosts it."],
		}
	}

	if (action === "cook" || action === "package") {
		const args = [
			"BuildCookRun",
			`-project=${paths.projectFile}`,
			"-noP4",
			"-platform=Win64",
			"-clientconfig=Development",
			"-cook",
			...(action === "package" ? ["-stage", "-pak", `-archivedirectory=${packageArchive}`] : []),
		]
		return {
			...base,
			executable: paths.runUat,
			cwd: paths.engineRoot,
			command: [paths.runUat, ...args].map(quoteWindows).join(" "),
			requiresEditorClosed: true,
			writes: [
				path.join(environment.savedDir, "Cooked"),
				path.join(environment.savedDir, "StagedBuilds"),
				...(action === "package" ? [packageArchive] : []),
			],
			preconditions: ["Close the editor", "Cooked content must be valid for Win64"],
			notes: ["RunUAT writes cooked and staged content under the project saved directory."],
		}
	}

	if (action === "ddc_fill" || action === "ddc_verify") {
		const args = [
			paths.projectFile,
			"-run=DerivedDataCache",
			action === "ddc_fill" ? "-fill" : "-verify",
			"-unattended",
			"-nop4",
			"-nosplash",
			"-NoSound",
			"-stdout",
			"-FullStdOutLogOutput",
		]
		return {
			...base,
			executable: paths.editorCmd,
			cwd: paths.engineRoot,
			command: [paths.editorCmd, ...args].map(quoteWindows).join(" "),
			commandlet: true,
			writes: [path.join(environment.engineDir, "DerivedDataCache")],
			preconditions: ["The engine commandlet binary must exist", "Close PIE before a fill"],
			notes: [
				"Commandlet isolation: this is a separate UnrealEditor-Cmd process, not the editor process.",
				"Do not run this from the MCP; use the generated command outside the editor.",
			],
		}
	}

	if (action === "vite_setup") {
		return {
			...base,
			executable: paths.viteSetup,
			cwd: paths.engineRoot,
			command: quoteWindows(paths.viteSetup),
			requiresEditorClosed: true,
			writes: [
				path.join(environment.engineDir, "Source"),
				path.join(environment.engineDir, "Binaries"),
				path.join(environment.engineDir, "Intermediate"),
			],
			blockedReason:
				"Engine source is read-only by policy; ViteSetup can modify engine source. Do not run from this MCP.",
			preconditions: ["Close the editor", "Inspect ViteSetup.bat before running"],
			notes: ["This plan exists for documentation only; engine source stays untouched."],
		}
	}

	if (action === "wipe_shader_cache") {
		return {
			...base,
			executable: paths.wipeShaderCache,
			cwd: paths.engineRoot,
			command: quoteWindows(paths.wipeShaderCache),
			requiresEditorClosed: true,
			writes: [
				path.join(environment.engineDir, "DerivedDataCache"),
				path.join(environment.engineDir, "Saved", "ShaderDebugInfo"),
			],
			blockedReason:
				"Shader-cache deletion is deferred; run it from a standalone maintenance shell after closing the editor.",
			preconditions: ["Close the editor", "Confirm the cache paths before running"],
			notes: ["This deletes caches only; it does not modify engine source."],
		}
	}

	return {
		...base,
		executable: paths.viteSetup,
		cwd: paths.engineRoot,
		command: quoteWindows(paths.viteSetup),
		requiresEditorClosed: true,
		writes: [
			path.join(environment.engineDir, "Plugins"),
			path.join(environment.engineDir, "Intermediate"),
		],
		blockedReason:
			"Debloat modifies engine plugin layout; engine source is read-only and this is deferred to a standalone maintenance run.",
		preconditions: ["Close the editor", "Review ExcludedPlugins.txt"],
		notes: [`Moved plugin directory: ${paths.debloatMoved}`],
	}
}

export function registerBuildNamespace(ctx: RegistrationContext) {
	const { directDispatch, editorTools, registerToolNamespace } = ctx

	registerToolNamespace(
		"manage_build",
		"Read-only build environment audit and command planning for ViteSetup, UBT, RunUAT, DDC commandlets, cache wipe, and debloat. Build execution is intentionally deferred.",
		{
			audit: {
				handler: async () => directDispatch(await auditBuildEnvironment(editorTools)),
			},
			plan: {
				paramsSchema: z
					.object({
						action: z.enum(BUILD_ACTIONS),
						archiveDir: z.string().min(1).max(1024).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as {
						action: (typeof BUILD_ACTIONS)[number]
						archiveDir?: string
					}
					return directDispatch(
						await planBuildAction(editorTools, value.action, value.archiveDir),
					)
				},
			},
		},
	)
}
