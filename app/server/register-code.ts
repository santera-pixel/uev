import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import { findNewestLog, tailFile } from "./debug/log-reader.js"
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

interface CodeEnvironment {
	projectFile: string
	projectDir: string
	savedDir: string
	projectName: string
	engineDir: string
	engineVersion: string
}

interface LiveCodingStatus {
	moduleLoaded: boolean
	nativeModuleLoaded: boolean
	moduleDll: string
	moduleDllExists: boolean
	liveCodingInfo: string
	liveCodingInfoExists: boolean
	plugins: string[]
	source?: string
	pluginDetails?: Record<string, unknown>
}

interface SourceFile {
	path: string
	relativePath: string
	name: string
	extension: string
	size: number
	mtimeMs: number
	modifiedAt: string
}

interface LogFile {
	path: string
	relativePath: string
	name: string
	size: number
	mtimeMs: number
	modifiedAt: string
}

const SOURCE_EXTENSIONS = new Set([".h", ".hpp", ".cpp", ".c", ".cs", ".inl"])
const LOG_EXTENSIONS = new Set([".log", ".txt"])

const readCodeEnvironment = async (
	editorTools: RegistrationContext["editorTools"],
): Promise<CodeEnvironment> => {
	const text = await tryRunCommand(editorTools.UEBuildEnv())
	const parsed = parsePythonJson(text)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Unexpected code environment response: ${text.slice(0, 200)}`)
	}
	const raw = parsed as Record<string, unknown>
	for (const key of ["project_file", "project_dir", "saved_dir", "project_name", "engine_dir", "engine_version"]) {
		if (typeof raw[key] !== "string" || !String(raw[key]).trim()) {
			throw new Error(`Code environment is missing '${key}'.`)
		}
	}
	return {
		projectFile: String(raw.project_file),
		projectDir: String(raw.project_dir),
		savedDir: String(raw.saved_dir),
		projectName: String(raw.project_name),
		engineDir: String(raw.engine_dir),
		engineVersion: String(raw.engine_version),
	}
}

const readLiveCodingStatus = async (
	editorTools: RegistrationContext["editorTools"],
	environment: CodeEnvironment,
): Promise<LiveCodingStatus> => {
	const text = await tryRunCommand(editorTools.UEPluginStatus({}, ["LiveCoding"]))
	const parsed = parsePythonJson(text)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Unexpected Live Coding status response: ${text.slice(0, 200)}`)
	}
	const raw = parsed as {
		modules?: Record<string, boolean | null>
		plugins?: string[]
		source?: string
		pluginDetails?: Record<string, unknown>
	}
	const moduleDll = path.join(environment.engineDir, "Binaries", "Win64", "UE4Editor-LiveCoding.dll")
	const liveCodingInfo = path.join(
		environment.projectDir,
		"Intermediate",
		"Build",
		"Win64",
		"UE4Editor",
		"Development",
		environment.projectName,
		"LiveCodingInfo.json",
	)
	const moduleDllExists = fs.existsSync(moduleDll)
	const liveCodingInfoExists = fs.existsSync(liveCodingInfo)
	const nativeModuleLoaded = raw.modules?.LiveCoding === true
	return {
		moduleLoaded: nativeModuleLoaded || moduleDllExists || liveCodingInfoExists,
		nativeModuleLoaded,
		moduleDll,
		moduleDllExists,
		liveCodingInfo,
		liveCodingInfoExists,
		plugins: Array.isArray(raw.plugins) ? raw.plugins.map(String) : [],
		source: raw.source,
		pluginDetails: raw.pluginDetails,
	}
}

const walkFiles = (
	root: string,
	extensions: Set<string>,
	maxDepth = 8,
): Array<{ path: string; size: number; mtimeMs: number; extension: string; name: string }> => {
	const results: Array<{
		path: string
		size: number
		mtimeMs: number
		extension: string
		name: string
	}> = []
	const visit = (directory: string, depth: number) => {
		if (depth > maxDepth || !fs.existsSync(directory)) {
			return
		}
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				visit(fullPath, depth + 1)
				continue
			}
			if (!entry.isFile()) {
				continue
			}
			const extension = path.extname(entry.name).toLowerCase()
			if (!extensions.has(extension)) {
				continue
			}
			const stats = fs.statSync(fullPath)
			results.push({
				path: fullPath,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				extension,
				name: entry.name,
			})
		}
	}
	visit(root, 0)
	return results
}

const listSourceFiles = (environment: CodeEnvironment): SourceFile[] => {
	const root = path.join(environment.projectDir, "Source")
	return walkFiles(root, SOURCE_EXTENSIONS)
		.map((file) => ({
			...file,
			relativePath: path.relative(environment.projectDir, file.path),
			modifiedAt: new Date(file.mtimeMs).toISOString(),
		}))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

const listLogFiles = (environment: CodeEnvironment): LogFile[] => {
	const roots = [
		path.join(environment.savedDir, "Logs"),
		path.join(environment.projectDir, "Intermediate", "Build"),
	]
	const files = roots.flatMap((root) => walkFiles(root, LOG_EXTENSIONS))
	return files
		.map((file) => ({
			path: file.path,
			relativePath: path.relative(environment.projectDir, file.path),
			name: file.name,
			size: file.size,
			mtimeMs: file.mtimeMs,
			modifiedAt: new Date(file.mtimeMs).toISOString(),
		}))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

const resolveProjectLog = (
	environment: CodeEnvironment,
	candidate: string,
): string => {
	const projectRoot = path.resolve(environment.projectDir)
	const resolved = path.resolve(projectRoot, candidate)
	const relative = path.relative(projectRoot, resolved)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Log path must be inside the project directory.")
	}
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`Log file not found: ${resolved}`)
	}
	return resolved
}

const automationCommand = (filter?: string) => {
	const trimmed = filter?.trim()
	return `Automation RunTests ${trimmed || "Project."}`
}

const isTestSource = (file: { name: string }) =>
	/(?:^|[_.-])(?:tests?|specs?)(?:[_.-]|$)/i.test(file.name)

const resolveSourcePath = (environment: CodeEnvironment, candidate: string) => {
	const sourceRoot = path.resolve(environment.projectDir, "Source")
	const normalized = candidate.replace(/\\/g, "/")
	const base = normalized.toLowerCase().startsWith("source/")
		? environment.projectDir
		: sourceRoot
	const resolved = path.resolve(base, candidate)
	const relative = path.relative(sourceRoot, resolved)
	const extension = path.extname(resolved).toLowerCase()
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Source path must be inside the project Source directory.")
	}
	if (!SOURCE_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported source extension '${extension}'.`)
	}
	return {
		sourceRoot,
		resolved,
		relative,
	}
}

export function registerCodeNamespace(ctx: RegistrationContext) {
	const { directDispatch, editorTools, registerToolNamespace } = ctx

	const readStatus = async () => {
		const environment = await readCodeEnvironment(editorTools)
		const liveCoding = await readLiveCodingStatus(editorTools, environment)
		const sources = listSourceFiles(environment)
		const logs = listLogFiles(environment)
		const tests = sources.filter((file) => isTestSource(file))
		const warnings: string[] = []

		if (!liveCoding.moduleLoaded) {
			warnings.push("The LiveCoding module is not loaded; compile preview is available but execution is unavailable.")
		}
		if (sources.length === 0) {
			warnings.push("No project C++ source files were found under Source.")
		}
		if (logs.length === 0) {
			warnings.push("No project log files were found.")
		}

		return {
			success: true,
			project: environment,
			liveCoding,
			source: {
				count: sources.length,
				files: sources.slice(0, 20),
			},
			logs: {
				count: logs.length,
				newest: logs[0] ?? null,
				files: logs.slice(0, 10),
			},
			tests: {
				count: tests.length,
				files: tests.slice(0, 20),
				automationCommand: automationCommand(),
			},
			warnings,
			generatedAt: new Date().toISOString(),
		}
	}

	registerToolNamespace(
		"manage_code",
		"Read-first C++ and Live Coding tooling: status, project-source read/write with backups, source inventory, build/log inspection, automation-test inventory, and supervised compile/run previews.",
		{
			status: {
				handler: async () => directDispatch(await readStatus()),
			},
			read_source: {
				paramsSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
				handler: async (params) => {
					const environment = await readCodeEnvironment(editorTools)
					const target = resolveSourcePath(environment, (params as { path: string }).path)
					if (!fs.existsSync(target.resolved) || !fs.statSync(target.resolved).isFile()) {
						throw new Error(`Source file not found: ${target.resolved}`)
					}
					const content = fs.readFileSync(target.resolved, "utf8")
					return directDispatch({
						success: true,
						path: target.resolved,
						relativePath: target.relative,
						size: Buffer.byteLength(content, "utf8"),
						content,
					})
				},
			},
			write_source: {
				paramsSchema: z
					.object({
						path: z.string().min(1).max(1024),
						content: z.string().max(256 * 1024),
						overwrite: z.boolean().optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { path: string; content: string; overwrite?: boolean }
					const environment = await readCodeEnvironment(editorTools)
					const target = resolveSourcePath(environment, value.path)
					const exists = fs.existsSync(target.resolved)
					if (exists && !value.overwrite) {
						throw new Error("Source file exists; set overwrite=true to replace it.")
					}
					let backup: string | null = null
					if (exists) {
						const backupRoot = path.join(
							environment.savedDir,
							"MCP",
							"SourceBackups",
							new Date().toISOString().replace(/[:.]/g, "-"),
						)
						backup = path.join(backupRoot, target.relative)
						fs.mkdirSync(path.dirname(backup), { recursive: true })
						fs.copyFileSync(target.resolved, backup)
					}
					fs.mkdirSync(path.dirname(target.resolved), { recursive: true })
					fs.writeFileSync(target.resolved, value.content, "utf8")
					return directDispatch({
						success: true,
						path: target.resolved,
						relativePath: target.relative,
						bytes: Buffer.byteLength(value.content, "utf8"),
						backup,
						created: !exists,
					})
				},
			},
			sources: {
				paramsSchema: z
					.object({
						filter: z.string().min(1).max(200).optional(),
						limit: z.number().int().min(1).max(200).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { filter?: string; limit?: number }
					const environment = await readCodeEnvironment(editorTools)
					const files = listSourceFiles(environment).filter((file) =>
						value.filter
							? file.relativePath.toLowerCase().includes(value.filter.toLowerCase())
							: true,
					)
					return directDispatch({
						success: true,
						project: environment,
						total: files.length,
						files: files.slice(0, value.limit ?? 100),
						generatedAt: new Date().toISOString(),
					})
				},
			},
			logs: {
				paramsSchema: z
					.object({
						path: z.string().min(1).max(4096).optional(),
						lines: z.number().int().min(1).max(500).optional(),
						filter: z.string().min(1).max(200).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { path?: string; lines?: number; filter?: string }
					const environment = await readCodeEnvironment(editorTools)
					if (!value.path) {
						const logs = listLogFiles(environment)
						const editorLog = findNewestLog(path.join(environment.savedDir, "Logs"))
						return directDispatch({
							success: true,
							project: environment,
							editorLog: editorLog ?? null,
							total: logs.length,
							files: logs.slice(0, 50),
							generatedAt: new Date().toISOString(),
						})
					}
					const logPath = resolveProjectLog(environment, value.path)
					const requestedLines = value.lines ?? 200
					// A filtered read must search beyond the small default tail; log markers
					// from a completed phase are often thousands of lines back.
					const text = tailFile(
						logPath,
						value.filter ? Math.max(requestedLines, 5000) : requestedLines,
						value.filter,
					)
					return directDispatch({
						success: true,
						project: environment,
						logPath,
						lines: value.filter ? Math.max(requestedLines, 5000) : requestedLines,
						filter: value.filter ?? null,
						text,
					})
				},
			},
			tests: {
				paramsSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
				handler: async (params) => {
					const value = params as { limit?: number }
					const environment = await readCodeEnvironment(editorTools)
					const tests = listSourceFiles(environment).filter((file) => isTestSource(file))
					return directDispatch({
						success: true,
						project: environment,
						total: tests.length,
						files: tests.slice(0, value.limit ?? 100),
						automationCommand: automationCommand(),
						note: "Automation tests are listed from Source names. Use run_tests with confirm=true to execute the allowlisted Automation command.",
						generatedAt: new Date().toISOString(),
					})
				},
			},
			compile: {
				paramsSchema: z
					.object({
						confirm: z.boolean().optional(),
						waitMs: z.number().int().min(100).max(10000).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { confirm?: boolean; waitMs?: number }
					const environment = await readCodeEnvironment(editorTools)
					const liveCoding = await readLiveCodingStatus(editorTools, environment)
					const command = "LiveCoding.Compile"
					const logPath = findNewestLog(path.join(environment.savedDir, "Logs")) ?? null

					if (!value.confirm) {
						return directDispatch({
							success: true,
							preview: true,
							command,
							available: liveCoding.moduleLoaded,
							liveCoding,
							logPath,
							note: "Set confirm=true to run the Live Coding compile. It is supervised and may reload editor modules.",
						})
					}
					if (!liveCoding.moduleLoaded) {
						return directDispatch({
							success: false,
							preview: false,
							command,
							available: false,
							liveCoding,
							message: "The LiveCoding module is not loaded; compile cannot run.",
						})
					}

					await tryRunCommand(editorTools.UEConsoleCommand(command))
					await new Promise((resolve) => setTimeout(resolve, value.waitMs ?? 1000))
					const text = logPath ? tailFile(logPath, 200, "LiveCoding") : ""
					return directDispatch({
						success: true,
						preview: false,
						command,
						available: true,
						liveCoding,
						logPath,
						text,
						capturedAt: new Date().toISOString(),
						note: "Live Coding compile was requested; inspect the editor and log for results.",
					})
				},
			},
			run_tests: {
				paramsSchema: z
					.object({
						filter: z.string().min(1).max(200).optional(),
						confirm: z.boolean().optional(),
						waitMs: z.number().int().min(100).max(10000).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { filter?: string; confirm?: boolean; waitMs?: number }
					const environment = await readCodeEnvironment(editorTools)
					const command = automationCommand(value.filter)
					const logPath = findNewestLog(path.join(environment.savedDir, "Logs")) ?? null
					if (!value.confirm) {
						return directDispatch({
							success: true,
							preview: true,
							command,
							logPath,
							note: "Set confirm=true to run the automation command. It is supervised.",
						})
					}
					await tryRunCommand(editorTools.UEConsoleCommand(command))
					await new Promise((resolve) => setTimeout(resolve, value.waitMs ?? 1000))
					const text = logPath ? tailFile(logPath, 200, "Automation") : ""
					return directDispatch({
						success: true,
						preview: false,
						command,
						logPath,
						text,
						capturedAt: new Date().toISOString(),
						note: "Automation run requested; inspect the editor and log for results.",
					})
				},
			},
		},
	)
}
