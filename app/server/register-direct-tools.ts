import { z } from "zod"

import { captureWindow } from "./desktop-capture.js"
import { discoverPath } from "./remote-execution.js"
import { RegistrationContext } from "./registration-context.js"

const extractTextContent = (result: unknown): string => {
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

const batchResultSucceeded = (text: string): boolean => {
	try {
		const parsed = JSON.parse(text)
		return !(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { success?: unknown }).success === false)
	} catch {
		return true
	}
}

export function registerDirectTools(ctx: RegistrationContext) {
	const { editorTools, rawServerTool, registerPythonTool, textResponse, toolDescription, toolHandlerRegistry } = ctx

	rawServerTool("get_unreal_engine_path", toolDescription("get_unreal_engine_path"), async () => {
		const enginePath = await discoverPath(
			[
				"import os",
				"import unreal",
				'engine_dir = unreal.Paths.engine_dir() or ""',
				"full_engine_dir = unreal.Paths.convert_relative_path_to_full(engine_dir) if engine_dir else ''",
				"normalized = os.path.normpath(full_engine_dir) if full_engine_dir else ''",
				"if normalized and os.path.basename(normalized).lower() == 'engine':",
				"    print(os.path.dirname(normalized))",
				"else:",
				"    print(normalized)",
			].join("\n"),
			"Unable to resolve the active Unreal Engine path",
		)

		return textResponse(`Unreal Engine path: ${enginePath}`)
	})

	rawServerTool("get_unreal_project_path", toolDescription("get_unreal_project_path"), async () => {
		const projectPath = await discoverPath(
			[
				"import os",
				"import unreal",
				'project_file = unreal.Paths.get_project_file_path() or ""',
				"full_project_file = unreal.Paths.convert_relative_path_to_full(project_file) if project_file else ''",
				"print(os.path.normpath(full_project_file) if full_project_file else '')",
			].join("\n"),
			"Unable to resolve the active Unreal project path",
		)

		return textResponse(`Unreal Project path: ${projectPath}`)
	})

	rawServerTool(
		"editor_capture_window",
		"Capture a desktop window, including Slate/UMG, to a PNG. Uses native Windows capture and best-effort macOS/Linux capture. Optional window_title selects a top-level window; falls back to the UE4Editor main window when that title is not open.",
		{
			window_title: z.string().optional().describe("Substring of the top-level window title to capture."),
		},
		async (args: { window_title?: string }) => {
			const result = await captureWindow({ windowTitle: args.window_title })
			return textResponse(JSON.stringify(result, null, 2))
		},
	)

	/// Core Direct Tools
	registerPythonTool(
		"editor_create_object",
		toolDescription("editor_create_object"),
		{
			object_class: z.string().describe("Unreal class name (e.g., 'StaticMeshActor', 'DirectionalLight')"),
			object_name: z.string().describe("Name/label for the created object"),
			location: z
				.object({
					x: z.number().default(0),
					y: z.number().default(0),
					z: z.number().default(0),
				})
				.optional()
				.describe("World position coordinates"),
			rotation: z
				.object({
					pitch: z.number().default(0),
					yaw: z.number().default(0),
					roll: z.number().default(0),
				})
				.optional()
				.describe("Rotation in degrees"),
			scale: z
				.object({
					x: z.number().default(1),
					y: z.number().default(1),
					z: z.number().default(1),
				})
				.optional()
				.describe("Scale multipliers"),
			properties: z
				.record(z.any())
				.optional()
				.describe(
					'Additional actor properties. For StaticMeshActor: use \'StaticMesh\' for mesh path, \'Material\' for single material path, or \'Materials\' for array of material paths. Example: {"StaticMesh": "/Game/Meshes/Cube", "Material": "/Game/Materials/M_Basic"}',
				),
		},
		({ object_class, object_name, location, rotation, scale, properties }) =>
			editorTools.UECreateObject(object_class, object_name, location, rotation, scale, properties),
	)

	registerPythonTool(
		"editor_update_object",
		toolDescription("editor_update_object"),
		{
			actor_name: z.string().describe("Name or label of the actor to update"),
			location: z
				.object({
					x: z.number(),
					y: z.number(),
					z: z.number(),
				})
				.optional()
				.describe("New world position coordinates"),
			rotation: z
				.object({
					pitch: z.number(),
					yaw: z.number(),
					roll: z.number(),
				})
				.optional()
				.describe("New rotation in degrees"),
			scale: z
				.object({
					x: z.number(),
					y: z.number(),
					z: z.number(),
				})
				.optional()
				.describe("New scale multipliers"),
			properties: z
				.record(z.any())
				.optional()
				.describe(
					'Additional actor properties to update. For StaticMeshActor: use \'StaticMesh\' for mesh path, \'Material\' for single material path, or \'Materials\' for array of material paths. Example: {"StaticMesh": "/Game/Meshes/Cube", "Material": "/Game/Materials/M_Basic"}',
				),
			new_name: z.string().optional().describe("New name/label for the actor"),
		},
		({ actor_name, location, rotation, scale, properties, new_name }) =>
			editorTools.UEUpdateObject(actor_name, location, rotation, scale, properties, new_name),
	)

	registerPythonTool(
		"editor_delete_object",
		toolDescription("editor_delete_object"),
		{
			actor_names: z.string(),
		},
		({ actor_names }) => editorTools.UEDeleteObject(actor_names),
	)

	rawServerTool(
		"manage_batch",
		"Run a sequential list of MCP tool calls in one request. Each call uses the normal namespace/direct safety guard. Recursion into manage_batch, manage_stack, and manage_debug.panic is rejected. Not atomic; end write batches with explicit save actions.",
		{
			calls: z
				.array(
					z
						.object({
							tool: z.string().min(1),
							action: z.string().min(1).optional(),
							params: z.record(z.any()).optional(),
						})
						.strict(),
				)
				.min(1)
				.max(200),
			continue_on_error: z.boolean().optional(),
			timeout_ms: z.number().int().min(1000).max(300_000).optional(),
		},
		async (args: {
			calls: Array<{ tool: string; action?: string; params?: Record<string, any> }>
			continue_on_error?: boolean
			timeout_ms?: number
		}) => {
			if (!Array.isArray(args?.calls) || args.calls.length === 0) {
				return textResponse(
					JSON.stringify({
						success: false,
						code: "invalid_params",
						error: "calls must be a non-empty array of {tool, action?, params?} objects.",
					}),
				)
			}
			const startedAt = Date.now()
			const deadline = startedAt + (args.timeout_ms ?? 300_000)
			const results: Array<{
				tool: string
				action?: string
				success: boolean
				text: string
				durationMs: number
			}> = []

			for (const call of args.calls) {
				const callStartedAt = Date.now()
				if (callStartedAt > deadline) {
					results.push({
						tool: call.tool,
						action: call.action,
						success: false,
						text: "Batch deadline exceeded before this call.",
						durationMs: 0,
					})
					break
				}

				const action = call.action?.trim()
				if (call.tool === "manage_batch" || call.tool === "manage_stack") {
					results.push({
						tool: call.tool,
						action,
						success: false,
						text: `Recursive ${call.tool} calls are not allowed inside manage_batch.`,
						durationMs: Date.now() - callStartedAt,
					})
					if (!args.continue_on_error) {
						break
					}
					continue
				}
				if (call.tool === "manage_debug" && action === "panic") {
					results.push({
						tool: call.tool,
						action,
						success: false,
						text: "manage_debug.panic is not allowed inside manage_batch.",
						durationMs: Date.now() - callStartedAt,
					})
					if (!args.continue_on_error) {
						break
					}
					continue
				}

				const entry = toolHandlerRegistry.get(call.tool)
				if (!entry) {
					results.push({
						tool: call.tool,
						action,
						success: false,
						text: `Unknown tool: ${call.tool}`,
						durationMs: Date.now() - callStartedAt,
					})
					if (!args.continue_on_error) {
						break
					}
					continue
				}
				if (entry.kind === "namespace" && !action) {
					results.push({
						tool: call.tool,
						action,
						success: false,
						text: `Action is required for namespace tool ${call.tool}.`,
						durationMs: Date.now() - callStartedAt,
					})
					if (!args.continue_on_error) {
						break
					}
					continue
				}

				try {
					const payload =
						entry.kind === "namespace"
							? { action: action ?? "", params: call.params ?? {} }
							: (call.params ?? {})
					const result = await entry.handler(payload)
					const text = extractTextContent(result)
					const success = batchResultSucceeded(text)
					results.push({
						tool: call.tool,
						action,
						success,
						text,
						durationMs: Date.now() - callStartedAt,
					})
					if (!success && !args.continue_on_error) {
						break
					}
				} catch (error) {
					results.push({
						tool: call.tool,
						action,
						success: false,
						text: error instanceof Error ? error.message : String(error),
						durationMs: Date.now() - callStartedAt,
					})
					if (!args.continue_on_error) {
						break
					}
				}
			}

			return textResponse(
				JSON.stringify(
					{
						success: results.every((result) => result.success),
						results,
						totalDurationMs: Date.now() - startedAt,
					},
					null,
					2,
				),
			)
		},
	)
}
