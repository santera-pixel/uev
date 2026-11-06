import { z } from "zod"

import {
	requireAtLeastOneValue,
	requireValueGroups,
	strictObject,
	widgetBlueprintKeys,
	widgetBlueprintMessage,
	widgetBlueprintShape,
} from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"

export function registerEditorToolNamespace(ctx: RegistrationContext) {
	const { editorTools, optionalStringParam, pythonDispatch, registerToolNamespace, requiredStringParam, widgetBlueprintParam } = ctx

	const requireWidgetBlueprintSelection = (shape: z.ZodRawShape) =>
		requireValueGroups(strictObject({ ...widgetBlueprintShape, ...shape }), [
			{ keys: widgetBlueprintKeys, message: widgetBlueprintMessage },
		])

	registerToolNamespace("manage_editor_tool", ctx.toolDescription("manage_editor_tool"), {
		create_editor_utility_widget: {
			description:
				"Create an Editor Utility Widget Blueprint (not a plain UserWidget) so it can be opened as a docked editor tab.",
			paramsSchema: z
				.object({
					widget_name: z.string().optional(),
					name: z.string().optional(),
					asset_path: z.string().optional(),
					path: z.string().optional(),
					parent_class: z.string().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("create_umg_widget_blueprint", {
						widget_name: requiredStringParam(params, ["widget_name", "name", "asset_path"]),
						asset_path: optionalStringParam(params, ["asset_path"]),
						path: optionalStringParam(params, ["path"]),
						parent_class: optionalStringParam(params, ["parent_class"]) ?? "EditorUtilityWidget",
					}),
				),
		},
		launch_editor_utility: {
			description: "Open an Editor Utility Widget Blueprint as a docked editor tab.",
			paramsSchema: requireWidgetBlueprintSelection({}),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("launch_editor_utility", {
						widget_name: widgetBlueprintParam(params),
					}),
				),
		},
		create_editor_utility_blueprint: {
			description: "Create an Editor Utility Blueprint asset (EditorUtilityBlueprint) for editor-only utility logic.",
			paramsSchema: requireAtLeastOneValue(
				strictObject({
					name: z.string().optional(),
					asset_name: z.string().optional(),
					blueprint_name: z.string().optional(),
					path: z.string().optional(),
					parent_class: z.string().optional(),
				}),
				["name", "asset_name", "blueprint_name"],
				"Provide name, asset_name, or blueprint_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("create_editor_utility_blueprint", {
						name: requiredStringParam(params, ["name", "asset_name", "blueprint_name"]),
						path: optionalStringParam(params, ["path"]),
						parent_class: optionalStringParam(params, ["parent_class"]),
					}),
				),
		},
		create_actor_action_utility: {
			description: "Create an Actor Action Utility blueprint (EditorUtilityBlueprint with an ActorActionUtility parent) for right-click actor actions.",
			paramsSchema: requireAtLeastOneValue(
				strictObject({
					name: z.string().optional(),
					asset_name: z.string().optional(),
					blueprint_name: z.string().optional(),
					path: z.string().optional(),
					parent_class: z.string().optional(),
				}),
				["name", "asset_name", "blueprint_name"],
				"Provide name, asset_name, or blueprint_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("create_actor_action_utility", {
						name: requiredStringParam(params, ["name", "asset_name", "blueprint_name"]),
						path: optionalStringParam(params, ["path"]),
						parent_class: optionalStringParam(params, ["parent_class"]),
					}),
				),
		},
		create_asset_action_utility: {
			description: "Create an Asset Action Utility blueprint (EditorUtilityBlueprint with an AssetActionUtility parent) for right-click asset actions.",
			paramsSchema: requireAtLeastOneValue(
				strictObject({
					name: z.string().optional(),
					asset_name: z.string().optional(),
					blueprint_name: z.string().optional(),
					path: z.string().optional(),
					parent_class: z.string().optional(),
				}),
				["name", "asset_name", "blueprint_name"],
				"Provide name, asset_name, or blueprint_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("create_asset_action_utility", {
						name: requiredStringParam(params, ["name", "asset_name", "blueprint_name"]),
						path: optionalStringParam(params, ["path"]),
						parent_class: optionalStringParam(params, ["parent_class"]),
					}),
				),
		},
		close_editor_utility: {
			description: "Close the editor tab(s) for an Editor Utility Widget or Editor Utility Blueprint and verify the asset is no longer open.",
			paramsSchema: requireAtLeastOneValue(
				strictObject({
					asset_path: z.string().optional(),
					path: z.string().optional(),
					widget_blueprint_path: z.string().optional(),
					widget_name: z.string().optional(),
				}),
				["asset_path", "path", "widget_blueprint_path", "widget_name"],
				"Provide asset_path, path, widget_blueprint_path, or widget_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEUMGTool("close_editor_utility", {
						asset_path: requiredStringParam(params, ["asset_path", "path", "widget_blueprint_path", "widget_name"]),
					}),
				),
		},
		list_open_editor_tools: {
			description: "List open Editor Utility Widget and Editor Utility Blueprint editor tabs with asset paths and tab names.",
			handler: () => pythonDispatch(editorTools.UEUMGTool("list_open_editor_tools", {})),
		},
	})
}
