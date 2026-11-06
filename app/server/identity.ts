/**
 * Product identity for UEV (UnrealEngineVite MCP).
 *
 * 1.7.0 is a clean break: only `UEV_*` environment variables are read - no other
 * prefix is aliased or accepted.
 *
 * This module only names the product, its environment prefix and its install
 * layout; the MCP tool surface (namespaces, actions, schemas) is untouched by it.
 */

export const productName = "UEV"
export const productLongName = "UnrealEngineVite MCP"
export const productTitle = "UEV - UnrealEngineVite MCP"
export const productSlug = "uev"
export const productId = "uev"

export const envPrefix = "UEV_"

export const defaultSupervisorPipe = "uev-supervisor"

/** Install root folder under %LOCALAPPDATA%. */
export const installRootFolder = "UEV"

/** Supervisor executable inside the install root. */
export const supervisorExeName = "UEVSupervisor.exe"

/** Per-user state directory (audit/history journals, control descriptor). */
export const stateDirName = ".uev"

const normalizeEnvValue = (value: string | undefined): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined

/**
 * Reads an environment variable by bare suffix (e.g. `"PROFILE"` reads `UEV_PROFILE`).
 * Empty strings count as unset. No other prefix is consulted.
 */
export const envValue = (
	suffix: string,
	env: NodeJS.ProcessEnv = process.env,
	fallback?: string,
): string | undefined => normalizeEnvValue(env[`${envPrefix}${suffix}`]) ?? fallback

/** Boolean env flag accepting 1/true/yes/on. */
export const envFlag = (suffix: string, env: NodeJS.ProcessEnv = process.env): boolean => {
	const value = envValue(suffix, env)?.toLowerCase()
	return value === "1" || value === "true" || value === "yes" || value === "on"
}

const normalizePipeName = (value: string): string | undefined => {
	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}
	return trimmed.startsWith("\\\\.\\pipe\\") ? trimmed : `\\\\.\\pipe\\${trimmed}`
}

/**
 * The supervisor pipe path. An explicit `UEV_SUPERVISOR_PIPE` is authoritative;
 * otherwise the single UEV pipe is used. 1.7 serves one pipe, so there is no fallback name.
 */
export const supervisorPipePath = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
	const configured = envValue("SUPERVISOR_PIPE", env) ?? defaultSupervisorPipe
	return normalizePipeName(configured)
}
