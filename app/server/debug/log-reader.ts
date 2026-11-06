import fs from "node:fs"
import path from "node:path"

const MAX_LOG_BYTES = 64 * 1024
const MAX_AUDIT_BYTES = 2 * 1024 * 1024
const MAX_LINES = 500

const readTail = (filePath: string, maxBytes: number): string => {
	const stats = fs.statSync(filePath)
	const length = Math.min(stats.size, maxBytes)
	const buffer = Buffer.alloc(length)
	const fd = fs.openSync(filePath, "r")
	try {
		fs.readSync(fd, buffer, 0, length, Math.max(0, stats.size - length))
	} finally {
		fs.closeSync(fd)
	}

	const text = buffer.toString("utf8")
	return stats.size > maxBytes ? text.slice(text.indexOf("\n") + 1) : text
}

export const tailFile = (filePath: string, lines = 200, filter?: string): string => {
	const text = readTail(filePath, MAX_LOG_BYTES)
	let logLines = text.split(/\r?\n/)
	if (filter?.trim()) {
		const normalizedFilter = filter.trim().toLowerCase()
		logLines = logLines.filter((line) => line.toLowerCase().includes(normalizedFilter))
	}

	return logLines.slice(-Math.min(Math.max(lines, 1), MAX_LINES)).join("\n")
}

export const findNewestLog = (directory: string): string | undefined => {
	if (!fs.existsSync(directory)) {
		return undefined
	}

	let newest: { path: string; mtimeMs: number } | undefined
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) {
			continue
		}
		const fullPath = path.join(directory, entry.name)
		const stats = fs.statSync(fullPath)
		if (!newest || stats.mtimeMs > newest.mtimeMs) {
			newest = { path: fullPath, mtimeMs: stats.mtimeMs }
		}
	}

	return newest?.path
}

export interface AuditLogOptions {
	limit?: number
	tool?: string
	action?: string
	status?: string
	filter?: string
}

export const readAuditEntries = (
	filePath: string,
	options: AuditLogOptions = {},
): Record<string, unknown>[] => {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
	const text = readTail(filePath, MAX_AUDIT_BYTES)
	const entries: Record<string, unknown>[] = []
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			continue
		}
		try {
			const entry = JSON.parse(line) as Record<string, unknown>
			if (options.tool && entry.tool !== options.tool) {
				continue
			}
			if (options.action && entry.action !== options.action) {
				continue
			}
			if (options.status && entry.status !== options.status) {
				continue
			}
			if (options.filter?.trim() && !line.toLowerCase().includes(options.filter.trim().toLowerCase())) {
				continue
			}
			entries.push(entry)
		} catch {
			// Ignore malformed audit lines.
		}
	}

	return entries.slice(-limit).reverse()
}
