/**
 * Crash-safety guards.
 *
 * Every entry in CRASH_GUARDS exists because a specific operation was observed,
 * or is known from UE4.27 internals, to take the whole editor down; in the
 * supervised stack that also kills the MCP session. This module is the single
 * inventory of those guards, and the place where request-only guards are
 * enforced, so a new crash class has exactly one place to be recorded.
 *
 * Enforcement is split by where the relevant engine state lives:
 *   dispatch        - decided before any engine work, from the request alone
 *   editor-python   - decided inside the editor process (ue_compat crash guards)
 *   control-panel   - decided by the Slate panel before it re-enters itself
 *   supervisor      - decided by the job-object watchdog after a crash
 */

export type CrashGuardEnforcement = "dispatch" | "editor-python" | "control-panel" | "supervisor"

export type CrashGuardBehaviour = "refuse" | "downgrade" | "prevent"

export interface CrashGuard {
	/** Stable id used in refusal payloads, docs and tests. */
	id: string
	title: string
	enforcedBy: CrashGuardEnforcement
	behaviour: CrashGuardBehaviour
	/** The failure this guard prevents. */
	crashClass: string
	/** What a caller sees instead of the crash. */
	symptom: string
	/** Covered operations as tool.action globs, for docs and tests. */
	covers: string[]
	/** Where the evidence lives. */
	evidence: string
}

export const CRASH_GUARDS: readonly CrashGuard[] = [
	{
		id: "protected-content",
		title: "Refuse deletions and moves of engine, config or /Game root content",
		enforcedBy: "dispatch",
		behaviour: "refuse",
		crashClass: "unrecoverable-content",
		symptom: "structured refusal with error.code=unsafe_operation_refused and guard=protected-content",
		covers: ["manage_asset.delete", "manage_asset.delete_folder", "manage_asset.move", "manage_asset.rename"],
		evidence: "Engine content is not owned by the project; deleting /Engine, /Script or the /Game root cannot be undone from inside the editor.",
	},
	{
		id: "loaded-asset-delete",
		title: "Save and close loaded assets before deleting them",
		enforcedBy: "editor-python",
		behaviour: "refuse",
		crashClass: "editor-asset-teardown",
		symptom: "Refusing to delete: loaded assets could not be saved before closing their editors.",
		covers: ["manage_asset.delete", "manage_asset.delete_folder"],
		evidence: "Editor Utility Widget dock tabs crashed the editor through Blutility HandleAssetRemoved during delete; ue_asset_management_tools._prepare_assets_for_deletion.",
	},
	{
		id: "pie-editor-mutation",
		title: "Refuse editor-world mutations while Play In Editor is running",
		enforcedBy: "editor-python",
		behaviour: "refuse",
		crashClass: "pie-teardown",
		symptom: "structured refusal with guard=pie-editor-mutation and a hint to stop PIE first",
		covers: [
			"manage_asset.delete",
			"manage_asset.delete_folder",
			"manage_asset.move",
			"manage_asset.rename",
			"manage_actor.spawn",
			"manage_actor.spawn_blueprint",
			"manage_actor.delete",
			"manage_blueprint.compile",
			"manage_blueprint.create_function",
			"manage_blueprint.set_function_signature",
			"manage_blueprint.rename_function",
			"manage_blueprint.delete_function",
			"manage_blueprint.add_local_variable",
			"manage_blueprint.update_local_variable",
			"manage_blueprint.remove_local_variable",
			"manage_blueprint.create_macro",
			"manage_blueprint.set_macro_signature",
			"manage_blueprint.rename_macro",
			"manage_blueprint.delete_macro",
			"manage_blueprint.reset_construction_script",
			"manage_blueprint.verify_blueprint",
		],
		evidence: "Editing the editor world while PIE worlds are alive mutates objects the PIE teardown later destroys; observed as crashes during PIE stop.",
	},
	{
		id: "unplaceable-blueprint",
		title: "Reject Blueprints that cannot be placed in a level",
		enforcedBy: "editor-python",
		behaviour: "refuse",
		crashClass: "actor-factory-assert",
		symptom: "structured refusal naming the asset as not placeable (Controller, GameMode, abstract, or no actor factory).",
		covers: ["manage_actor.spawn_blueprint"],
		evidence: "UActorFactoryBlueprint::PreSpawnActor crashed on a non-placeable AIController Blueprint (FINDINGS.md).",
	},
	{
		id: "viewport-capture",
		title: "Never call HighResShot for offscreen viewport captures",
		enforcedBy: "dispatch",
		behaviour: "downgrade",
		crashClass: "render-profiler-assert",
		symptom: "capture_method=window_capture plus a warning that the editor window was captured instead.",
		covers: ["manage_editor.screenshot"],
		evidence: "In-process HighResShot trips a RealtimeGPUProfiler assertion in this engine build; register-core-editor-system-namespaces downgrades target=viewport.",
	},
	{
		id: "panel-reentrancy",
		title: "Stop the Slate control panel from re-entering its own refresh",
		enforcedBy: "control-panel",
		behaviour: "prevent",
		crashClass: "slate-recursion",
		symptom: "the panel skips the nested refresh and logs a reentrancy warning instead of recursing.",
		covers: ["controlpanel.refresh", "controlpanel.run"],
		evidence: "Refreshing while a refresh is already running re-enters RebuildToolRows/RebuildParamForm and can exhaust the Slate stack.",
	},
	{
		id: "crash-watchdog",
		title: "Relaunch the editor after a crash and surface the crash report",
		enforcedBy: "supervisor",
		behaviour: "prevent",
		crashClass: "stack-loss",
		symptom: "the supervisor restarts the editor, logs the newest Saved/Crashes entry, and reports restarts/lastCrashPath in its status.",
		covers: ["supervisor.status"],
		evidence: "supervisor/Program.cs watchdog loop plus CrashReportLocator; restart budget is --max-restarts inside --restart-window-seconds.",
	},
]

export function crashGuardById(id: string): CrashGuard | undefined {
	return CRASH_GUARDS.find((guard) => guard.id === id)
}

export interface CrashGuardRequest {
	tool: string
	action: string
	params: Record<string, unknown>
}

export interface CrashGuardRefusal {
	success: false
	tool: string
	action: string
	message: string
	guard: {
		id: string
		title: string
		behaviour: CrashGuardBehaviour
		crashClass: string
		evidence: string
	}
	error: {
		code: "unsafe_operation_refused"
		guard: string
		message: string
		hint: string
	}
}

/** Absolute content roots a project must never delete or move from inside the editor. */
const PROTECTED_CONTENT_ROOTS = ["/engine", "/script", "/config", "/intermediate"] as const

/** Path-bearing keys used across the asset tools. */
const PATH_KEYS = [
	"asset_path",
	"asset_paths",
	"path",
	"paths",
	"name",
	"names",
	"directory_path",
	"folder_path",
	"source_asset_path",
	"source_path",
	"destination_asset_path",
	"destination_path",
] as const

const normalizeContentPath = (value: string): string => {
	const trimmed = value.trim().replace(/\\/g, "/")
	if (!trimmed.startsWith("/")) {
		return trimmed
	}
	return trimmed.replace(/\/+$/, "") || "/"
}

const collectPaths = (params: Record<string, unknown>): string[] => {
	const collected: string[] = []
	for (const key of PATH_KEYS) {
		const value = params[key]
		if (typeof value === "string" && value.trim()) {
			collected.push(value)
			continue
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string" && entry.trim()) {
					collected.push(entry)
				}
			}
		}
	}
	return collected
}

const refusal = (
	request: CrashGuardRequest,
	guard: CrashGuard,
	message: string,
	hint: string,
): CrashGuardRefusal => ({
	success: false,
	tool: request.tool,
	action: request.action,
	message,
	guard: {
		id: guard.id,
		title: guard.title,
		behaviour: guard.behaviour,
		crashClass: guard.crashClass,
		evidence: guard.evidence,
	},
	error: {
		code: "unsafe_operation_refused",
		guard: guard.id,
		message,
		hint,
	},
})

/** Env opt-out shared with the editor-side guards (ue_compat/05_crash_guards.py). */
export const UNSAFE_OPERATIONS_OPT_OUT = "UEV_ALLOW_UNSAFE_OPERATIONS"

const unsafeOperationsAllowed = (env: NodeJS.ProcessEnv): boolean => {
	const raw = env[UNSAFE_OPERATIONS_OPT_OUT]
	return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

const PROTECTED_ACTIONS = new Set(["delete", "delete_folder", "move", "rename"])

/**
 * Evaluate the guards that can be decided from the request alone. Returns a
 * structured refusal instead of letting the operation reach the editor.
 */
export function evaluateRequestGuards(
	request: CrashGuardRequest,
	env: NodeJS.ProcessEnv = process.env,
): CrashGuardRefusal | undefined {
	if (request.tool !== "manage_asset" || !PROTECTED_ACTIONS.has(request.action)) {
		return undefined
	}

	if (unsafeOperationsAllowed(env)) {
		return undefined
	}

	const guard = crashGuardById("protected-content")
	if (!guard) {
		return undefined
	}

	for (const rawPath of collectPaths(request.params)) {
		const normalized = normalizeContentPath(rawPath)
		const lower = normalized.toLowerCase()
		const isGameRoot = lower === "/game"
		const isProtectedRoot = PROTECTED_CONTENT_ROOTS.some(
			(root) => lower === root || lower.startsWith(root + "/"),
		)
		if (!isGameRoot && !isProtectedRoot) {
			continue
		}

		return refusal(
			request,
			guard,
			`Refusing to ${request.action} protected content: ${normalized}`,
			"Pass a project folder below /Game, or set " +
				UNSAFE_OPERATIONS_OPT_OUT +
				"=1 for a deliberate, backed-up operation.",
		)
	}

	return undefined
}
