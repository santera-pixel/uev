import os from "node:os"
import path from "node:path"

import { loadAllowlist } from "./allowlist.js"
import type { SafetyConfig, SafetyProfile } from "./types.js"
import { envFlag, envValue, stateDirName, supervisorPipePath } from "../identity.js"

const parseProfile = (value: string | undefined): SafetyProfile => {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) {
		return "unattended"
	}

	if (normalized === "unattended" || normalized === "supervised") {
		return normalized
	}

	console.error(`Unknown UEV_PROFILE value "${value}". Falling back to unattended.`)
	return "unattended"
}

const parseSupervisorPipe = (env: NodeJS.ProcessEnv): string | undefined => {
	const disabled = envValue("SUPERVISOR", env)?.toLowerCase()
	if (disabled === "0" || disabled === "false" || disabled === "off") {
		return undefined
	}

	return supervisorPipePath(env)
}

export const loadSafetyConfig = (env: NodeJS.ProcessEnv = process.env): SafetyConfig => ({
	allowlist: loadAllowlist(env),
	profile: parseProfile(envValue("PROFILE", env)),
	readOnly: envFlag("READ_ONLY", env),
	auditPath:
		envValue("AUDIT_LOG", env) || path.join(os.homedir(), stateDirName, "audit.jsonl"),
	historyPath:
		envValue("HISTORY_LOG", env) || path.join(os.homedir(), stateDirName, "history.jsonl"),
	supervisorPipe: parseSupervisorPipe(env),
})
