import crypto from "node:crypto"
import { stateDirName } from "../identity.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ActionMode, SafetyProfile } from "./types.js"

export type HistoryUndoMode = "native" | "semantic" | "none"

export interface HistoryCallEntry {
	type: "call"
	id: string
	timestamp: string
	sessionId: string
	tool: string
	action?: string
	mode: ActionMode
	profile: SafetyProfile
	status: "success" | "error" | "timeout"
	durationMs: number
	argsHash: string
	argsPreview?: string
	code?: string
	resultSummary?: string
	undo: HistoryUndoMode
	inverse?: Record<string, unknown>
	forward?: Record<string, unknown>
	transactionLabel?: string
}

export interface HistoryEvent {
	type: "undo" | "redo" | "clear"
	id: string
	timestamp: string
	sessionId: string
	targetId?: string
	status: "success" | "error"
	message?: string
}

export type HistoryRecord = HistoryCallEntry | HistoryEvent

export interface HistoryEntryView extends HistoryCallEntry {
	undone: boolean
	lastEvent?: HistoryEvent
}

export interface HistoryListOptions {
	limit?: number
	tool?: string
	action?: string
	status?: string
}

export interface HistoryStatus {
	path: string
	sessionId: string
	entryCount: number
	nativeCount: number
	semanticCount: number
	noneCount: number
}

export interface HistoryJournal {
	appendCall: (entry: Omit<HistoryCallEntry, "type" | "timestamp" | "sessionId">) => void
	appendEvent: (event: Omit<HistoryEvent, "id" | "timestamp" | "sessionId">) => void
	list: (options?: HistoryListOptions) => HistoryEntryView[]
	get: (id: string) => HistoryEntryView | undefined
	clear: () => void
	getStatus: () => HistoryStatus
}

const MAX_HISTORY_BYTES = 10 * 1024 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const ensureParentDirectory = (filePath: string) => {
	const directory = path.dirname(filePath)
	if (directory && !fs.existsSync(directory)) {
		fs.mkdirSync(directory, { recursive: true })
	}
}

const appendLine = (filePath: string, value: unknown) => {
	try {
		ensureParentDirectory(filePath)
		fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8")
	} catch (error) {
		console.error(
			`UEV history journal write failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

const readRecords = (filePath: string): HistoryRecord[] => {
	if (!fs.existsSync(filePath)) {
		return []
	}

	try {
		const stats = fs.statSync(filePath)
		const size = stats.size
		const buffer = Buffer.alloc(Math.min(size, MAX_HISTORY_BYTES))
		const fd = fs.openSync(filePath, "r")
		try {
			fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
		} finally {
			fs.closeSync(fd)
		}

		const text = buffer.toString("utf8")
		const normalized = size > MAX_HISTORY_BYTES ? text.slice(text.indexOf("\n") + 1) : text
		const records: HistoryRecord[] = []
		for (const line of normalized.split(/\r?\n/)) {
			if (!line.trim()) {
				continue
			}
			try {
				const value = JSON.parse(line) as HistoryRecord
				if (value && typeof value === "object" && "type" in value) {
					records.push(value)
				}
			} catch {
				// Ignore malformed lines so one bad append cannot make the whole history unreadable.
			}
		}
		return records
	} catch (error) {
		console.error(
			`UEV history journal read failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

const buildEntryViews = (records: HistoryRecord[]): HistoryEntryView[] => {
	const lastEvents = new Map<string, HistoryEvent>()
	for (const record of records) {
		if (record.type === "undo" || record.type === "redo") {
			if (record.targetId) {
				lastEvents.set(record.targetId, record)
			}
		}
	}

	return records
		.filter((record): record is HistoryCallEntry => record.type === "call")
		.map((entry) => {
			const lastEvent = lastEvents.get(entry.id)
			return {
				...entry,
				undone: lastEvent?.type === "undo",
				lastEvent,
			}
		})
}

export const createHistoryJournal = (options: { path?: string; sessionId?: string } = {}): HistoryJournal => {
	const filePath =
		options.path?.trim() || path.join(os.homedir(), stateDirName, "history.jsonl")
	const sessionId = options.sessionId?.trim() || crypto.randomUUID()

	const appendCall: HistoryJournal["appendCall"] = (entry) => {
		appendLine(filePath, {
			...entry,
			type: "call",
			timestamp: new Date().toISOString(),
			sessionId,
		})
	}

	const appendEvent: HistoryJournal["appendEvent"] = (event) => {
		appendLine(filePath, {
			...event,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			sessionId,
		})
	}

	const list: HistoryJournal["list"] = (options = {}) => {
		const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
		const entries = buildEntryViews(readRecords(filePath))
		const filtered = entries.filter((entry) => {
			if (options.tool && entry.tool !== options.tool) {
				return false
			}
			if (options.action && entry.action !== options.action) {
				return false
			}
			if (options.status && entry.status !== options.status) {
				return false
			}
			return true
		})
		return filtered.slice(-limit).reverse()
	}

	const get: HistoryJournal["get"] = (id) => {
		const entry = buildEntryViews(readRecords(filePath)).find((candidate) => candidate.id === id)
		return entry
	}

	const clear: HistoryJournal["clear"] = () => {
		try {
			ensureParentDirectory(filePath)
			fs.writeFileSync(filePath, "", "utf8")
		} catch (error) {
			console.error(
				`UEV history journal clear failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		appendEvent({ type: "clear", status: "success" })
	}

	const getStatus: HistoryJournal["getStatus"] = () => {
		const entries = buildEntryViews(readRecords(filePath))
		return {
			path: filePath,
			sessionId,
			entryCount: entries.length,
			nativeCount: entries.filter((entry) => entry.undo === "native").length,
			semanticCount: entries.filter((entry) => entry.undo === "semantic").length,
			noneCount: entries.filter((entry) => entry.undo === "none").length,
		}
	}

	return { appendCall, appendEvent, list, get, clear, getStatus }
}
