export type SafetyProfile = "unattended" | "supervised"

export type ActionMode = "read" | "write" | "supervised" | "blocked"

export interface ActionPolicy {
	mode: ActionMode
	timeoutMs?: number
	note?: string
	transactional?: boolean
	undo?: "native" | "semantic" | "none"
	recovery?: boolean
}

export interface ToolPolicy {
	defaultMode?: ActionMode
	actions?: Record<string, ActionPolicy>
	direct?: ActionPolicy
}

export interface SafetyLimits {
	maxArgsBytes: number
	maxStringLength: number
	maxArrayLength: number
	maxDepth: number
	maxObjectKeys: number
	maxNodes: number
	defaultCallTimeoutMs: number
	maxCallTimeoutMs: number
}

export interface Allowlist {
	version: number
	defaultMode: ActionMode
	limits: SafetyLimits
	tools: Record<string, ToolPolicy>
}

export interface SafetyConfig {
	allowlist: Allowlist
	profile: SafetyProfile
	readOnly: boolean
	auditPath: string
	historyPath: string
	supervisorPipe?: string
	pluginRegistry?: import("../plugins/plugin-registry.js").PluginRegistry
}

export interface SafetyStatus {
	profile: SafetyProfile
	readOnly: boolean
	degraded: boolean
	consecutiveFailures: number
	allowlistVersion: number
	auditPath: string
	historyPath: string
	sessionId?: string
	supervisor?: {
		enabled: boolean
		connected: boolean
		pipePath: string
	}
}
