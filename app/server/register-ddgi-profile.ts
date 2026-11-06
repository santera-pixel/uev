import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import { findNewestLog } from "./debug/log-reader.js"
import { tryRunCommand } from "./remote-execution.js"
import type { RegistrationContext } from "./registration-context.js"
import { getViteCvarDefinition, parseViteCvarValue, type ViteCvarReading } from "./vite/cvar-catalog.js"

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

interface DdgiVolume {
	label?: string
	actor_name?: string
	actor_path?: string
	actor_class?: string
	component_name?: string
	probe_count?: number
	properties?: Record<string, unknown>
}

interface DdgiResult {
	success?: boolean
	available?: boolean
	message?: string
	count?: number
	total_probes?: number
	volumes?: DdgiVolume[]
	selected?: DdgiVolume | null
}

const PROFILE_COMMANDS = [
	"stat unit",
	"stat gpu",
	"stat scenerendering",
	"stat physics",
	"stat memory",
] as const

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const readNewBytes = (filePath: string, startOffset: number, maxBytes = 256 * 1024): string => {
	const stats = fs.statSync(filePath)
	if (stats.size <= startOffset) {
		return ""
	}
	const length = Math.min(stats.size - startOffset, maxBytes)
	const buffer = Buffer.alloc(length)
	const fd = fs.openSync(filePath, "r")
	try {
		fs.readSync(fd, buffer, 0, length, Math.max(startOffset, stats.size - length))
	} finally {
		fs.closeSync(fd)
	}
	return buffer.toString("utf8")
}

const PROFILE_ARTIFACT_DIRECTORIES = ["Profiling", "Profiles", "Stats"]
const PROFILE_ARTIFACT_EXTENSIONS = new Set([".ue4stats", ".stats", ".csv", ".txt", ".json"])

interface ProfileArtifact {
	path: string
	relativePath: string
	name: string
	extension: string
	size: number
	mtimeMs: number
	modifiedAt: string
}

const collectProfileArtifacts = (savedDir: string): ProfileArtifact[] => {
	const artifacts: ProfileArtifact[] = []
	const visit = (directory: string, depth: number) => {
		if (depth > 5 || !fs.existsSync(directory)) {
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
			if (!PROFILE_ARTIFACT_EXTENSIONS.has(extension)) {
				continue
			}
			const stats = fs.statSync(fullPath)
			artifacts.push({
				path: fullPath,
				relativePath: path.relative(savedDir, fullPath),
				name: entry.name,
				extension,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				modifiedAt: new Date(stats.mtimeMs).toISOString(),
			})
		}
	}
	for (const directory of PROFILE_ARTIFACT_DIRECTORIES) {
		visit(path.join(savedDir, directory), 0)
	}
	return artifacts
}

const resolveSavedArtifact = (savedDir: string, candidate: string): string => {
	const savedRoot = path.resolve(savedDir)
	const resolved = path.resolve(savedRoot, candidate)
	const relative = path.relative(savedRoot, resolved)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Profile artifact path must be inside the project saved directory.")
	}
	return resolved
}

const findNewestArtifact = (directories: string[], afterMs: number): { path: string; mtimeMs: number; size: number } | undefined => {
	let newest: { path: string; mtimeMs: number; size: number } | undefined
	const visit = (directory: string, depth: number) => {
		if (depth > 4 || !fs.existsSync(directory)) {
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
			const stats = fs.statSync(fullPath)
			if (stats.mtimeMs < afterMs) {
				continue
			}
			if (!newest || stats.mtimeMs > newest.mtimeMs) {
				newest = { path: fullPath, mtimeMs: stats.mtimeMs, size: stats.size }
			}
		}
	}
	for (const directory of directories) {
		visit(directory, 0)
	}
	return newest
}

const ddgiProbeCountsSchema = z
	.object({
		x: z.number().int().min(1).max(32),
		y: z.number().int().min(1).max(32),
		z: z.number().int().min(1).max(32),
	})
	.strict()

const ddgiPropertiesSchema = z
	.object({
		probe_counts: ddgiProbeCountsSchema.optional(),
		probe_max_ray_distance: z.number().min(100).max(1_000_000).optional(),
		probe_history_weight: z.number().min(0).max(1).optional(),
		probe_relocation_radius: z.number().min(0).max(1000).optional(),
		probe_relocation_distance: z.number().min(0).max(1000).optional(),
		probe_change_threshold: z.number().min(0).max(1).optional(),
		probe_irradiance_encoding_gamma: z.number().min(0.1).max(10).optional(),
		probe_distance_exponent: z.number().min(1).max(100).optional(),
		probe_frontface_threshold: z.number().min(0).max(1).optional(),
		light_multiplier: z.number().min(0).max(10).optional(),
		emissive_multiplier: z.number().min(0).max(10).optional(),
		view_bias: z.number().min(-1000).max(1000).optional(),
		normal_bias: z.number().min(-1000).max(1000).optional(),
		visualize_probes: z.boolean().optional(),
		visualize_probe_radiance: z.boolean().optional(),
		visualize_probe_irradiance: z.boolean().optional(),
		visualize_probe_distance: z.boolean().optional(),
	})
	.strict()

const ddgiTransformSchema = {
	location: z
		.object({ x: z.number(), y: z.number(), z: z.number() })
		.strict()
		.optional(),
	rotation: z
		.object({ pitch: z.number(), yaw: z.number(), roll: z.number() })
		.strict()
		.optional(),
	scale: z
		.object({ x: z.number(), y: z.number(), z: z.number() })
		.strict()
		.optional(),
}

export function registerDdgiProfileNamespaces(ctx: RegistrationContext) {
	const { directDispatch, editorTools, pythonDispatch, registerToolNamespace } = ctx

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

	const readCvar = async (name: string) => {
		const reading = (await readCvars([name]))[name]
		const definition = getViteCvarDefinition(name)
		return {
			name,
			available: reading?.available === true,
			current: parseViteCvarValue(definition, reading),
			raw: reading,
		}
	}

	const readDdgi = async (name?: string): Promise<DdgiResult> => {
		const text = await tryRunCommand(editorTools.UEDDGI(name ? "inspect" : "list", name))
		const parsed = parsePythonJson(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Unexpected DDGI response: ${text.slice(0, 200)}`)
		}
		return parsed as DdgiResult
	}

	const getSavedDirectory = async (): Promise<string> => {
		const text = await tryRunCommand(editorTools.UEDebugPaths())
		const parsed = parsePythonJson(text) as { saved_dir?: unknown } | undefined
		if (!parsed || typeof parsed.saved_dir !== "string") {
			throw new Error("Could not resolve the project saved directory.")
		}
		return parsed.saved_dir
	}

	registerToolNamespace(
		"manage_ddgi",
		"Inspect, validate, and edit NVIDIA RTXGI/DDGI volumes with native undo/redo.",
		{
			list_volumes: {
				handler: async () => directDispatch(await readDdgi()),
			},
			inspect_volume: {
				paramsSchema: z.object({ name: z.string().min(1).max(200) }).strict(),
				handler: async (params) => {
					const name = String((params as { name: string }).name).trim()
					const result = await readDdgi(name)
					if (!result.selected) {
						return directDispatch({
							success: false,
							message: `No DDGI volume matched '${name}'.`,
							available: result.available === true,
							count: result.count ?? 0,
							volumes: result.volumes ?? [],
						})
					}
					return directDispatch({
						success: true,
						volume: result.selected,
						count: result.count ?? 0,
					})
				},
			},
			stats: {
				handler: async () => {
					const [volumes, ddgi, memoryUsed, statVolume] = await Promise.all([
						readDdgi(),
						readCvar("r.RTXGI.DDGI"),
						readCvar("r.RTXGI.MemoryUsed"),
						readCvar("r.RTXGI.DDGI.StatVolume"),
					])
					return directDispatch({
						success: true,
						available: volumes.available === true,
						cvars: {
							ddgi,
							memoryUsed,
							statVolume,
						},
						volumeCount: volumes.count ?? 0,
						totalProbes: volumes.total_probes ?? 0,
						volumes: volumes.volumes ?? [],
						generatedAt: new Date().toISOString(),
					})
				},
			},
			validate: {
				handler: async () => {
					const [volumes, ddgi] = await Promise.all([readDdgi(), readCvar("r.RTXGI.DDGI")])
					const issues: Array<{ severity: "error" | "warning"; code: string; message: string; volume?: string }> = []
					const volumeList = volumes.volumes ?? []
					const totalProbes = volumes.total_probes ?? 0

					if (volumes.available !== true) {
						issues.push({
							severity: "error",
							code: "rtxgi_unavailable",
							message: volumes.message ?? "The RTXGI/DDGI plugin is not available.",
						})
					}
					if (!ddgi.available) {
						issues.push({
							severity: "error",
							code: "ddgi_cvar_unavailable",
							message: "r.RTXGI.DDGI is not registered in this build.",
						})
					} else if (ddgi.current !== 1) {
						issues.push({
							severity: "warning",
							code: "ddgi_disabled",
							message: "r.RTXGI.DDGI is not set to 1; DDGI will not render.",
						})
					}
					if (volumes.available === true && volumeList.length === 0) {
						issues.push({
							severity: "error",
							code: "no_volumes",
							message: "No DDGIVolume components were found in the current level.",
						})
					}

					const labels = new Map<string, number>()
					for (const volume of volumeList) {
						const label = String(volume.label ?? volume.actor_name ?? "unnamed")
						labels.set(label, (labels.get(label) ?? 0) + 1)
						if (!volume.probe_count || volume.probe_count <= 0) {
							issues.push({
								severity: "error",
								code: "zero_probes",
								message: `DDGI volume '${label}' has no probes.`,
								volume: label,
							})
						}
					}
					for (const [label, count] of labels) {
						if (count > 1) {
							issues.push({
								severity: "warning",
								code: "duplicate_volume_labels",
								message: `${count} DDGI volumes share the label '${label}'.`,
								volume: label,
							})
						}
					}
					if (totalProbes > 1_000_000) {
						issues.push({
							severity: "warning",
							code: "probe_budget",
							message: `Total DDGI probes (${totalProbes}) exceed the 1,000,000 probe warning budget.`,
						})
					}

					return directDispatch({
						success: true,
						valid: !issues.some((issue) => issue.severity === "error"),
						issues,
						volumeCount: volumeList.length,
						totalProbes,
						ddgi,
						checkedAt: new Date().toISOString(),
					})
				},
			},
			spawn_volume: {
				paramsSchema: z
					.object({
						name: z.string().min(1).max(200).optional(),
						...ddgiTransformSchema,
						properties: ddgiPropertiesSchema.optional(),
					})
					.strict(),
				handler: (params) => {
					const value = params as {
						name?: string
						location?: { x: number; y: number; z: number }
						rotation?: { pitch: number; yaw: number; roll: number }
						scale?: { x: number; y: number; z: number }
						properties?: Record<string, unknown>
					}
					return pythonDispatch(
						editorTools.UEDDGIWrite({
							operation: "spawn",
							name: value.name,
							location: value.location,
							rotation: value.rotation,
							scale: value.scale,
							properties: value.properties,
						}),
					)
				},
			},
			update_volume: {
				paramsSchema: z
					.object({
						name: z.string().min(1).max(200),
						label: z.string().min(1).max(200).optional(),
						properties: ddgiPropertiesSchema.optional(),
					})
					.strict()
					.refine(
						(value) =>
							Boolean(value.label) ||
							Boolean(value.properties && Object.keys(value.properties).length > 0),
						"Provide a label or at least one property to update.",
					),
				handler: (params) => {
					const value = params as {
						name: string
						label?: string
						properties?: Record<string, unknown>
					}
					return pythonDispatch(
						editorTools.UEDDGIWrite({
							operation: "update",
							name: value.name,
							label: value.label,
							properties: value.properties,
						}),
					)
				},
			},
			delete_volume: {
				paramsSchema: z.object({ name: z.string().min(1).max(200) }).strict(),
				handler: (params) => {
					const value = params as { name: string }
					return pythonDispatch(
						editorTools.UEDDGIWrite({ operation: "delete", name: value.name }),
					)
				},
			},
		},
	)

	registerToolNamespace(
		"manage_profile",
		"Profiling capture with stats-file artifacts, artifact listing/inspection, log comparison, frame-budget checks, and supervised profilegpu capture.",
		{
			capture_stats: {
				paramsSchema: z
					.object({
						stats: z.array(z.enum(PROFILE_COMMANDS)).min(1).max(5).optional(),
						durationMs: z.number().int().min(100).max(5000).optional(),
					})
					.strict(),
				handler: async (params) => {
					const commands = (params as { stats?: string[] }).stats?.length
						? ((params as { stats: string[] }).stats)
						: ["stat unit"]
					const durationMs = (params as { durationMs?: number }).durationMs ?? 750
					const savedDir = await getSavedDirectory()
					const logPath = findNewestLog(path.join(savedDir, "Logs"))
					if (!logPath) {
						throw new Error("No editor log found.")
					}
					const startedAt = Date.now()
					const startOffset = fs.statSync(logPath).size
					const loggedCommands = commands.map((command) =>
						command.toLowerCase().includes("-log") ? command : `${command} -log`,
					)
					await tryRunCommand(editorTools.UEConsoleCommand("stat startfile"))
					for (const command of loggedCommands) {
						await tryRunCommand(editorTools.UEConsoleCommand(command))
					}
					await wait(durationMs)
					await tryRunCommand(editorTools.UEConsoleCommand("stat stopfile"))
					await wait(500)
					const artifact = findNewestArtifact(
						[
							path.join(savedDir, "Profiling"),
							path.join(savedDir, "Profiles"),
							path.join(savedDir, "Stats"),
						],
						startedAt,
					)
					const lines = readNewBytes(logPath, startOffset)
						.split(/\r?\n/)
						.filter((line) => /(?:stat|frame|gpu|game|render|rhi|draw|primitive|memory|physics|unit)/i.test(line))
					const warnings = lines.filter((line) => /(?:error|ensure|failed|warning)/i.test(line))
					return directDispatch({
						success: true,
						commands,
						loggedCommands,
						durationMs,
						logPath,
						artifact: artifact ?? null,
						lineCount: lines.length,
						lines: lines.slice(-200),
						warnings,
						capturedAt: new Date().toISOString(),
						note: "capture_stats starts and stops a UE4.27 stats-file capture and returns the artifact when the build writes one. stat groups still render in the viewport; capture_frame returns GPU timing from the log.",
					})
				},
			},
			capture_frame: {
				paramsSchema: z
					.object({
						waitMs: z.number().int().min(100).max(5000).optional(),
					})
					.strict(),
				handler: async (params) => {
					const waitMs = (params as { waitMs?: number }).waitMs ?? 1500
					const savedDir = await getSavedDirectory()
					const logPath = findNewestLog(path.join(savedDir, "Logs"))
					if (!logPath) {
						throw new Error("No editor log found.")
					}
					const startedAt = Date.now()
					const startOffset = fs.statSync(logPath).size
					await tryRunCommand(editorTools.UEConsoleCommand("profilegpu"))
					await wait(waitMs)
					const logLines = readNewBytes(logPath, startOffset)
						.split(/\r?\n/)
						.filter((line) => /(?:profile|gpu|frame|stat|render)/i.test(line))
					const warnings = logLines.filter((line) => /(?:error|ensure|failed|warning)/i.test(line))
					const artifact = findNewestArtifact(
						[path.join(savedDir, "Profiling"), path.join(savedDir, "Profiles")],
						startedAt,
					)
					const gpuTimeMatch = logLines.join("\n").match(/total GPU time\s+([\d.]+)\s*ms/i)
					const gpuTimeMs = gpuTimeMatch ? Number(gpuTimeMatch[1]) : undefined
					return directDispatch({
						success: true,
						command: "profilegpu",
						logPath,
						artifact: artifact ?? null,
						gpuTimeMs,
						lineCount: logLines.length,
						lines: logLines.slice(-200),
						warnings,
						capturedAt: new Date().toISOString(),
						note: "profilegpu opens the GPU Visualizer; inspect it in the editor. The GPU time is parsed from the log; profilegpu does not write a capture file in this engine build.",
					})
				},
			},
			list_artifacts: {
				paramsSchema: z
					.object({
						limit: z.number().int().min(1).max(100).optional(),
						extension: z.enum([".ue4stats", ".stats", ".csv", ".txt", ".json"]).optional(),
					})
					.strict(),
				handler: async (params) => {
					const value = params as { limit?: number; extension?: string }
					const savedDir = await getSavedDirectory()
					const allArtifacts = collectProfileArtifacts(savedDir)
					const filtered = value.extension
						? allArtifacts.filter((artifact) => artifact.extension === value.extension)
						: allArtifacts
					const artifacts = filtered
						.sort((left, right) => right.mtimeMs - left.mtimeMs)
						.slice(0, value.limit ?? 20)
					return directDispatch({
						success: true,
						savedDir,
						directories: PROFILE_ARTIFACT_DIRECTORIES.map((directory) =>
							path.join(savedDir, directory),
						),
						total: allArtifacts.length,
						count: artifacts.length,
						artifacts,
						generatedAt: new Date().toISOString(),
					})
				},
			},
			artifact_info: {
				paramsSchema: z.object({ path: z.string().min(1).max(4096) }).strict(),
				handler: async (params) => {
					const savedDir = await getSavedDirectory()
					const artifactPath = resolveSavedArtifact(savedDir, (params as { path: string }).path)
					if (!fs.existsSync(artifactPath)) {
						throw new Error(`Profile artifact not found: ${artifactPath}`)
					}
					const stats = fs.statSync(artifactPath)
					if (!stats.isFile()) {
						throw new Error("Profile artifact path is not a file.")
					}
					return directDispatch({
						success: true,
						savedDir,
						artifact: {
							path: artifactPath,
							relativePath: path.relative(savedDir, artifactPath),
							name: path.basename(artifactPath),
							extension: path.extname(artifactPath).toLowerCase(),
							size: stats.size,
							mtimeMs: stats.mtimeMs,
							modifiedAt: new Date(stats.mtimeMs).toISOString(),
						},
					})
				},
			},
			compare: {
				paramsSchema: z
					.object({
						beforeFrameTimeMs: z.number().positive(),
						afterFrameTimeMs: z.number().positive(),
						targetFps: z.number().positive().optional(),
					})
					.strict(),
				handler: (params) => {
					const { beforeFrameTimeMs, afterFrameTimeMs, targetFps } = params as {
						beforeFrameTimeMs: number
						afterFrameTimeMs: number
						targetFps?: number
					}
					const deltaMs = afterFrameTimeMs - beforeFrameTimeMs
					const percentChange = beforeFrameTimeMs > 0 ? (deltaMs / beforeFrameTimeMs) * 100 : 0
					const budgetMs = targetFps ? 1000 / targetFps : undefined
					return directDispatch({
						success: true,
						beforeFrameTimeMs,
						afterFrameTimeMs,
						deltaMs,
						percentChange,
						improved: afterFrameTimeMs < beforeFrameTimeMs,
						targetFps,
						budgetMs,
						meetsBudget: budgetMs === undefined ? undefined : afterFrameTimeMs <= budgetMs,
					})
				},
			},
			budget_check: {
				paramsSchema: z
					.object({
						frameTimeMs: z.number().positive(),
						targetFps: z.number().positive(),
					})
					.strict(),
				handler: (params) => {
					const { frameTimeMs, targetFps } = params as { frameTimeMs: number; targetFps: number }
					const budgetMs = 1000 / targetFps
					return directDispatch({
						success: true,
						frameTimeMs,
						targetFps,
						budgetMs,
						headroomMs: budgetMs - frameTimeMs,
						meetsBudget: frameTimeMs <= budgetMs,
					})
				},
			},
		},
	)
}
