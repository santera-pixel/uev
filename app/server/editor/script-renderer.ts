import fs from "node:fs"
import path from "node:path"

import { Template } from "../utils.js"
import { editorPreludes, readEditorScript } from "./prelude-loader.js"

function readWithPrelude(filePath: string, extraPrelude = ""): string {
	return [editorPreludes.compat, extraPrelude, "# MCP_SCRIPT_BODY_START", readEditorScript(filePath)]
		.filter(Boolean)
		.join("\n\n")
}

export function renderEditorScript(
	filePath: string,
	vars: Record<string, string>,
	options: { extraPrelude?: string } = {},
) {
	return Template(readWithPrelude(filePath, options.extraPrelude), vars)
}

export function jsonArg(value: unknown): string {
	return Buffer.from(JSON.stringify(value === undefined ? null : value), "utf8").toString("base64")
}

/**
 * Domain -> directory map for the editor preludes. This mirrors the map built at
 * module load in prelude-loader.ts; keep both in sync when a new prelude
 * directory is added.
 */
const domainDirectories: Record<string, string> = {
	actor: "ue_actor",
	blueprint: "ue_blueprint",
	compat: "ue_compat",
	contentFactory: "ue_content_factory",
	data: "ue_data",
	material: "ue_material",
	sequence: "ue_sequence",
	sourceControl: "ue_source_control",
	substrate: "ue_substrate",
	umg: "ue_umg",
	worldBuilding: "ue_world_building",
}

const scriptsDirectory = path.join(__dirname, "scripts")

/**
 * Per-file snapshots of every prelude directory. Content (not mtimes) is
 * compared so a reload reports exactly which files changed.
 */
const preludeSnapshots = new Map<string, Map<string, string>>()

function readPreludeDirectory(relativeDirectory: string): Map<string, string> {
	const snapshot = new Map<string, string>()
	const absoluteDirectory = path.join(scriptsDirectory, relativeDirectory)
	if (!fs.existsSync(absoluteDirectory)) {
		return snapshot
	}

	for (const fileName of fs
		.readdirSync(absoluteDirectory)
		.filter((entry) => entry.endsWith(".py"))
		.sort()) {
		snapshot.set(fileName, fs.readFileSync(path.join(absoluteDirectory, fileName), "utf8"))
	}

	return snapshot
}

function buildPreludeFromSnapshot(snapshot: Map<string, string>): string {
	return Array.from(snapshot.values()).join("\n\n")
}

function snapshotPreludes(): void {
	for (const [domain, directory] of Object.entries(domainDirectories)) {
		preludeSnapshots.set(domain, readPreludeDirectory(directory))
	}
}

function discoverDomainDirectories(): Record<string, string> {
	const discovered: Record<string, string> = {}
	if (!fs.existsSync(scriptsDirectory)) {
		return discovered
	}

	for (const entry of fs.readdirSync(scriptsDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("ue_")) {
			continue
		}

		const parts = entry.name.slice(3).split("_")
		const domain = parts
			.map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
			.join("")
		discovered[domain] = entry.name
	}

	return discovered
}

snapshotPreludes()

export interface PreludeReloadDomain {
	domain: string
	directory: string
	file_count: number
	changed: boolean
	changed_files: string[]
	added_files: string[]
	removed_files: string[]
	status: "reloaded" | "unchanged" | "missing"
	message?: string
}

export interface PreludeReloadResult {
	success: boolean
	reloaded_at: string
	domains: PreludeReloadDomain[]
	changed_domains: string[]
	total_files: number
	warnings: string[]
}

/**
 * Re-read every editor prelude directory from disk and update the shared
 * editorPreludes object in place. Every renderer reads editorPreludes inside its
 * function body, so already-rendered scripts are untouched while all later
 * renders use the reloaded Python.
 */
export function reloadEditorPreludes(): PreludeReloadResult {
	const reloadedAt = new Date().toISOString()
	const warnings: string[] = []
	const domains: PreludeReloadDomain[] = []
	const changedDomains: string[] = []
	const preludes = editorPreludes as Record<string, string>
	const directories = { ...domainDirectories, ...discoverDomainDirectories() }

	for (const domain of Object.keys(directories).sort()) {
		const directory = directories[domain]
		const absoluteDirectory = path.join(scriptsDirectory, directory)
		const previousSnapshot = preludeSnapshots.get(domain) ?? new Map<string, string>()

		if (!fs.existsSync(absoluteDirectory)) {
			domains.push({
				domain,
				directory,
				file_count: 0,
				changed: false,
				changed_files: [],
				added_files: [],
				removed_files: [],
				status: "missing",
				message: `Prelude directory ${directory} does not exist; the cached prelude was left untouched.`,
			})
			warnings.push(`Prelude directory ${directory} is missing; domain "${domain}" keeps its cached Python.`)
			continue
		}

		const nextSnapshot = readPreludeDirectory(directory)
		const changedFiles = Array.from(nextSnapshot.keys())
			.filter((fileName) => {
				const previous = previousSnapshot.get(fileName)
				return previous === undefined ? false : previous !== nextSnapshot.get(fileName)
			})
			.sort()
		const addedFiles = Array.from(nextSnapshot.keys())
			.filter((fileName) => !previousSnapshot.has(fileName))
			.sort()
		const removedFiles = Array.from(previousSnapshot.keys())
			.filter((fileName) => !nextSnapshot.has(fileName))
			.sort()
		const changed = changedFiles.length > 0 || addedFiles.length > 0 || removedFiles.length > 0

		preludes[domain] = buildPreludeFromSnapshot(nextSnapshot)
		preludeSnapshots.set(domain, nextSnapshot)

		if (changed) {
			changedDomains.push(domain)
		}

		domains.push({
			domain,
			directory,
			file_count: nextSnapshot.size,
			changed,
			changed_files: changedFiles.map((fileName) => `scripts/${directory}/${fileName}`),
			added_files: addedFiles.map((fileName) => `scripts/${directory}/${fileName}`),
			removed_files: removedFiles.map((fileName) => `scripts/${directory}/${fileName}`),
			status: changed ? "reloaded" : "unchanged",
		})
	}

	const totalFiles = domains.reduce((total, entry) => total + entry.file_count, 0)
	if (warnings.length === 0) {
		warnings.push(
			"No local-token check exists in this build. reload_preludes is a development action, not a security boundary.",
		)
	}

	return {
		success: true,
		reloaded_at: reloadedAt,
		domains,
		changed_domains: changedDomains,
		total_files: totalFiles,
		warnings,
	}
}
