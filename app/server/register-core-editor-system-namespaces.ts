import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import { captureWindow } from "./desktop-capture.js"
import { reloadEditorPreludes } from "./editor/script-renderer.js"
import { requireAtLeastOneValue, vector3TransformShape } from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"
import { tryRunCommand } from "./remote-execution.js"

const checkedPythonCommand = (code: string): string => {
	const encoded = Buffer.from(code, "utf8").toString("base64")
	return [
		"import base64, contextlib, io, json, traceback",
		`__mcp_code = base64.b64decode("${encoded}").decode("utf-8")`,
		"__mcp_buffer = io.StringIO()",
		"try:",
		"    with contextlib.redirect_stdout(__mcp_buffer):",
		'        exec(compile(__mcp_code, "<mcp>", "exec"), globals())',
		'    __mcp_result = {"success": True, "output": __mcp_buffer.getvalue()}',
		"except BaseException as __mcp_exc:",
		'    __mcp_result = {"success": False, "output": __mcp_buffer.getvalue(), "error": str(__mcp_exc), "traceback": traceback.format_exc()}',
		"print(json.dumps(__mcp_result))",
	].join("\n")
}

const normalizeAsyncId = (value?: string): string => {
	const id = (value?.trim() || `async-${Date.now()}`).slice(0, 64)
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error("async id must contain only letters, numbers, underscores, and hyphens.")
	}
	return id
}

const asyncPythonBootstrap = (id: string, code: string, timeoutSeconds?: number): string => {
	const encoded = Buffer.from(code, "utf8").toString("base64")
	const timeout = Math.max(1, Math.min(3600, Number(timeoutSeconds ?? 600)))
	return `import unreal, os, json, time, base64, traceback
__id = ${JSON.stringify(id)}
__timeout = ${timeout}
__code = base64.b64decode("${encoded}").decode("utf-8")
__saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
__dir = os.path.join(__saved, "UEV", "async")
os.makedirs(__dir, exist_ok=True)
__result_path = os.path.join(__dir, __id + ".json")
__cancel_path = os.path.join(__dir, __id + ".cancel")
if os.path.exists(__cancel_path):
    os.remove(__cancel_path)
__state = {"id": __id, "status": "running", "startedAt": time.time(), "data": {}}
__last_write = 0.0
def __write(force=False):
    global __last_write
    now = time.time()
    if not force and now - __last_write < 0.25:
        return
    __last_write = now
    tmp = __result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(__state, handle, indent=2, default=str)
    os.replace(tmp, __result_path)
__write(True)
__namespace = {"__name__": "mcp_async"}
exec(compile(__code, "<mcp_async>", "exec"), __namespace)
if not hasattr(unreal, "register_slate_post_tick_callback"):
    raise RuntimeError("unreal.register_slate_post_tick_callback is not available")
__handle = None
def __tick(*args):
    global __handle
    delta = args[0] if args else 0.0
    try:
        if __state.get("status") in ("done", "error", "cancelled", "timeout"):
            __write(True)
            if __handle is not None:
                unreal.unregister_slate_post_tick_callback(__handle)
            return
        if __timeout and (time.time() - __state["startedAt"]) > __timeout:
            __state["status"] = "timeout"
            __state["error"] = "timeout"
            __write(True)
            if __handle is not None:
                unreal.unregister_slate_post_tick_callback(__handle)
            return
        if os.path.exists(__cancel_path):
            __state["status"] = "cancelled"
            __write(True)
            if __handle is not None:
                unreal.unregister_slate_post_tick_callback(__handle)
            return
        handler = __namespace.get("on_tick")
        if callable(handler):
            handler(delta, __state)
        __write()
    except BaseException as exc:
        __state["status"] = "error"
        __state["error"] = str(exc)
        __state["traceback"] = traceback.format_exc()
        __write(True)
        if __handle is not None:
            unreal.unregister_slate_post_tick_callback(__handle)
__handle = unreal.register_slate_post_tick_callback(__tick)
print(json.dumps({"success": True, "id": __id, "result_path": __result_path}))
`
}

const asyncResultCommand = (id: string): string => {
	return `import unreal, os, json
__id = ${JSON.stringify(id)}
__saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
__path = os.path.join(__saved, "UEV", "async", __id + ".json")
if not os.path.exists(__path):
    print(json.dumps({"success": False, "id": __id, "status": "missing", "message": "No async result yet"}))
else:
    with open(__path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    data["success"] = True
    print(json.dumps(data))
`
}

const asyncCancelCommand = (id: string): string => {
	return `import unreal, os, json
__id = ${JSON.stringify(id)}
__saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
__dir = os.path.join(__saved, "UEV", "async")
os.makedirs(__dir, exist_ok=True)
__cancel_path = os.path.join(__dir, __id + ".cancel")
with open(__cancel_path, "w", encoding="utf-8") as handle:
    handle.write("cancel")
print(json.dumps({"success": True, "id": __id, "message": "cancel requested"}))
`
}

const extractResultText = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
	if (!Array.isArray(content)) {
		try {
			return JSON.stringify(result)
		} catch {
			return String(result)
		}
	}
	return content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim()
}

const readPath = (value: unknown, path: string): unknown => {
	if (!path) {
		return value
	}
	let current = value
	for (const segment of path.split(".")) {
		if (current === null || current === undefined) {
			return undefined
		}
		if (Array.isArray(current)) {
			const index = Number(segment)
			current = Number.isInteger(index) ? current[index] : undefined
			continue
		}
		if (typeof current === "object") {
			current = (current as Record<string, unknown>)[segment]
			continue
		}
		return undefined
	}
	return current
}

const valuesMatch = (left: unknown, right: unknown): boolean => {
	try {
		return JSON.stringify(left) === JSON.stringify(right)
	} catch {
		return left === right
	}
}

const parsePythonResult = (text: string): Record<string, any> | undefined => {
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, any>
		}
	} catch {
		// Fall through to the brace scan below.
	}

	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start < 0 || end <= start) {
		return undefined
	}

	try {
		const parsed = JSON.parse(text.slice(start, end + 1))
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, any>
		}
	} catch {
		return undefined
	}

	return undefined
}

const summarizeProbe = (probe: Record<string, any> | undefined) =>
	probe
		? {
				success: probe.success,
				is_pie_running: probe.is_pie_running,
				game_world_name: probe.game_world_name,
				world: probe.world,
				actor_count: probe.actor_count,
				log_path: probe.log_path,
				log_start_offset: probe.log_start_offset,
				message: probe.message,
			}
		: undefined

const summarizeConditions = (
	conditions: Array<Record<string, any>>,
	lastConditions: Array<Record<string, any> | undefined>,
	firstPassedAt: Array<number | undefined>,
) =>
	conditions.map((condition, index) => {
		const last = lastConditions[index]
		return {
			index,
			kind: condition.kind,
			passed: last ? last.passed === true : false,
			observed: last ? last.observed : undefined,
			message: last ? last.message : "No probe result yet.",
			first_passed_elapsed_ms: firstPassedAt[index],
		}
	})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const namespaceParameterHints: Record<string, Record<string, string[]>> = {
	manage_editor: {
		project_info: [
			"Optional: max_items (default 25), max_blueprints (default 500). Returns game_modes, characters, source, and warnings.",
			"Blueprint classes are classified by their class default objects, so Blueprint subclasses of native game modes and characters are found even when their names do not contain \"GameMode\" or \"Character\".",
		],
		map_info: ["No params. Returns the current map summary."],
		world_outliner: ["No params. Lists actors in the current editor world."],
		run_python: ["Required: code. Use this for UE4.27 Python debugging or gaps not wrapped by a stable action."],
		run_python_checked: [
			"Required: code. Executes Python and returns JSON { success, output, error, traceback }; use this when the caller needs a reliable success flag.",
		],
		console_command: [
			"Required: command. Optional: log_path. This is the canonical console action (manage_vite.console_command routes here).",
			"Output is captured from the newest editor log under Saved/Logs; output_captured is false with a warning when no new log lines appear, so absence of output is never reported as success.",
		],
		get_console_variable: [
			"Provide variable_name, name, or console_variable. Optional: execute_for_output (prints the variable into the editor log and captures it), log_path.",
			"Values come from SystemLibrary console-variable getters; canvas output is not captured.",
		],
		reload_preludes: [
			"No params. Re-reads server/editor/scripts/ue_* preludes from disk and reports per-domain file counts and changed files. Already-rendered scripts are untouched.",
			"Development action: this build has no local-token mechanism, so no token is checked. Not a security boundary.",
		],
		open_asset: ["Required: asset_path. Optional: focus (opening activates the tab). Opens a generic asset editor tab."],
		close_asset: ["Required: asset_path. Closes every editor tab for the asset and reports closed_count."],
		list_open_assets: ["No params. Lists assets with open editor tabs when AssetEditorSubsystem exposes GetEditedAssets."],
		focus_asset: ["Required: asset_path. Opens or activates the asset editor tab."],
		pie_expect: [
			"Required: conditions, one or more of kind actor_exists | actor_location | property_equals | log_contains.",
			"actor_exists/actor_location/property_equals take actor_name or name; actor_location takes expected [x,y,z] and tolerance (default 1.0); property_equals takes property and expected.",
			"log_contains takes pattern or text, optional regex and case_sensitive, and matches only lines written after the first probe.",
			"Optional: timeout_ms (100-15000, default 3000), poll_ms (50-5000, default 250), log_path. Fails fast when PIE is not running and an actor condition was requested.",
		],
		is_pie_running: ["Optional: timeout_seconds, poll_interval. Polls PIE/game-world status."],
		start_pie: ["Optional: timeout_seconds, poll_interval. Starts PIE and waits for a game world when requested."],
		stop_pie: ["Optional: timeout_seconds, poll_interval. Stops PIE and can wait for shutdown."],
		screenshot: [
			"Optional: target (viewport | window), destination_path, width, height. viewport uses HighResShot; window captures the editor window natively.",
			"When target is omitted, destination_path captures the window and no destination captures the viewport.",
		],
		move_camera: ["Optional: location, rotation. Moves the editor viewport camera."],
	},
	manage_widget: {
		create_widget_blueprint: [
			"Required: widget_name, name, asset_path, or widget_path. Use a full asset path like /Game/UI/TestUMG when you want to choose the folder.",
			"Optional: parent_class, path.",
		],
		ensure_canvas_root: [
			"Required: widget_blueprint, widget_blueprint_path, widget_path, asset_path, widget_name, or blueprint_name.",
			"Optional: root_widget_name/root_name, wrap_existing_root. Existing CanvasPanel roots are renamed when a root name is requested.",
		],
		inspect_tree: [
			"Required: widget_blueprint, widget_blueprint_path, widget_path, asset_path, widget_name, or blueprint_name.",
			"Returns the UMG designer tree with widget names, classes, parents, children, text, style, and CanvasPanel slot layout.",
		],
		add_text_block: [
			"Required: widget blueprint selector plus text_block_name or name.",
			"Optional: text, position, size, font_size, color.",
		],
		add_button: [
			"Required: widget blueprint selector plus button_name or name.",
			"Optional: text, position, size, font_size, color, background_color.",
		],
		add_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, widget_class, widget_name/name.",
			"Optional: parent_widget_name, position, size, z_order, background_color. Position and size require a CanvasPanel slot.",
		],
		add_child_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, parent_widget_name, child_widget_class, child_widget_name/name.",
			"Optional: text, position, size, font_size, color, z_order, background_color. Position and size require the child to be attached to a CanvasPanel.",
		],
		position_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, widget_name/name, and at least one of position, size, or z_order.",
			"Only CanvasPanel children can be positioned or resized.",
		],
		position_child_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, parent_widget_name, child_widget_name/name, and at least one of position, size, or z_order.",
			"Only direct children attached to a CanvasPanel slot can be positioned or resized.",
		],
		reparent_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, widget_name/name, new_parent_widget_name.",
			"Optional: position, size, z_order. The current root widget cannot be reparented.",
		],
		remove_widget: ["Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path and widget_name/name."],
		remove_child_widget: [
			"Required: widget_blueprint_path/widget_blueprint/widget_path/asset_path, parent_widget_name, and child_widget_name/name.",
		],
		add_to_viewport: [
			"Required: widget_blueprint, widget_blueprint_path, widget_path, asset_path, widget_name, or blueprint_name.",
			"Optional: z_order, start_pie_if_needed/auto_start_pie, timeout_seconds, poll_interval. Requires PIE or a game world; start_pie_if_needed can request PIE and may return retry_recommended until the game world is ready.",
		],
	},
}

export function registerCoreEditorSystemNamespaces(ctx: RegistrationContext) {
	const {
		directDispatch,
		editorTools,
		pythonDispatch,
		registerToolNamespace,
		requiredStringParam,
		toRotatorRecord,
		toVector3Record,
		toolHandlerRegistry,
		toolNamespaceRegistry,
	} = ctx

	registerToolNamespace("manage_editor", ctx.toolDescription("manage_editor"), {
		run_python: {
			paramsSchema: z
				.object({
					code: z.string(),
				})
				.strict(),
			handler: (params) => pythonDispatch(requiredStringParam(params, ["code"])),
		},
		run_python_checked: {
			paramsSchema: z
				.object({
					code: z.string(),
				})
				.strict(),
			handler: (params) => pythonDispatch(checkedPythonCommand(requiredStringParam(params, ["code"]))),
		},
		run_python_async: {
			description:
				"Run Python in the editor and return immediately. The code may define on_tick(delta, state); it runs on a Slate post-tick callback and writes progress to Saved/UEV/async/<id>.json. Set state['status']='done' to stop.",
			paramsSchema: z
				.object({
					id: z.string().optional(),
					code: z.string(),
					timeout_seconds: z.number().optional(),
				})
				.strict(),
			handler: (params) => {
				const id = normalizeAsyncId((params as { id?: string }).id)
				const code = requiredStringParam(params, ["code"])
				const timeoutSeconds = (params as { timeout_seconds?: number }).timeout_seconds
				return pythonDispatch(
					checkedPythonCommand(asyncPythonBootstrap(id, code, timeoutSeconds)),
				)
			},
		},
		get_async_result: {
			description:
				"Read the JSON progress/result file for a run_python_async job. Returns status, data, error, and traceback when present.",
			paramsSchema: z.object({ id: z.string() }).strict(),
			handler: (params) => {
				const id = normalizeAsyncId(requiredStringParam(params, ["id"]))
				// Return the result JSON directly so wait_for can read `status` without
				// having to unpack the checked-Python stdout wrapper.
				return pythonDispatch(asyncResultCommand(id))
			},
		},
		cancel_async: {
			description: "Request cancellation of a run_python_async job by writing its cancel flag.",
			paramsSchema: z.object({ id: z.string() }).strict(),
			handler: (params) => {
				const id = normalizeAsyncId(requiredStringParam(params, ["id"]))
				return pythonDispatch(checkedPythonCommand(asyncCancelCommand(id)))
			},
		},
		console_command: {
			description:
				"Execute an Unreal console command. This is the canonical console action; manage_vite.console_command routes here. Output is read back from the tail of the current editor log, so commands that never write to the log return output_captured: false instead of empty output.",
			paramsSchema: z
				.object({
					command: z.string(),
					log_path: z.string().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEEditorRuntimeTool("console_command", {
						command: requiredStringParam(params, ["command"]),
						log_path: (params as { log_path?: string }).log_path,
					}),
				),
		},
		project_info: {
			description:
				"Summarize the project: engine version, asset/input/map counts, game modes, characters, and source layout. Game modes and characters are derived from Blueprint class default objects, and warnings explain any empty detection instead of silently returning empty arrays.",
			paramsSchema: z
				.object({
					max_items: z.number().int().min(1).max(200).optional(),
					max_blueprints: z.number().int().min(1).max(5_000).optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEProjectTool("project_info", {
						max_items: (params as { max_items?: number }).max_items,
						max_blueprints: (params as { max_blueprints?: number }).max_blueprints,
					}),
				),
		},
		map_info: { handler: () => pythonDispatch(editorTools.UEGetMapInfo()) },
		world_outliner: { handler: () => pythonDispatch(editorTools.UEGetWorldOutliner()) },
		is_pie_running: {
			paramsSchema: z
				.object({
					timeout_seconds: z.number().optional(),
					poll_interval: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEPIETool("get_pie_status", {
						timeout_seconds: params.timeout_seconds,
						poll_interval: params.poll_interval,
					}),
				),
		},
		start_pie: {
			paramsSchema: z
				.object({
					timeout_seconds: z.number().optional(),
					poll_interval: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEPIETool("start_pie", {
						timeout_seconds: params.timeout_seconds,
						poll_interval: params.poll_interval,
					}),
				),
		},
		start_pie_play: {
			description:
				"Start a Play-in-Editor session with a local player (not Simulate). Use is_pie_running to wait for the play world.",
			paramsSchema: z.object({}).strict(),
			handler: () =>
				pythonDispatch(
					checkedPythonCommand(
						'import unreal\nprint(unreal.UEVInputLibrary.start_pie_play())',
					),
				),
		},
		inject_key: {
			description:
				"Inject a key press/release into the PIE local player controller. This exercises the real input mapping.",
			paramsSchema: z
				.object({
					key: z.string(),
					pressed: z.boolean().optional(),
				})
				.strict(),
			handler: (params) => {
				const key = requiredStringParam(params, ["key"])
				const pressed = (params as { pressed?: boolean }).pressed ?? true
				return pythonDispatch(
					checkedPythonCommand(
						`import unreal\nprint(unreal.UEVInputLibrary.inject_key(${JSON.stringify(key)}, ${pressed ? "True" : "False"}))`,
					),
				)
			},
		},
		inject_mouse_button: {
			description:
				"Press or release a mouse button in the PIE local player controller. PIE only; it does not click the editor UI.",
			paramsSchema: z
				.object({
					button: z.string(),
					pressed: z.boolean().optional(),
				})
				.strict(),
			handler: (params) => {
				const button = requiredStringParam(params, ["button"])
				const pressed = (params as { pressed?: boolean }).pressed ?? true
				return pythonDispatch(
					checkedPythonCommand(
						`import unreal\nprint(unreal.UEVInputLibrary.inject_mouse_button(${JSON.stringify(button)}, ${pressed ? "True" : "False"}))`,
					),
				)
			},
		},
		inject_mouse_move: {
			description:
				"Inject relative mouse movement into the PIE local player controller (mouse-look/input axes). PIE only; it does not move the OS cursor.",
			paramsSchema: z
				.object({
					delta_x: z.number(),
					delta_y: z.number(),
				})
				.strict(),
			handler: (params) => {
				const deltaX = Number((params as { delta_x: number }).delta_x)
				const deltaY = Number((params as { delta_y: number }).delta_y)
				if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
					throw new Error("delta_x and delta_y must be finite numbers")
				}
				return pythonDispatch(
					checkedPythonCommand(
						`import unreal\nprint(unreal.UEVInputLibrary.inject_mouse_move(${deltaX}, ${deltaY}))`,
					),
				)
			},
		},
		stop_pie: {
			paramsSchema: z
				.object({
					timeout_seconds: z.number().optional(),
					poll_interval: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEPIETool("stop_pie", {
						timeout_seconds: params.timeout_seconds,
						poll_interval: params.poll_interval,
					}),
				),
		},
		get_console_variable: {
			description:
				"Read a console variable value. This is the canonical console-variable action. Values come from the SystemLibrary console-variable getters; canvas output is not captured. With execute_for_output the variable is printed into the editor log and the captured tail is returned alongside the values.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						variable_name: z.string().optional(),
						name: z.string().optional(),
						console_variable: z.string().optional(),
						execute_for_output: z.boolean().optional(),
						log_path: z.string().optional(),
					})
					.strict(),
				["variable_name", "name", "console_variable"],
				"Provide variable_name, name, or console_variable.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEEditorRuntimeTool("get_console_variable", {
						variable_name: requiredStringParam(params, ["variable_name", "name", "console_variable"]),
						execute_for_output: (params as { execute_for_output?: boolean }).execute_for_output,
						log_path: (params as { log_path?: string }).log_path,
					}),
				),
		},
		screenshot: {
			description:
				"Capture the Unreal editor window to a PNG. This build has no safe offscreen viewport capture (UE4.27 HighResShot crashes the editor with a RealtimeGPUProfiler assertion), so both target values use a native OS window capture: the image includes editor UI, uses the current window size, and may not match width/height. Reports the absolute path, dimensions, and warnings.",
			paramsSchema: z
				.object({
					target: z.enum(["viewport", "window"]).optional(),
					destination_path: z.string().optional(),
					width: z.number().int().min(1).max(7_680).optional(),
					height: z.number().int().min(1).max(4_320).optional(),
				})
				.strict(),
			handler: async (params) => {
				const target = (params as { target?: "viewport" | "window" }).target
				const destination = (params as { destination_path?: string }).destination_path
				const width = (params as { width?: number }).width
				const height = (params as { height?: number }).height
				const resolvedTarget = target ?? (destination ? "window" : "viewport")

				const result = await captureWindow({ windowTitle: "Unreal Editor" })
				if (!result.success || !result.path) {
					return directDispatch({
						success: false,
						target: resolvedTarget,
						message: "Editor window capture failed.",
						error: result.error,
					})
				}

				const warnings: string[] = []
				if (resolvedTarget === "viewport") {
					warnings.push(
						"Viewport-only capture is unavailable in this engine build (HighResShot crashes the editor); the whole editor window was captured instead, including editor UI.",
					)
				}
				if (width !== undefined || height !== undefined) {
					warnings.push(
						"Window capture uses the current editor window size; width/height were ignored.",
					)
				}

				let outputPath = result.path
				if (destination) {
					const targetPath = path.isAbsolute(destination) ? destination : path.resolve(destination)
					fs.mkdirSync(path.dirname(targetPath), { recursive: true })
					fs.copyFileSync(result.path, targetPath)
					outputPath = targetPath
				}

				const sizeMismatch =
					(width !== undefined && result.width !== width) ||
					(height !== undefined && result.height !== height)
				if (sizeMismatch) {
					warnings.push(
						"Captured window is " +
							String(result.width) +
							"x" +
							String(result.height) +
							", not the requested " +
							String(width ?? "?") +
							"x" +
							String(height ?? "?") +
							".",
					)
				}

				return directDispatch({
					success: true,
					target: resolvedTarget,
					capture_method: "window_capture",
					path: outputPath,
					source: result.path,
					width: result.width,
					height: result.height,
					destination_path: destination ? outputPath : undefined,
					downgraded: sizeMismatch || resolvedTarget === "viewport",
					warnings,
				})
			},
		},
		open_asset: {
			description:
				"Open a generic asset editor tab for any asset (Blueprint, material, animation, data table, and so on) through AssetEditorSubsystem/AssetTools. Set focus to also activate the tab; the result reports whether the editor confirmed the asset as edited.",
			paramsSchema: z
				.object({
					asset_path: z.string().min(1),
					focus: z.boolean().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEEditorRuntimeTool("open_asset", {
						asset_path: requiredStringParam(params, ["asset_path"]),
						focus: (params as { focus?: boolean }).focus,
					}),
				),
		},
		close_asset: {
			description:
				"Close every open editor tab for an asset. Reports closed_count and whether an AssetEditorSubsystem close function was available in this build.",
			paramsSchema: z.object({ asset_path: z.string().min(1) }).strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEEditorRuntimeTool("close_asset", {
						asset_path: requiredStringParam(params, ["asset_path"]),
					}),
				),
		},
		list_open_assets: {
			description:
				"List assets that currently have editor tabs open. UE4.27 Python does not expose AssetEditorSubsystem.GetEditedAssets, so this build tracks MCP open_asset/focus_asset/close_asset calls and returns tracked_only=true with that caveat; tabs opened elsewhere are not listed.",
			paramsSchema: z.object({}).strict(),
			handler: () => pythonDispatch(editorTools.UEEditorRuntimeTool("list_open_assets", {})),
		},
		focus_asset: {
			description:
				"Focus an asset editor tab, opening it first when it is not already open. Reports was_open, opened_by_focus, and whether focus could be verified.",
			paramsSchema: z.object({ asset_path: z.string().min(1) }).strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEEditorRuntimeTool("focus_asset", {
						asset_path: requiredStringParam(params, ["asset_path"]),
					}),
				),
		},
		reload_preludes: {
			description:
				"Reload the server-side editor preludes (server/editor/scripts/ue_*) from disk without restarting the MCP server. Development action: it reports per-domain file counts and changed files, and it does not touch scripts that were already rendered. This build has no local-token mechanism, so no token is checked.",
			paramsSchema: z.object({}).strict(),
			handler: () => directDispatch(reloadEditorPreludes()),
		},
		pie_expect: {
			description:
				"Poll PIE until every condition passes or timeout_ms elapses. Conditions: actor_exists, actor_location (expected [x,y,z] and tolerance, default 1.0), property_equals (property path and expected value), log_contains (pattern or text, optional regex and case_sensitive). Each condition reports passed, observed value, message, and elapsed time. Fails fast when PIE is not running and an actor condition was requested, and log_contains only matches lines written after the first probe.",
			paramsSchema: z
				.object({
					conditions: z
						.array(
							z.discriminatedUnion("kind", [
								z
									.object({
										kind: z.literal("actor_exists"),
										actor_name: z.string().optional(),
										name: z.string().optional(),
									})
									.strict(),
								z
									.object({
										kind: z.literal("actor_location"),
										actor_name: z.string().optional(),
										name: z.string().optional(),
										expected: z.array(z.number()).length(3).optional(),
										tolerance: z.number().optional(),
									})
									.strict(),
								z
									.object({
										kind: z.literal("property_equals"),
										actor_name: z.string().optional(),
										name: z.string().optional(),
										property: z.string().min(1),
										expected: z.any(),
										tolerance: z.number().optional(),
									})
									.strict(),
								z
									.object({
										kind: z.literal("log_contains"),
										pattern: z.string().optional(),
										text: z.string().optional(),
										regex: z.boolean().optional(),
										case_sensitive: z.boolean().optional(),
									})
									.strict(),
							]),
						)
						.min(1)
						.max(16),
					timeout_ms: z.number().int().min(100).max(15_000).optional(),
					poll_ms: z.number().int().min(50).max(5_000).optional(),
					log_path: z.string().optional(),
				})
				.strict(),
			handler: async (params) => {
				const conditions = params.conditions as unknown as Array<Record<string, any>>
				const timeoutMs = params.timeout_ms ?? 3_000
				const pollMs = params.poll_ms ?? 250
				const startedAt = Date.now()
				const deadline = startedAt + timeoutMs
				const hasLogCondition = conditions.some((condition) => condition.kind === "log_contains")
				const requiresPie = conditions.some((condition) => condition.kind !== "log_contains")
				const firstPassedAt: Array<number | undefined> = conditions.map(() => undefined)
				const lastConditions: Array<Record<string, any> | undefined> = conditions.map(() => undefined)
				let pinnedOffset: number | undefined = undefined
				let attempts = 0
				let lastProbe: Record<string, any> | undefined
				let lastError: string | undefined

				while (Date.now() <= deadline) {
					attempts += 1
					try {
						const text = await tryRunCommand(
							editorTools.UEEditorRuntimeTool("pie_probe", {
								conditions,
								log_path: params.log_path,
								log_start_offset: pinnedOffset,
								pin_log_first: hasLogCondition && pinnedOffset === undefined,
							}),
						)
						lastProbe = parsePythonResult(text) ?? lastProbe
						lastError = undefined
					} catch (error) {
						lastError = error instanceof Error ? error.message : String(error)
					}

					const probe = lastProbe
					if (probe) {
						const probed = Array.isArray(probe.conditions)
							? (probe.conditions as Array<Record<string, any>>)
							: []
						probed.forEach((condition, index) => {
							if (index >= conditions.length) {
								return
							}
							lastConditions[index] = condition
							if (condition && condition.passed === true && firstPassedAt[index] === undefined) {
								firstPassedAt[index] = Date.now() - startedAt
							}
						})

						if (
							hasLogCondition &&
							pinnedOffset === undefined &&
							typeof probe.log_start_offset === "number"
						) {
							pinnedOffset = probe.log_start_offset
						}

						if (probe.is_pie_running === false && requiresPie) {
							return directDispatch({
								success: false,
								matched: false,
								timed_out: false,
								pie_running: false,
								message:
									"PIE is not running; actor conditions cannot be evaluated. Start PIE first (manage_editor.start_pie), then call pie_expect.",
								elapsed_ms: Date.now() - startedAt,
								attempts,
								conditions: summarizeConditions(conditions, lastConditions, firstPassedAt),
								probe: summarizeProbe(probe),
								warnings: Array.isArray(probe.warnings) ? probe.warnings.map(String) : [],
							})
						}

						const allPassed =
							probed.length === conditions.length &&
							probed.every((condition) => condition && condition.passed === true)
						if (allPassed) {
							return directDispatch({
								success: true,
								matched: true,
								timed_out: false,
								pie_running: probe.is_pie_running,
								message: "All PIE conditions passed.",
								elapsed_ms: Date.now() - startedAt,
								attempts,
								conditions: summarizeConditions(conditions, lastConditions, firstPassedAt),
								probe: summarizeProbe(probe),
								warnings: Array.isArray(probe.warnings) ? probe.warnings.map(String) : [],
							})
						}
					}

					if (Date.now() + pollMs > deadline) {
						break
					}
					await delay(pollMs)
				}

				const warnings = Array.isArray(lastProbe?.warnings)
					? (lastProbe as Record<string, any>).warnings.map(String)
					: []
				if (lastError) {
					warnings.push("Last probe failed: " + lastError)
				}

				return directDispatch({
					success: false,
					matched: false,
					timed_out: true,
					message:
						"pie_expect timed out after " +
						String(timeoutMs) +
						"ms with " +
						String(conditions.length) +
						" condition(s).",
					elapsed_ms: Date.now() - startedAt,
					attempts,
					last_error: lastError,
					conditions: summarizeConditions(conditions, lastConditions, firstPassedAt),
					probe: summarizeProbe(lastProbe),
					warnings,
				})
			},
		},
		move_camera: {
			paramsSchema: z.object(vector3TransformShape).strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMoveCamera(
						toVector3Record(params.location) ?? { x: 0, y: 0, z: 0 },
						toRotatorRecord(params.rotation) ?? { pitch: 0, yaw: 0, roll: 0 },
					),
				),
		},
	})

	registerToolNamespace("manage_system", ctx.toolDescription("manage_system"), {
		compatibility: {
			description:
				"Report the editor engine version, MCP plugin presence, and runtime capability booleans so clients can fail fast on unsupported builds.",
			handler: () => pythonDispatch(editorTools.UECompatTool("compatibility", {})),
		},
		wait_for: {
			description:
				"Poll another tool action until a dotted JSON path equals the expected value, then return the matched value and text. Useful for PIE state, charge counts, actor properties, and log/result markers.",
			paramsSchema: z
				.object({
					predicate: z
						.object({
							tool: z.string().min(1),
							action: z.string().min(1).optional(),
							params: z.record(z.any()).optional(),
						})
						.strict(),
					path: z.string().optional(),
					equals: z.any().optional(),
					timeout_ms: z.number().int().min(100).max(300_000).optional(),
					interval_ms: z.number().int().min(50).max(10_000).optional(),
				})
				.strict(),
			handler: async (params) => {
				const predicate = (params as {
					predicate: { tool: string; action?: string; params?: Record<string, any> }
					path?: string
					equals?: unknown
					timeout_ms?: number
					interval_ms?: number
				}).predicate
				const entry = toolHandlerRegistry.get(predicate.tool)
				if (!entry) {
					return directDispatch({ success: false, message: `Unknown predicate tool: ${predicate.tool}` })
				}
				const timeoutMs = params.timeout_ms ?? 30_000
				const intervalMs = params.interval_ms ?? 250
				const startedAt = Date.now()
				const deadline = startedAt + timeoutMs
				let lastText = ""
				let lastValue: unknown = undefined

				while (Date.now() <= deadline) {
					try {
						const result = await entry.handler(
							entry.kind === "namespace"
								? { action: predicate.action ?? "", params: predicate.params ?? {} }
								: (predicate.params ?? {}),
						)
						lastText = extractResultText(result)
						const parsed = JSON.parse(lastText)
						lastValue = readPath(parsed, params.path ?? "")
						if (valuesMatch(lastValue, params.equals)) {
							return directDispatch({
								success: true,
								matched: true,
								value: lastValue,
								text: lastText,
								waitedMs: Date.now() - startedAt,
							})
						}
					} catch (error) {
						lastText = error instanceof Error ? error.message : String(error)
					}
					if (Date.now() + intervalMs > deadline) {
						break
					}
					await delay(intervalMs)
				}

				return directDispatch({
					success: false,
					matched: false,
					message: `wait_for timed out after ${timeoutMs}ms`,
					value: lastValue,
					text: lastText,
					waitedMs: Date.now() - startedAt,
				})
			},
		},
	})

	registerToolNamespace("manage_tools", ctx.toolDescription("manage_tools"), {
		list_namespaces: {
			handler: () =>
				directDispatch({
					success: true,
					namespaces: Array.from(toolNamespaceRegistry.entries())
						.map(([toolNamespace, info]) => ({
							tool_namespace: toolNamespace,
							description: info.description,
							supported_actions: info.supportedActions,
						}))
						.sort((left, right) => left.tool_namespace.localeCompare(right.tool_namespace)),
				}),
		},
		tool_status: {
			handler: () =>
				directDispatch({
					success: true,
					tool_namespace_count: toolNamespaceRegistry.size,
					tool_namespaces: Array.from(toolNamespaceRegistry.keys()).sort(),
				}),
		},
		describe_namespace: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						tool_name: z.string().optional(),
						namespace_name: z.string().optional(),
						name: z.string().optional(),
					})
					.strict(),
				["tool_name", "namespace_name", "name"],
				"Provide tool_name, namespace_name, or name.",
			),
			handler: (params) => {
				const toolName = requiredStringParam(params, ["tool_name", "namespace_name", "name"])
				const info = toolNamespaceRegistry.get(toolName)
				return directDispatch(
					info
						? {
								success: true,
								tool_namespace: toolName,
								description: info.description,
								supported_actions: info.supportedActions,
								params: info.params,
								parameter_hints: namespaceParameterHints[toolName],
							}
						: {
								success: false,
								message: `Unknown tool namespace: ${toolName}`,
								available_tool_namespaces: Array.from(toolNamespaceRegistry.keys()).sort(),
							},
				)
			},
		},
	})
}