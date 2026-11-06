import { z } from "zod"

import {
	childWidgetNameKeys,
	childWidgetNameMessage,
	materialColorShape,
	requireAtLeastOneValue,
	requireValueGroups,
	strictObject,
	widgetBlueprintAssetKeys,
	widgetBlueprintAssetMessage,
	widgetBlueprintAssetShape,
	widgetBlueprintKeys,
	widgetBlueprintMessage,
	vector2PlacementShape,
	widgetBlueprintShape,
	widgetNameKeys,
	widgetNameMessage,
} from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"

export function registerContentWidgetNamespaces(ctx: RegistrationContext) {
	const {
		editorTools,
		optionalStringParam,
		pythonDispatch,
		registerToolNamespace,
		requiredStringParam,
		toColorArray,
		toVector2Array,
		toVector2Record,
		vector2InputSchema,
		widgetBlueprintParam,
	} = ctx

	const requireWidgetBlueprintSelection = (shape: z.ZodRawShape) =>
		requireValueGroups(strictObject({ ...widgetBlueprintShape, ...shape }), [
			{ keys: widgetBlueprintKeys, message: widgetBlueprintMessage },
		])

	const requireNamedWidgetBlueprintSelection = (shape: z.ZodRawShape, nameKeys: string[], nameMessage: string) =>
		requireValueGroups(strictObject({ ...widgetBlueprintShape, ...shape }), [
			{ keys: widgetBlueprintKeys, message: widgetBlueprintMessage },
			{ keys: nameKeys, message: nameMessage },
		])

	const requireWidgetAssetAndName = (
		shape: z.ZodRawShape,
		nameKeys = widgetNameKeys,
		nameMessage = widgetNameMessage,
	) =>
		requireValueGroups(strictObject({ ...widgetBlueprintAssetShape, ...shape }), [
			{ keys: widgetBlueprintAssetKeys, message: widgetBlueprintAssetMessage },
			{ keys: nameKeys, message: nameMessage },
		])

	const requireWidgetBlueprintAssetSelection = (shape: z.ZodRawShape) =>
		requireValueGroups(strictObject({ ...widgetBlueprintAssetShape, ...shape }), [
			{ keys: widgetBlueprintAssetKeys, message: widgetBlueprintAssetMessage },
		])

	const widgetMemberKeys = ["widget_member_name", "widget_component_name", "widget_name"]
	const widgetMemberMessage =
		"Provide widget_member_name (preferred), widget_component_name, or widget_name for the widget inside the blueprint."

	const requireWidgetTargetSelection = (shape: z.ZodRawShape) =>
		requireValueGroups(strictObject({ ...widgetBlueprintAssetShape, ...shape }), [
			{ keys: widgetBlueprintAssetKeys, message: widgetBlueprintAssetMessage },
			{ keys: widgetMemberKeys, message: widgetMemberMessage },
		])

	const optionalWidgetMemberParam = (params: Record<string, any>) => {
		const member = optionalStringParam(params, ["widget_member_name", "widget_component_name"])
		const alias = optionalStringParam(params, ["widget_name"])
		if (member && alias && member !== alias) {
			throw new Error(
				`widget_member_name '${member}' conflicts with widget_name '${alias}'. widget_name is only an alias for the widget inside the blueprint; drop it or make both the same.`,
			)
		}
		return member ?? alias
	}

	const widgetMemberParam = (params: Record<string, any>) => {
		const resolved = optionalWidgetMemberParam(params)
		if (!resolved) {
			throw new Error(widgetMemberMessage)
		}
		return resolved
	}

	const placementShape = {
		position: vector2InputSchema.optional(),
		size: vector2InputSchema.optional(),
		z_order: z.number().optional(),
	}

	registerToolNamespace(
		"manage_widget",
		ctx.toolDescription("manage_widget"),
		{
			create_widget_blueprint: {
				paramsSchema: requireAtLeastOneValue(
					strictObject({
						widget_name: z.string().optional(),
						name: z.string().optional(),
						asset_path: z.string().optional(),
						widget_path: z.string().optional(),
						parent_class: z.string().optional(),
						path: z.string().optional(),
					}),
					["widget_name", "name", "asset_path", "widget_path"],
					"Provide widget_name, name, asset_path, or widget_path.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("create_umg_widget_blueprint", {
							widget_name: requiredStringParam(params, ["widget_name", "name", "asset_path", "widget_path"]),
							asset_path: optionalStringParam(params, ["asset_path", "widget_path"]),
							parent_class: optionalStringParam(params, ["parent_class"]),
							path: optionalStringParam(params, ["path"]),
						}),
					),
			},
			bind_event: {
				description:
					"Bind a widget delegate such as a Button OnClicked event to a Blueprint function. Target widget: widget_member_name (preferred), widget_component_name, or widget_name.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					event_name: z.string(),
					function_name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("bind_widget_event", {
							widget_name: widgetBlueprintParam(params),
							widget_member_name: widgetMemberParam(params),
							event_name: requiredStringParam(params, ["event_name"]),
							function_name: optionalStringParam(params, ["function_name"]),
						}),
					),
			},
			set_text_block_binding: {
				description: "Bind a TextBlock property delegate to a Blueprint function or property.",
				paramsSchema: requireWidgetBlueprintSelection({
					text_block_name: z.string(),
					binding_property: z.string().optional(),
					function_name: z.string().optional(),
					source_property: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_text_block_binding", {
							widget_name: widgetBlueprintParam(params),
							text_block_name: requiredStringParam(params, ["text_block_name"]),
							binding_property: optionalStringParam(params, ["binding_property"]),
							function_name: optionalStringParam(params, ["function_name"]),
							source_property: optionalStringParam(params, ["source_property"]),
						}),
					),
			},
			ensure_canvas_root: {
				paramsSchema: requireWidgetBlueprintSelection({
					root_widget_name: z.string().optional(),
					root_name: z.string().optional(),
					wrap_existing_root: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("ensure_canvas_root", {
							widget_name: widgetBlueprintParam(params),
							root_widget_name: optionalStringParam(params, ["root_widget_name", "root_name"]),
							wrap_existing_root: params.wrap_existing_root !== false,
						}),
					),
			},
			inspect_tree: {
				paramsSchema: requireWidgetBlueprintSelection({}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("inspect_widget_tree", {
							widget_name: widgetBlueprintParam(params),
						}),
					),
			},
			add_text_block: {
				paramsSchema: requireNamedWidgetBlueprintSelection(
					{
						text_block_name: z.string().optional(),
						name: z.string().optional(),
						text: z.string().optional(),
						...vector2PlacementShape,
						font_size: z.number().optional(),
						z_order: z.number().optional(),
						...materialColorShape,
					},
					["text_block_name", "name"],
					"Provide text_block_name or name.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_text_block_to_widget", {
							widget_name: widgetBlueprintParam(params),
							text_block_name: requiredStringParam(params, ["text_block_name", "name"]),
							text: optionalStringParam(params, ["text"]),
							position: toVector2Array(params.position),
							size: toVector2Array(params.size),
							font_size: params.font_size,
							z_order: params.z_order,
							color: toColorArray(params.color),
						}),
					),
			},
			add_button: {
				paramsSchema: requireNamedWidgetBlueprintSelection(
					{
						button_name: z.string().optional(),
						name: z.string().optional(),
						text: z.string().optional(),
						...vector2PlacementShape,
						font_size: z.number().optional(),
						z_order: z.number().optional(),
						...materialColorShape,
						background_color: ctx.colorInputSchema.optional(),
					},
					["button_name", "name"],
					"Provide button_name or name.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_button_to_widget", {
							widget_name: widgetBlueprintParam(params),
							button_name: requiredStringParam(params, ["button_name", "name"]),
							text: optionalStringParam(params, ["text"]),
							position: toVector2Array(params.position),
							size: toVector2Array(params.size),
							font_size: params.font_size,
							z_order: params.z_order,
							color: toColorArray(params.color),
							background_color: toColorArray(params.background_color),
						}),
					),
			},
			add_to_viewport: {
				paramsSchema: requireWidgetBlueprintSelection({
					z_order: z.number().optional(),
					start_pie_if_needed: z.boolean().optional(),
					auto_start_pie: z.boolean().optional(),
					timeout_seconds: z.number().optional(),
					poll_interval: z.number().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_widget_to_viewport", {
							widget_name: widgetBlueprintParam(params),
							z_order: params.z_order,
							start_pie_if_needed: params.start_pie_if_needed,
							auto_start_pie: params.auto_start_pie,
							timeout_seconds: params.timeout_seconds,
							poll_interval: params.poll_interval,
						}),
					),
			},
			release_viewport_widgets: {
				handler: () =>
					pythonDispatch(editorTools.UEUMGTool("release_viewport_widgets", {})),
			},
			add_widget: {
				paramsSchema: requireWidgetAssetAndName({
					widget_class: z.string(),
					widget_name: z.string().optional(),
					name: z.string().optional(),
					parent_widget_name: z.string().optional(),
					...placementShape,
					background_color: ctx.colorInputSchema.optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_widget", {
							asset_path: requiredStringParam(params, [
								"widget_blueprint_path",
								"widget_blueprint",
								"widget_path",
								"asset_path",
							]),
							widget_class: requiredStringParam(params, ["widget_class"]),
							widget_name: requiredStringParam(params, ["widget_name", "name"]),
							parent: optionalStringParam(params, ["parent_widget_name"]),
							background_color: params.background_color,
							layout: {
								position: toVector2Record(params.position),
								size: toVector2Record(params.size),
								z_order: typeof params.z_order === "number" ? params.z_order : undefined,
							},
						}),
					),
			},
			remove_widget: {
				paramsSchema: requireWidgetAssetAndName({
					widget_name: z.string().optional(),
					name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("remove_widget", {
							asset_path: requiredStringParam(params, [
								"widget_blueprint_path",
								"widget_blueprint",
								"widget_path",
								"asset_path",
							]),
							widget: requiredStringParam(params, ["widget_name", "name"]),
						}),
					),
			},
			position_widget: {
				paramsSchema: requireAtLeastOneValue(
					requireWidgetAssetAndName({
						widget_name: z.string().optional(),
						name: z.string().optional(),
						...placementShape,
					}),
					["position", "size", "z_order"],
					"Provide position, size, or z_order.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGSetWidgetPosition(
							requiredStringParam(params, ["widget_blueprint_path", "widget_blueprint", "widget_path", "asset_path"]),
							requiredStringParam(params, ["widget_name", "name"]),
							toVector2Record(params.position),
							toVector2Record(params.size),
							typeof params.z_order === "number" ? params.z_order : undefined,
						),
					),
			},
			reparent_widget: {
				paramsSchema: requireWidgetAssetAndName({
					widget_name: z.string().optional(),
					name: z.string().optional(),
					new_parent_widget_name: z.string(),
					...placementShape,
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("reparent_widget", {
							asset_path: requiredStringParam(params, [
								"widget_blueprint_path",
								"widget_blueprint",
								"widget_path",
								"asset_path",
							]),
							widget: requiredStringParam(params, ["widget_name", "name"]),
							parent: requiredStringParam(params, ["new_parent_widget_name"]),
							keep_layout: true,
							layout: {
								position: toVector2Record(params.position),
								size: toVector2Record(params.size),
								z_order: typeof params.z_order === "number" ? params.z_order : undefined,
							},
						}),
					),
			},
			add_child_widget: {
				paramsSchema: requireWidgetAssetAndName(
					{
						parent_widget_name: z.string(),
						child_widget_class: z.string(),
						child_widget_name: z.string().optional(),
						name: z.string().optional(),
						text: z.string().optional(),
						...placementShape,
						font_size: z.number().optional(),
						...materialColorShape,
						background_color: ctx.colorInputSchema.optional(),
					},
					childWidgetNameKeys,
					childWidgetNameMessage,
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_child_widget", {
							asset_path: requiredStringParam(params, [
								"widget_blueprint_path",
								"widget_blueprint",
								"widget_path",
								"asset_path",
							]),
							parent: requiredStringParam(params, ["parent_widget_name"]),
							class: requiredStringParam(params, ["child_widget_class"]),
							widget: requiredStringParam(params, ["child_widget_name", "name"]),
							text: optionalStringParam(params, ["text"]),
							font_size: params.font_size,
							color: toColorArray(params.color),
							background_color: toColorArray(params.background_color),
							layout: {
								position: toVector2Record(params.position),
								size: toVector2Record(params.size),
								z_order: typeof params.z_order === "number" ? params.z_order : undefined,
							},
						}),
					),
			},
			remove_child_widget: {
				paramsSchema: requireWidgetAssetAndName(
					{
						parent_widget_name: z.string(),
						child_widget_name: z.string().optional(),
						name: z.string().optional(),
					},
					childWidgetNameKeys,
					childWidgetNameMessage,
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("remove_child_widget", {
							asset_path: requiredStringParam(params, [
								"widget_blueprint_path",
								"widget_blueprint",
								"widget_path",
								"asset_path",
							]),
							parent: requiredStringParam(params, ["parent_widget_name"]),
							child_widget_name: requiredStringParam(params, ["child_widget_name", "name"]),
						}),
					),
			},
			position_child_widget: {
				paramsSchema: requireAtLeastOneValue(
					requireWidgetAssetAndName(
						{
							parent_widget_name: z.string(),
							child_widget_name: z.string().optional(),
							name: z.string().optional(),
							...placementShape,
						},
						childWidgetNameKeys,
						childWidgetNameMessage,
					),
					["position", "size", "z_order"],
					"Provide position, size, or z_order.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGSetChildWidgetPosition(
							requiredStringParam(params, ["widget_blueprint_path", "widget_blueprint", "widget_path", "asset_path"]),
							requiredStringParam(params, ["parent_widget_name"]),
							requiredStringParam(params, ["child_widget_name", "name"]),
							toVector2Record(params.position),
							toVector2Record(params.size),
							typeof params.z_order === "number" ? params.z_order : undefined,
						),
					),
			},
			set_anchors: {
				description:
					"Set widget anchors on a CanvasPanel child using a named preset or explicit minimum/maximum anchors. Target widget: widget_member_name (preferred), widget_component_name, or widget_name.",
				paramsSchema: requireAtLeastOneValue(
					requireWidgetTargetSelection({
						widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
						anchor_preset: z.string().optional(),
						preset: z.string().optional(),
						minimum: vector2InputSchema.optional(),
						maximum: vector2InputSchema.optional(),
					}),
					["anchor_preset", "preset", "minimum", "maximum"],
					"Provide anchor_preset (or preset) or minimum and maximum anchors.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_anchors", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							anchor_preset: optionalStringParam(params, ["anchor_preset", "preset"]),
							minimum: toVector2Array(params.minimum),
							maximum: toVector2Array(params.maximum),
						}),
					),
			},
			set_alignment: {
				description:
					"Set widget alignment. CanvasPanel children use the vector2 alignment; other slot classes map x/y to horizontal/vertical alignment.",
				paramsSchema: requireWidgetTargetSelection({
					widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
					alignment: vector2InputSchema,
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_alignment", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							alignment: toVector2Array(params.alignment),
						}),
					),
			},
			set_offsets: {
				description:
					"Set CanvasPanel slot offsets, or position/size, for a widget inside a widget blueprint.",
				paramsSchema: requireAtLeastOneValue(
					requireWidgetTargetSelection({
						widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
						left: z.number().optional(),
						top: z.number().optional(),
						right: z.number().optional(),
						bottom: z.number().optional(),
						position: vector2InputSchema.optional(),
						size: vector2InputSchema.optional(),
					}),
					["left", "top", "right", "bottom", "position", "size"],
					"Provide left/top/right/bottom offsets or position and/or size.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_offsets", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							left: params.left,
							top: params.top,
							right: params.right,
							bottom: params.bottom,
							position: toVector2Array(params.position),
							size: toVector2Array(params.size),
						}),
					),
			},
			set_size: {
				description:
					"Set a widget size: vector2 for CanvasPanel children, or fill/auto for box slots.",
				paramsSchema: requireWidgetTargetSelection({
					widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
					size: z.union([z.enum(["fill", "auto", "automatic"]), vector2InputSchema]),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_size", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							size: Array.isArray(params.size) ? toVector2Array(params.size) : params.size,
						}),
					),
			},
			set_padding: {
				description:
					"Set slot padding (left/top/right/bottom) for a widget whose slot supports padding.",
				paramsSchema: requireAtLeastOneValue(
					requireWidgetTargetSelection({
						widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
						left: z.number().optional(),
						top: z.number().optional(),
						right: z.number().optional(),
						bottom: z.number().optional(),
					}),
					["left", "top", "right", "bottom"],
					"Provide at least one padding edge.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_padding", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							left: params.left,
							top: params.top,
							right: params.right,
							bottom: params.bottom,
						}),
					),
			},
			add_panel: {
				description:
					"Create a panel widget (HorizontalBox, VerticalBox, Overlay, SizeBox, ScrollBox, Border, GridPanel, CanvasPanel) and add it as a child, then save the widget blueprint.",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					panel_type: z.string(),
					panel_name: z.string(),
					parent_widget_name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("add_panel", {
							widget_name: widgetBlueprintParam(params),
							panel_type: requiredStringParam(params, ["panel_type"]),
							panel_name: requiredStringParam(params, ["panel_name"]),
							parent_widget_name: optionalStringParam(params, ["parent_widget_name"]),
						}),
					),
			},
			set_slot: {
				description:
					"Apply slot properties (padding, alignment, fill/auto size, grid row/column, canvas z_order) based on the widget's actual slot class; unsupported properties return warnings. Target widget: widget_member_name (preferred), widget_component_name, or widget_name.",
				paramsSchema: requireAtLeastOneValue(
					requireWidgetTargetSelection({
						widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
						padding: z
							.object({
								left: z.number(),
								top: z.number(),
								right: z.number(),
								bottom: z.number(),
							})
							.strict()
							.optional(),
						horizontal_alignment: z.string().optional(),
						vertical_alignment: z.string().optional(),
						size: z.union([z.enum(["fill", "auto", "automatic"]), vector2InputSchema]).optional(),
						row: z.number().optional(),
						column: z.number().optional(),
						row_span: z.number().optional(),
						column_span: z.number().optional(),
						z_order: z.number().optional(),
					}),
					[
						"padding",
						"horizontal_alignment",
						"vertical_alignment",
						"size",
						"row",
						"column",
						"row_span",
						"column_span",
						"z_order",
					],
					"Provide at least one slot property: padding, horizontal_alignment, vertical_alignment, size, row, column, row_span, column_span, or z_order.",
				),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_slot", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							padding: params.padding,
							horizontal_alignment: optionalStringParam(params, ["horizontal_alignment"]),
							vertical_alignment: optionalStringParam(params, ["vertical_alignment"]),
							size: Array.isArray(params.size) ? toVector2Array(params.size) : params.size,
							row: params.row,
							column: params.column,
							row_span: params.row_span,
							column_span: params.column_span,
							z_order: params.z_order,
						}),
					),
			},
			set_widget_property: {
				description:
					"Set a whitelisted widget property with type validation (visibility, is_enabled, tooltip_text, render_opacity, clipping, text, font_size, color, and per-widget properties such as slider value or checkbox is_checked). Target widget: widget_member_name (preferred), widget_component_name, or widget_name.",
				paramsSchema: requireWidgetTargetSelection({
					widget_name: z.string().optional(),
						widget_member_name: z.string().optional(),
						widget_component_name: z.string().optional(),
					property: z.string(),
					value: z.union([
						z.string(),
						z.number(),
						z.boolean(),
						z.array(z.number()),
						z.record(z.string(), z.number()),
					]),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_widget_property", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: widgetMemberParam(params),
							property: requiredStringParam(params, ["property"]),
							value: params.value,
						}),
					),
			},
			list_events: {
				description:
					"List delegate events a widget exposes (OnClicked, OnPressed, OnTextChanged, ...) so bind_event can be called with a valid event name.",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					widget_name: z.string().optional(),
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("list_events", {
							widget_name: widgetBlueprintParam(params),
							target_widget_name: optionalWidgetMemberParam(params),
						}),
					),
			},
			insert_widget: {
				description:
					"Create a widget and insert it into a panel at an explicit index. Native tree lane: one transaction, preview invalidation and one compile per call.",
				paramsSchema: requireWidgetAssetAndName({
					widget_class: z.string(),
					widget_name: z.string().optional(),
					name: z.string().optional(),
					widget_member_name: z.string().optional(),
					parent_widget_name: z.string().optional(),
					parent: z.string().optional(),
					index: z.number().optional(),
					...placementShape,
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("insert_widget", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							class: requiredStringParam(params, ["widget_class"]),
							widget: requiredStringParam(params, ["widget_name", "name", "widget_member_name"]),
							parent: optionalStringParam(params, ["parent_widget_name", "parent"]),
							index: typeof params.index === "number" ? params.index : undefined,
							layout: {
								position: toVector2Record(params.position),
								size: toVector2Record(params.size),
								z_order: typeof params.z_order === "number" ? params.z_order : undefined,
							},
						}),
					),
			},
			reorder_child: {
				description: "Move a widget to a new index inside its current panel.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					index: z.number(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("reorder_child", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							index: Number(params.index),
						}),
					),
			},
			duplicate_widget: {
				description: "Duplicate a widget (deep by default) into the same parent with a new name.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					new_name: z.string().optional(),
					duplicate_name: z.string().optional(),
					deep: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("duplicate_widget", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							new_name: optionalStringParam(params, ["new_name", "duplicate_name"]),
							deep: params.deep !== false,
						}),
					),
			},
			rename_widget: {
				description:
					"Rename a widget as a binding-retarget transaction: variable nodes, Bindings, animation bindings and Slate preview all follow the new name.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					new_name: z.string(),
					retarget_bindings: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("rename_widget", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							new_name: requiredStringParam(params, ["new_name"]),
							retarget_bindings: params.retarget_bindings !== false,
						}),
					),
			},
			serialize_tree: {
				description: "Serialize the widget hierarchy (flat list plus nested tree) with ids, classes, parents, indexes and slots.",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					include_slot: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("serialize_tree", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							include_slot: params.include_slot !== false,
						}),
					),
			},
			validate_widget: {
				description:
					"Validate the widget blueprint: orphan bindings, orphan animation bindings, unreachable widgets, duplicate names and missing asset references.",
				paramsSchema: requireWidgetBlueprintAssetSelection({}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("validate_widget", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
						}),
					),
			},
			set_style: {
				description:
					"Patch the existing Slate style structs in place (font, colours, brushes, button states) without replacing whole structs.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					style: z.record(z.string(), z.any()).optional(),
					font: z.record(z.string(), z.any()).optional(),
					brush: z.record(z.string(), z.any()).optional(),
					states: z.record(z.string(), z.any()).optional(),
					color: z.union([ctx.colorInputSchema, z.record(z.string(), z.any())]).optional(),
					font_size: z.number().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_style", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							style: params.style,
							font: params.font,
							brush: params.brush,
							states: params.states,
							color: params.color,
							font_size: params.font_size,
						}),
					),
			},
			set_brush: {
				description: "Patch one SlateBrush (texture or material, draw mode, margin, tint, image size) in place.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					property: z.string().optional(),
					brush: z.record(z.string(), z.any()).optional(),
					texture_path: z.string().optional(),
					material_path: z.string().optional(),
					draw_as: z.string().optional(),
					margin: z.union([z.number(), z.record(z.string(), z.any())]).optional(),
					tint: z.union([ctx.colorInputSchema, z.record(z.string(), z.any())]).optional(),
					image_size: vector2InputSchema.optional(),
					match_size: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("set_brush", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							property: optionalStringParam(params, ["property"]),
							brush: params.brush,
							texture_path: optionalStringParam(params, ["texture_path"]),
							material_path: optionalStringParam(params, ["material_path"]),
							draw_as: optionalStringParam(params, ["draw_as"]),
							margin: params.margin,
							tint: params.tint,
							image_size: toVector2Record(params.image_size),
							match_size: params.match_size === true,
						}),
					),
			},
			list_delegates: {
				description:
					"List the multicast delegate events a widget class declares (reflected natively; Python cannot enumerate UPROPERTY delegates).",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					class_name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("list_delegates", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: optionalWidgetMemberParam(params),
							class_name: optionalStringParam(params, ["class_name"]),
						}),
					),
			},
			list_bound_events: {
				description: "List the authoritative UWidgetBlueprint Bindings with validity flags for each widget/property/function.",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("list_bound_events", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: optionalWidgetMemberParam(params),
						}),
					),
			},
			unbind_event: {
				description: "Remove a widget event binding, optionally deleting its now-unused function graph.",
				paramsSchema: requireWidgetTargetSelection({
					widget_member_name: z.string().optional(),
					widget_component_name: z.string().optional(),
					widget_name: z.string().optional(),
					event_name: z.string(),
					function_name: z.string().optional(),
					remove_function_graph: z.boolean().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("unbind_event", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							widget: widgetMemberParam(params),
							event_name: requiredStringParam(params, ["event_name"]),
							function_name: optionalStringParam(params, ["function_name"]),
							remove_function_graph: params.remove_function_graph === true,
						}),
					),
			},
			designer_screenshot: {
				description:
					"Render the designer preview to a PNG (FWidgetRenderer render target) under the project directory and report preview staleness.",
				paramsSchema: requireWidgetBlueprintAssetSelection({
					width: z.number().optional(),
					height: z.number().optional(),
					output_path: z.string().optional(),
				}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("designer_screenshot", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
							width: params.width,
							height: params.height,
							output_path: optionalStringParam(params, ["output_path"]),
						}),
					),
			},
			inspect_selection: {
				description: "Describe the widgets currently selected in the open UMG designer, with ids and preview names.",
				paramsSchema: requireWidgetBlueprintAssetSelection({}),
				handler: (params) =>
					pythonDispatch(
						editorTools.UEUMGTool("inspect_selection", {
							asset_path: requiredStringParam(params, widgetBlueprintAssetKeys),
						}),
					),
			},
		},
		{ compactParamsSchema: true },
	)
}