import fs from "node:fs"

import { defaultAllowlist } from "./default-allowlist.js"
import type { ActionMode, ActionPolicy, Allowlist, SafetyLimits, SafetyProfile, ToolPolicy } from "./types.js"
import { envValue } from "../identity.js"

const MODES: ActionMode[] = ["read", "write", "supervised", "blocked"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const assertMode = (value: unknown, context: string): ActionMode => {
	if (typeof value !== "string" || !MODES.includes(value as ActionMode)) {
		throw new Error(`Invalid safety mode for ${context}: ${String(value)}. Expected ${MODES.join(", ")}.`)
	}

	return value as ActionMode
}

const normalizePolicy = (value: unknown, context: string): ActionPolicy => {
	if (!isRecord(value)) {
		throw new Error(`Invalid safety policy for ${context}: expected an object.`)
	}

	const timeoutMs =
		typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
			? value.timeoutMs
			: undefined

	return {
		mode: assertMode(value.mode, context),
		timeoutMs,
		note: typeof value.note === "string" ? value.note : undefined,
	}
}

const mergePolicies = (base: ActionPolicy | undefined, override: ActionPolicy | undefined): ActionPolicy | undefined => {
	if (!base) {
		return override
	}

	if (!override) {
		return base
	}

	return {
		mode: override.mode,
		timeoutMs: override.timeoutMs ?? base.timeoutMs,
		note: override.note ?? base.note,
	}
}

const mergeActions = (
	base: Record<string, ActionPolicy> | undefined,
	override: Record<string, ActionPolicy> | undefined,
	context: string,
): Record<string, ActionPolicy> | undefined => {
	if (!override) {
		return base
	}

	const merged: Record<string, ActionPolicy> = { ...(base ?? {}) }
	for (const [action, policy] of Object.entries(override)) {
		merged[action] = mergePolicies(base?.[action], normalizePolicy(policy, `${context}.${action}`))!
	}

	return merged
}

const mergeToolPolicy = (base: ToolPolicy | undefined, override: ToolPolicy | undefined, context: string): ToolPolicy | undefined => {
	if (!override) {
		return base
	}

	return {
		defaultMode: override.defaultMode ? assertMode(override.defaultMode, `${context}.defaultMode`) : base?.defaultMode,
		direct: override.direct ? mergePolicies(base?.direct, normalizePolicy(override.direct, `${context}.direct`)) : base?.direct,
		actions: mergeActions(base?.actions, override.actions, `${context}.actions`),
	}
}

const mergeLimits = (base: SafetyLimits, override: unknown): SafetyLimits => {
	if (!isRecord(override)) {
		return base
	}

	const merged: SafetyLimits = { ...base }
	for (const key of Object.keys(base) as Array<keyof SafetyLimits>) {
		const value = override[key]
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			merged[key] = value
		}
	}

	return merged
}

export const mergeAllowlist = (base: Allowlist, override: Partial<Allowlist>): Allowlist => {
	const tools: Record<string, ToolPolicy> = { ...base.tools }
	for (const [toolName, toolPolicy] of Object.entries(override.tools ?? {})) {
		tools[toolName] = mergeToolPolicy(base.tools[toolName], toolPolicy, `tools.${toolName}`)!
	}

	return {
		version: typeof override.version === "number" ? override.version : base.version,
		defaultMode: override.defaultMode ? assertMode(override.defaultMode, "defaultMode") : base.defaultMode,
		limits: mergeLimits(base.limits, override.limits),
		tools,
	}
}

export const loadAllowlist = (env: NodeJS.ProcessEnv = process.env): Allowlist => {
	const overridePath = envValue("ALLOWLIST", env)
	if (!overridePath) {
		return defaultAllowlist
	}

	const raw = fs.readFileSync(overridePath, "utf8")
	const parsed = JSON.parse(raw) as Partial<Allowlist>
	if (!isRecord(parsed)) {
		throw new Error(`Allowlist override at ${overridePath} must be a JSON object.`)
	}

	return mergeAllowlist(defaultAllowlist, parsed)
}

export const resolvePolicy = (allowlist: Allowlist, tool: string, action?: string): ActionPolicy => {
	const toolPolicy = allowlist.tools[tool]

	if (action) {
		const actionPolicy = toolPolicy?.actions?.[action]
		if (actionPolicy) {
			return actionPolicy
		}

		return { mode: toolPolicy?.defaultMode ?? allowlist.defaultMode }
	}

	return toolPolicy?.direct ?? { mode: toolPolicy?.defaultMode ?? allowlist.defaultMode }
}

export const decidePolicy = (
	profile: SafetyProfile,
	policy: ActionPolicy,
	readOnly: boolean,
): { allowed: true } | { allowed: false; reason: string } => {
	if (policy.mode === "blocked") {
		return { allowed: false, reason: "Action is not in the allowlist." }
	}

	if (readOnly && policy.mode !== "read") {
		return { allowed: false, reason: "Server is in read-only mode." }
	}

	if (policy.mode === "read") {
		return { allowed: true }
	}

	if (policy.mode === "write") {
		return profile === "supervised"
			? { allowed: true }
			: { allowed: false, reason: "Write actions require the supervised profile." }
	}

	return profile === "supervised"
		? { allowed: true }
		: { allowed: false, reason: "This action requires the supervised profile." }
}
