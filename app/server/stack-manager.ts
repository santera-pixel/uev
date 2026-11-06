import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { getRemoteExecutionStatus, tryRunCommand } from "./remote-execution.js"
import {
	defaultSupervisorPipe,
	envFlag,
	envValue,
	installRootFolder,
	supervisorExeName,
} from "./identity.js"

export type StackMode = "auto" | "attach" | "launch" | "restart"

export interface StackConfig {
	project: string
	editor: string
	supervisor: string
	mcpEntry: string
	node: string
	profile: string
	pipe: string
	controlPort: number
	autoLaunch: boolean
	source: string
	configPath?: string
}

export interface StackControlApiStatus {
	healthy: boolean
	port?: number
	profile?: string
	pid?: number
	supervisorConnected?: boolean
	error?: string
}

export interface StackStatus {
	success: boolean
	mode?: StackMode
	action?: string
	config: StackConfig
	editorRunning: boolean
	supervisorConnected: boolean
	supervisorPid?: number
	controlApi: StackControlApiStatus
	remote: {
		started: boolean
		connected: boolean
		lastCommand?: unknown
	}
	ready: boolean
	error?: string
}

interface StackConfigFile {
	project?: string
	editor?: string
	supervisor?: string
	mcpEntry?: string
	node?: string
	profile?: string
	pipe?: string
	controlPort?: number
	autoLaunch?: boolean
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const readJson = <T>(filePath: string): T | undefined => {
	try {
		const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")
		return JSON.parse(text) as T
	} catch {
		return undefined
	}
}

const firstExisting = (candidates: Array<string | undefined>): string => {
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate
		}
	}
	return ""
}

const localAppData = () =>
	process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local")

// A directory-valued supervisor config points at the UEV install root, which holds one image.
const supervisorExeInDirectory = (directory: string): string =>
	path.join(directory, supervisorExeName)

const defaultDescriptorPath = () => path.join(localAppData(), installRootFolder, "control.json")
const defaultStackConfigPath = () => path.join(localAppData(), installRootFolder, "stack.json")

const findProjectIn = (directory: string): string => {
	try {
		const entries = fs.readdirSync(directory, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.isFile() && entry.name.toLowerCase().endsWith(".uproject")) {
				return path.join(directory, entry.name)
			}
		}
	} catch {
		// Ignore unreadable working directories.
	}
	return ""
}

const argValue = (args: string[], name: string): string | undefined => {
	const index = args.indexOf(name)
	if (index >= 0 && index + 1 < args.length) {
		return args[index + 1]
	}
	return undefined
}

const stripPipePrefix = (value: string) => value.replace(/^\\\\\.\\pipe\\/i, "").replace(/^\\\\?\\pipe\\/i, "")

const normalizePort = (value: unknown): number | undefined => {
	const port = Number(value)
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

export class StackManager {
	private readonly config: StackConfig
	private supervisorChild: ChildProcess | undefined
	private controlApiChild: ChildProcess | undefined
	private ensurePromise: Promise<StackStatus> | undefined

	constructor() {
		this.config = this.resolveConfig()
	}

	getConfig = (): StackConfig => ({ ...this.config })

	private resolveConfig = (): StackConfig => {
		const args = process.argv.slice(2)
		const configPath =
			argValue(args, "--stack-config") ||
			envValue("STACK_CONFIG") ||
			defaultStackConfigPath()
		const fileConfig = readJson<StackConfigFile>(configPath)
		const fromFile = fileConfig ? "installed" : "defaults"

		const project =
			argValue(args, "--project") ||
			envValue("PROJECT") ||
			fileConfig?.project ||
			findProjectIn(process.cwd()) ||
			""
		const editor =
			argValue(args, "--editor") ||
			envValue("EDITOR") ||
			fileConfig?.editor ||
			""
		const supervisorValue =
			argValue(args, "--supervisor") ||
			envValue("SUPERVISOR_EXE") ||
			fileConfig?.supervisor ||
			firstExisting([
				path.join(localAppData(), installRootFolder, "supervisor", supervisorExeName),
				path.resolve(path.dirname(process.argv[1] ?? ""), "..", "..", "supervisor", supervisorExeName),
				path.resolve(
					path.dirname(process.argv[1] ?? ""),
					"..",
					"..",
					"supervisor",
					"bin",
					"Release",
					"net9.0",
					supervisorExeName,
				),
			])
		const supervisor =
			supervisorValue &&
			fs.existsSync(supervisorValue) &&
			fs.statSync(supervisorValue).isDirectory()
				? supervisorExeInDirectory(supervisorValue)
				: supervisorValue
		const mcpEntry =
			argValue(args, "--mcp-entry") ||
			envValue("MCP_ENTRY") ||
			fileConfig?.mcpEntry ||
			path.resolve(process.argv[1] ?? "")
		const node =
			argValue(args, "--node") ||
			envValue("NODE") ||
			fileConfig?.node ||
			process.execPath
		const profile =
			envValue("PROFILE") || fileConfig?.profile || "supervised"
		const pipe = stripPipePrefix(
			argValue(args, "--pipe") ||
				envValue("SUPERVISOR_PIPE") ||
				fileConfig?.pipe ||
				defaultSupervisorPipe,
		)
		const controlPort =
			normalizePort(argValue(args, "--control-port")) ??
			normalizePort(envValue("CONTROL_PORT")) ??
			normalizePort(fileConfig?.controlPort) ??
			8765
		const autoLaunch =
			args.includes("--auto-launch") ||
			envFlag("AUTO_LAUNCH") ||
			fileConfig?.autoLaunch === true

		const source = args.some((arg) => arg.startsWith("--stack-config") || arg === "--project")
			? "cli"
			: envValue("STACK_CONFIG") || envValue("PROJECT")
				? "env"
				: fromFile

		return {
			project,
			editor,
			supervisor,
			mcpEntry,
			node,
			profile,
			pipe,
			controlPort,
			autoLaunch,
			source,
			configPath: fileConfig ? configPath : undefined,
		}
	}

	private isEditorRunning = (): boolean => {
		if (process.platform !== "win32") {
			return false
		}
		try {
			const output = execFileSync(
				"tasklist",
				["/FI", "IMAGENAME eq UE4Editor.exe", "/FO", "CSV", "/NH"],
				{ encoding: "utf8", windowsHide: true, timeout: 5000 },
			)
			return output.toLowerCase().includes("ue4editor.exe")
		} catch {
			return false
		}
	}

	private isSupervisorConnected = async (): Promise<boolean> => {
		if (!this.config.pipe) {
			return false
		}
		return new Promise((resolve) => {
			const socket = net.connect({ path: `\\\\.\\pipe\\${this.config.pipe}` })
			let settled = false
			const finish = (value: boolean) => {
				if (settled) {
					return
				}
				settled = true
				socket.removeAllListeners()
				socket.destroy()
				resolve(value)
			}
			socket.setTimeout(600, () => finish(false))
			socket.once("connect", () => finish(true))
			socket.once("error", () => finish(false))
		})
	}

	private getSupervisorPid = (): number | undefined => {
		if (this.supervisorChild?.pid) {
			return this.supervisorChild.pid
		}
		if (process.platform !== "win32") {
			return undefined
		}
		try {
			const output = execFileSync(
				"tasklist",
				["/FI", "IMAGENAME eq " + supervisorExeName, "/FO", "CSV", "/NH"],
				{ encoding: "utf8", windowsHide: true, timeout: 5000 },
			)
			const match = output.match(
				new RegExp("\"" + supervisorExeName.replace(/\./g, "\\.") + "\",\"(\\d+)\"", "i"),
			)
			if (match) {
				return Number(match[1])
			}
		} catch {
			// No supervisor process listed.
		}
		return undefined
	}

	private readControlDescriptor = ():
		| { host?: string; port: number; token: string; pid?: number; profile?: string }
		| undefined => {
		const descriptor = readJson<{
			host?: string
			port?: number
			token?: string
			pid?: number
			profile?: string
		}>(defaultDescriptorPath())
		if (!descriptor || typeof descriptor.port !== "number" || typeof descriptor.token !== "string") {
			return undefined
		}
		return {
			host: descriptor.host,
			port: descriptor.port,
			token: descriptor.token,
			pid: descriptor.pid,
			profile: descriptor.profile,
		}
	}

	private controlHealth = async (): Promise<StackControlApiStatus> => {
		const descriptor = this.readControlDescriptor()
		if (!descriptor) {
			return { healthy: false, error: "control descriptor not found" }
		}

		return new Promise((resolve) => {
			const request = http.get(
				{
					host: descriptor.host ?? "127.0.0.1",
					port: descriptor.port,
					path: "/api/health",
					headers: { Authorization: `Bearer ${descriptor.token}` },
					timeout: 1500,
				},
				(response) => {
					const chunks: Buffer[] = []
					response.on("data", (chunk: Buffer) => chunks.push(chunk))
					response.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8")
						let payload:
							| { ok?: boolean; profile?: string; pid?: number; supervisor?: { connected?: boolean } }
							| undefined
						try {
							payload = JSON.parse(text)
						} catch {
							payload = undefined
						}
						resolve({
							healthy: Boolean(response.statusCode === 200 && payload?.ok),
							port: descriptor.port,
							profile: payload?.profile ?? descriptor.profile,
							pid: payload?.pid ?? descriptor.pid,
							supervisorConnected: payload?.supervisor?.connected,
							error: payload?.ok ? undefined : `health returned ${response.statusCode}`,
						})
					})
				},
			)
			request.on("timeout", () => {
				request.destroy()
				resolve({ healthy: false, port: descriptor.port, error: "health timeout" })
			})
			request.on("error", (error) => {
				resolve({ healthy: false, port: descriptor.port, error: error.message })
			})
		})
	}

	private controlCall = async (
		tool: string,
		action: string,
		params: Record<string, unknown>,
	): Promise<string> => {
		const descriptor = this.readControlDescriptor()
		if (!descriptor) {
			throw new Error("UEV control API descriptor not found.")
		}

		const body = JSON.stringify({ tool, action, params })
		return new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: descriptor.host ?? "127.0.0.1",
					port: descriptor.port,
					path: "/api/call",
					method: "POST",
					headers: {
						Authorization: `Bearer ${descriptor.token}`,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
					},
					timeout: 120_000,
				},
				(response) => {
					const chunks: Buffer[] = []
					response.on("data", (chunk: Buffer) => chunks.push(chunk))
					response.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8")
						try {
							const payload = JSON.parse(text) as { ok?: boolean; text?: string; error?: string }
							if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
								resolve(payload.text ?? text)
								return
							}
							reject(new Error(payload.error ?? `Control API returned ${response.statusCode}.`))
						} catch {
							reject(new Error(`Invalid control API response: ${text.slice(0, 200)}`))
						}
					})
				},
			)
			request.on("timeout", () => {
				request.destroy()
				reject(new Error("Control API request timed out."))
			})
			request.on("error", reject)
			request.write(body)
			request.end()
		})
	}

	status = async (): Promise<StackStatus> => {
		const remote = getRemoteExecutionStatus()
		const controlApi = await this.controlHealth()
		const editorRunning = this.isEditorRunning()
		const supervisorConnected =
			controlApi.supervisorConnected ?? (await this.isSupervisorConnected())
		return {
			success: true,
			config: this.getConfig(),
			editorRunning,
			supervisorConnected,
			supervisorPid: this.getSupervisorPid(),
			controlApi,
			remote: {
				started: remote.started,
				connected: remote.connected,
				lastCommand: remote.lastCommand,
			},
			ready: editorRunning && controlApi.healthy,
		}
	}

	private waitForReady = async (waitMs: number): Promise<StackStatus> => {
		const deadline = Date.now() + Math.max(1000, waitMs)
		let last = await this.status()
		while (Date.now() < deadline) {
			if (last.ready) {
				return last
			}
			await delay(500)
			last = await this.status()
		}
		return last
	}

	private spawnSupervisor = (): void => {
		const args = [
			"--editor",
			this.config.editor,
			"--project",
			this.config.project,
			"--pipe",
			this.config.pipe,
			"--control-api",
			"--mcp-entry",
			this.config.mcpEntry,
			"--mcp-node",
			this.config.node,
			"--mcp-profile",
			this.config.profile,
			"--control-port",
			String(this.config.controlPort),
		]
		const env = { ...process.env }
		delete env.UEV_CONTROL_DESCRIPTOR
		env.UEV_CONTROL_PORT = String(this.config.controlPort)
		const child = spawn(this.config.supervisor, args, {
			cwd: path.dirname(this.config.supervisor),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env,
		})
		child.unref()
		this.supervisorChild = child
	}

	private spawnControlApi = (): void => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			UEV_CONTROL_PORT: String(this.config.controlPort),
			UEV_PROFILE: this.config.profile,
			UEV_BIND_ADDRESS: "127.0.0.1",
			UEV_COMMAND_ADDRESS: "127.0.0.1",
			UEV_MULTICAST_TTL: "0",
			UEV_SUPERVISOR_PIPE: `\\\\.\\pipe\\${this.config.pipe}`,
		}
		delete env.UEV_CONTROL_DESCRIPTOR
		const child = spawn(this.config.node, [this.config.mcpEntry, "--control"], {
			cwd: path.dirname(this.config.mcpEntry),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env,
		})
		child.unref()
		this.controlApiChild = child
	}

	private validateLaunchInputs = (): string[] => {
		const missing: string[] = []
		if (!this.config.project || !fs.existsSync(this.config.project)) {
			missing.push(`project (${this.config.project || "not configured"})`)
		}
		if (!this.config.editor || !fs.existsSync(this.config.editor)) {
			missing.push(`editor (${this.config.editor || "not configured"})`)
		}
		if (!this.config.supervisor || !fs.existsSync(this.config.supervisor)) {
			missing.push(`supervisor (${this.config.supervisor || "not configured"})`)
		}
		if (!this.config.mcpEntry || !fs.existsSync(this.config.mcpEntry)) {
			missing.push(`mcpEntry (${this.config.mcpEntry || "not configured"})`)
		}
		return missing
	}

	ensure = async (mode: StackMode = "auto", waitMs = 60_000): Promise<StackStatus> => {
		if (this.ensurePromise) {
			return this.ensurePromise
		}

		this.ensurePromise = (async () => {
			const before = await this.status()
			const action: Exclude<StackMode, "auto"> =
				mode === "auto" ? (before.editorRunning ? "attach" : "launch") : mode

			if (action === "attach") {
				if (!before.editorRunning) {
					throw new Error(
						"Unreal Editor is not running. Use manage_stack.ensure with mode='launch' to start it.",
					)
				}
				if (!before.controlApi.healthy) {
					const missing = [
						!this.config.mcpEntry ? "mcpEntry" : "",
					].filter(Boolean)
					if (missing.length > 0) {
						throw new Error(`Cannot start the control API: missing ${missing.join(", ")}.`)
					}
					this.spawnControlApi()
				}
				const after = await this.waitForReady(waitMs)
				return { ...after, mode, action }
			}

			if (action === "launch" || action === "restart") {
				if (action === "restart") {
					await this.stop()
					for (let index = 0; index < 60; index += 1) {
						if (!this.isEditorRunning()) {
							break
						}
						await delay(500)
					}
				} else if (this.isEditorRunning()) {
					throw new Error(
						"Unreal Editor is already running. Use manage_stack.ensure with mode='attach', or restart.",
					)
				}

				const missing = this.validateLaunchInputs()
				if (missing.length > 0) {
					throw new Error(
						`Cannot launch the UEV stack. Missing ${missing.join(", ")}. Run the installer with -RegisterCommandCode or provide a stack config.`,
					)
				}

				if (!before.supervisorConnected) {
					this.spawnSupervisor()
				}
				const after = await this.waitForReady(waitMs)
				if (!after.ready) {
					throw new Error(
						`The stack did not become ready within ${Math.round(waitMs / 1000)}s. ${after.controlApi.error ?? ""}`.trim(),
					)
				}
				return { ...after, mode, action }
			}

			throw new Error(`Unsupported stack mode: ${mode}`)
		})()

		try {
			return await this.ensurePromise
		} finally {
			this.ensurePromise = undefined
		}
	}

	relaunch = async (
		options: { build?: boolean; discard?: boolean; waitMs?: number } = {},
	): Promise<StackStatus & { buildExitCode?: number; buildOutput?: string }> => {
		const build = options.build ?? true
		const waitMs = options.waitMs ?? 120_000
		const before = await this.status()
		if (before.editorRunning && !options.discard) {
			throw new Error(
				"Unreal Editor is running. Pass discard:true to close it without saving, or save and close it first.",
			)
		}

		if (before.editorRunning) {
			const quitCode = [
				"import unreal",
				"__mcp_level = unreal.EditorLevelLibrary.get_editor_world().get_path_name()",
				"unreal.EditorLevelLibrary.load_level(__mcp_level)",
				"unreal.SystemLibrary.quit_editor()",
			].join("\n")
			try {
				if (before.controlApi.healthy) {
					await this.controlCall("manage_editor", "run_python_checked", { code: quitCode })
				} else {
					await tryRunCommand(quitCode)
				}
			} catch {
				// The calling control API is expected to disappear with the editor. The
				// process check below is the source of truth.
				try {
					await tryRunCommand(quitCode)
				} catch {
					// The editor may already be shutting down.
				}
			}
			if (!(await this.waitForEditorExit(60_000))) {
				throw new Error("Unreal Editor did not exit after quit_editor().")
			}
		}

		let buildExitCode: number | undefined
		let buildOutput: string | undefined
		if (build) {
			const buildResult = this.runBuild()
			buildExitCode = buildResult.exitCode
			buildOutput = buildResult.output
			if (buildExitCode !== 0) {
				return {
					success: false,
					config: this.getConfig(),
					editorRunning: false,
					supervisorConnected: false,
					controlApi: { healthy: false, error: "build failed" },
					remote: { started: false, connected: false },
					ready: false,
					action: "relaunch",
					error: `Build failed with exit code ${buildExitCode}.`,
					buildExitCode,
					buildOutput,
				}
			}
		}

		this.spawnSupervisor()
		const after = await this.waitForReady(waitMs)
		if (!after.ready) {
			throw new Error(
				`The stack did not become ready after relaunch. ${after.controlApi.error ?? ""}`.trim(),
			)
		}
		return { ...after, action: "relaunch", buildExitCode, buildOutput }
	}

	private waitForEditorExit = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (!this.isEditorRunning()) {
				return true
			}
			await delay(500)
		}
		return !this.isEditorRunning()
	}

	private runBuild = (): { exitCode: number; output: string } => {
		const editorDirectory = path.dirname(this.config.editor)
		const engineRoot = path.resolve(editorDirectory, "..", "..", "..")
		const buildBat = path.join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat")
		const projectName = path.basename(this.config.project, path.extname(this.config.project))
		const target = `${projectName}Editor`
		const result = spawnSync(
			"cmd.exe",
			[
				"/d",
				"/c",
				"call",
				buildBat,
				target,
				"Win64",
				"Development",
				this.config.project,
				"-WaitMutex",
				"-FromMsBuild",
			],
			{
				encoding: "utf8",
				timeout: 600_000,
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024,
			},
		)
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
		if (result.error) {
			return { exitCode: -1, output: `${output}\n${result.error.message}`.trim() }
		}
		return { exitCode: result.status ?? -1, output }
	}

	/**
	 * Stop a supervisor this client did not spawn itself. The descriptor is the only trustworthy
	 * source for the pid, and the pid is only signalled when it really is the supervisor image.
	 */
	private stopSupervisorFromDescriptor = (): void => {
		if (process.platform !== "win32") {
			return
		}
		const descriptorPath = path.join(localAppData(), installRootFolder, "control.json")
		try {
			const descriptor = readJson<{ pid?: number }>(descriptorPath)
			const pid = Number(descriptor?.pid)
			if (!Number.isInteger(pid) || pid <= 0) {
				return
			}
			const listed = execFileSync(
				"tasklist",
				["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"],
				{ encoding: "utf8", windowsHide: true, timeout: 5000 },
			).toLowerCase()
			if (!listed.includes(supervisorExeName.toLowerCase())) {
				return
			}
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 })
		} catch {
			// No descriptor, stale pid, or already stopped: nothing to clean up.
		}
	}

	stop = async (): Promise<StackStatus> => {
		for (const child of [this.supervisorChild, this.controlApiChild]) {
			if (!child || child.killed) {
				continue
			}
			try {
				child.kill()
			} catch {
				// Best-effort process cleanup.
			}
		}
		this.supervisorChild = undefined
		this.controlApiChild = undefined
		this.stopSupervisorFromDescriptor()
		await delay(500)
		const status = await this.status()
		return { ...status, action: "stop" }
	}
}
