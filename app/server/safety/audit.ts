import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { ActionMode, SafetyProfile } from "./types.js"

export interface AuditEvent {
	timestamp: string
	tool: string
	action?: string
	profile: SafetyProfile
	mode: ActionMode
	status: "blocked" | "success" | "error" | "timeout"
	durationMs: number
	argsBytes: number
	argsHash: string
	code?: string
	message?: string
}

export const hashArgs = (args: unknown): string => {
	try {
		return crypto
			.createHash("sha256")
			.update(JSON.stringify(args ?? {}))
			.digest("hex")
			.slice(0, 16)
	} catch {
		return "unhashable"
	}
}

export const appendAudit = (auditPath: string, event: AuditEvent): void => {
	try {
		fs.mkdirSync(path.dirname(auditPath), { recursive: true })
		fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, "utf8")
	} catch (error) {
		console.error(
			`UEV audit log write failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
