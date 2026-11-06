import { z } from "zod"

import {
	actorNameShape,
	actorNameSchema,
	assetLookupSchema,
	blueprintNameShape,
	materialColorShape,
	requireAtLeastOneValue,
	requireValueGroups,
	searchAssetsShape,
} from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"

export function registerContentAssetNamespaces(ctx: RegistrationContext) {
	const {
		actorNameParam,
		blueprintNameParam,
		editorTools,
		optionalStringParam,
		pythonDispatch,
		registerToolNamespace,
		requiredStringParam,
		searchAssetsCommand,
		toColorArray,
	} = ctx

	registerToolNamespace("manage_skeleton", ctx.toolDescription("manage_skeleton"), {
		search_skeletons: {
			paramsSchema: z.object(searchAssetsShape).strict(),
			handler: (params) => pythonDispatch(searchAssetsCommand(params, "Skeleton")),
		},
		search_skeletal_meshes: {
			paramsSchema: z.object(searchAssetsShape).strict(),
			handler: (params) => pythonDispatch(searchAssetsCommand(params, "SkeletalMesh")),
		},
		asset_info: {
			paramsSchema: assetLookupSchema,
			handler: (params) =>
				pythonDispatch(editorTools.UEGetAssetInfo(requiredStringParam(params, ["asset_path", "path", "name"]))),
		},
	})

	registerToolNamespace("manage_material", ctx.toolDescription("manage_material"), {
		list_materials: {
			paramsSchema: z
				.object({
					search_term: z.string().optional(),
					query: z.string().optional(),
					include_engine: z.boolean().optional(),
					limit: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("get_available_materials", {
						search_term: optionalStringParam(params, ["search_term", "query"]),
						include_engine: params.include_engine,
						limit: params.limit,
					}),
				),
		},
		create_material_instance: {
			description:
				"Create a saved MaterialInstanceConstant from a parent material, with optional scalar/vector parameter overrides.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						parent_material: z.string().optional(),
						material_path: z.string().optional(),
						instance_name: z.string().optional(),
						asset_name: z.string().optional(),
						name: z.string().optional(),
						package_path: z.string().optional(),
						path: z.string().optional(),
						scalar_parameters: z.record(z.number()).optional(),
						vector_parameters: z.record(z.any()).optional(),
					})
					.strict(),
				["parent_material", "material_path"],
				"Provide parent_material or material_path.",
			),
			handler: (params) =>
				pythonDispatch(editorTools.UEMaterialTool("create_material_instance", params)),
		},
		inspect_material_instance: {
			description:
				"Read a MaterialInstanceConstant's parent, effective parameter values, and its explicit scalar, vector, texture, and static-switch overrides with types and values.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_instance: z.string().optional(),
						path: z.string().optional(),
					})
					.strict(),
				["asset_path", "material_instance", "path"],
				"Provide asset_path or material_instance.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("inspect_material_instance", {
						asset_path: requiredStringParam(params, ["asset_path", "material_instance", "path"]),
					}),
				),
		},
		set_material_instance_parameter: {
			description:
				"Set one scalar, vector, texture, or static-switch parameter on a MaterialInstanceConstant and save it. Static switches accept true or false (1/0, yes/no, on/off are also accepted).",
			paramsSchema: z
				.object({
					asset_path: z.string().optional(),
					material_instance: z.string().optional(),
					parameter_name: z.string(),
					parameter_type: z
						.enum([
							"scalar",
							"float",
							"vector",
							"color",
							"texture",
							"static_switch",
							"switch",
							"bool",
						])
						.optional(),
					value: z.any(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("set_material_instance_parameter", {
						asset_path: requiredStringParam(params, ["asset_path", "material_instance"]),
						parameter_name: requiredStringParam(params, ["parameter_name"]),
						parameter_type: optionalStringParam(params, ["parameter_type"]),
						value: params.value,
					}),
				),
		},
		get_material_instance_parameters: {
			description:
				"Read a MaterialInstanceConstant's explicit parameter overrides (scalar, vector, texture, static switch) with types and values, plus effective parameter values.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						instance_path: z.string().optional(),
						asset_path: z.string().optional(),
						material_instance: z.string().optional(),
						path: z.string().optional(),
					})
					.strict(),
				["instance_path", "asset_path", "material_instance", "path"],
				"Provide instance_path, asset_path, material_instance, or path.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("get_material_instance_parameters", {
						instance_path: requiredStringParam(params, ["instance_path", "asset_path", "material_instance", "path"]),
					}),
				),
		},
		set_material_instance_parameters: {
			description:
				"Set many scalar, vector, texture, and static-switch parameters on a MaterialInstanceConstant in one call with per-parameter results; saves only when save is true.",
			paramsSchema: requireValueGroups(
				z
					.object({
						instance_path: z.string().optional(),
						asset_path: z.string().optional(),
						material_instance: z.string().optional(),
						path: z.string().optional(),
						scalars: z.record(z.number()).optional(),
						vectors: z.record(z.any()).optional(),
						textures: z.record(z.string()).optional(),
						static_switches: z
							.record(z.union([z.boolean(), z.string(), z.number()]))
							.describe(
								"Static switch values keyed by parameter name. true/false, 1/0, yes/no, on/off are accepted.",
							)
							.optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				[
					{
						keys: ["instance_path", "asset_path", "material_instance", "path"],
						message: "Provide instance_path, asset_path, material_instance, or path.",
					},
					{
						keys: ["scalars", "vectors", "textures", "static_switches"],
						message:
							"Provide at least one of scalars, vectors, textures, or static_switches.",
					},
				],
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("set_material_instance_parameters", {
						instance_path: requiredStringParam(params, ["instance_path", "asset_path", "material_instance", "path"]),
						scalars: params.scalars,
						vectors: params.vectors,
						textures: params.textures,
						static_switches: params.static_switches,
						save: params.save,
					}),
				),
		},
		set_material_instance_parent: {
			description: "Reparent a MaterialInstanceConstant to another material or material instance and save it.",
			paramsSchema: z
				.object({
					asset_path: z.string().optional(),
					material_instance: z.string().optional(),
					parent_material: z.string().optional(),
					material_path: z.string().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("set_material_instance_parent", {
						asset_path: requiredStringParam(params, ["asset_path", "material_instance"]),
						parent_material: requiredStringParam(params, ["parent_material", "material_path"]),
					}),
				),
		},
		apply_to_actor: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...actorNameShape,
						component_name: z.string().optional(),
						material_path: z.string(),
						slot_index: z.number().optional(),
					})
					.strict(),
				["name", "actor_name"],
				"Provide name or actor_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("apply_material_to_actor", {
						actor_name: actorNameParam(params),
						component_name: optionalStringParam(params, ["component_name"]),
						material_path: requiredStringParam(params, ["material_path"]),
						slot_index: params.slot_index,
					}),
				),
		},
		apply_to_blueprint: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						component_name: z.string(),
						material_path: z.string(),
						slot_index: z.number().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("apply_material_to_blueprint", {
						blueprint_name: blueprintNameParam(params),
						component_name: requiredStringParam(params, ["component_name"]),
						material_path: requiredStringParam(params, ["material_path"]),
						slot_index: params.slot_index,
					}),
				),
		},
		tint_material: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...materialColorShape,
						actor_name: z.string().optional(),
						name: z.string().optional(),
						blueprint_name: z.string().optional(),
						asset_path: z.string().optional(),
						component_name: z.string().optional(),
						material_path: z.string().optional(),
						slot_index: z.number().optional(),
						parameter_name: z.string().optional(),
						instance_name: z.string().optional(),
						instance_path: z.string().optional(),
					})
					.strict(),
				["actor_name", "name", "blueprint_name", "asset_path", "material_path"],
				"Provide actor_name, name, blueprint_name, asset_path, or material_path.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEMaterialTool("set_mesh_material_color", {
						actor_name: optionalStringParam(params, ["actor_name", "name"]),
						blueprint_name: optionalStringParam(params, ["blueprint_name", "asset_path"]),
						component_name: optionalStringParam(params, ["component_name"]),
						material_path: optionalStringParam(params, ["material_path"]),
						slot_index: params.slot_index,
						color: toColorArray(params.color),
						parameter_name: optionalStringParam(params, ["parameter_name"]),
						instance_name: optionalStringParam(params, ["instance_name"]),
						instance_path: optionalStringParam(params, ["instance_path"]),
					}),
				),
		},
		inspect_graph: {
			description:
				"Inspect a Material or MaterialFunction graph: structured expressions and connections, each expression's reflected parameter values, material properties (blend mode, shading model, two-sided, usage flags), property inputs, and parameter defaults.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEMaterialTool("inspect_graph", params)),
		},
		create_material: {
			description: "Create a Material asset.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_name: z.string().optional(),
						name: z.string().optional(),
						path: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_name", "name"],
				"Provide asset_name or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.create_material", params)),
		},
		create_material_function: {
			description: "Create a MaterialFunction, layer, or layer-blend asset.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_name: z.string().optional(),
						name: z.string().optional(),
						path: z.string().optional(),
						function_type: z.enum(["function", "layer", "layer_blend"]).optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_name", "name"],
				"Provide asset_name or name.",
			),
			handler: (params) =>
				pythonDispatch(editorTools.UEGraphTool("material.create_material_function", params)),
		},
		add_expression: {
			description: "Add a material expression to a Material or MaterialFunction graph.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						expression_class: z.string(),
						x: z.number().optional(),
						y: z.number().optional(),
						node_position: z.array(z.number()).optional(),
						properties: z.record(z.any()).optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.add_expression", params)),
		},
		add_function_output: {
			description: "Add a MaterialFunction output expression.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						output_name: z.string().optional(),
						sort_priority: z.number().optional(),
						x: z.number().optional(),
						y: z.number().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "function_path", "path", "name"],
				"Provide asset_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.add_function_output", params)),
		},
		connect: {
			description: "Connect one material expression output to another expression input.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						source_expression: z.string(),
						target_expression: z.string(),
						source_output: z.string().optional(),
						target_input: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.connect", params)),
		},
		connect_property: {
			description: "Connect a material expression output to a Material property such as base_color or roughness.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						expression: z.string(),
						property: z.string(),
						source_output: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "path", "name"],
				"Provide asset_path, material_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.connect_property", params)),
		},
		delete_expression: {
			description: "Delete a material expression and its links.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						expression: z.string(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.delete_expression", params)),
		},
		set_expression_property: {
			description: "Set a reflected property on a material expression.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						expression: z.string(),
						property: z.string(),
						value: z.any(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.set_expression_property", params)),
		},
		layout: {
			description: "Auto-layout material or material-function expressions.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.layout", params)),
		},
		recompile: {
			description: "Recompile a Material after graph edits.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["asset_path", "material_path", "path", "name"],
				"Provide asset_path, material_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.recompile", params)),
		},
		save: {
			description: "Save a Material or MaterialFunction after graph edits.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_path: z.string().optional(),
						material_path: z.string().optional(),
						function_path: z.string().optional(),
						path: z.string().optional(),
						name: z.string().optional(),
					})
					.strict(),
				["asset_path", "material_path", "function_path", "path", "name"],
				"Provide asset_path, material_path, function_path, path, or name.",
			),
			handler: (params) => pythonDispatch(editorTools.UEGraphTool("material.save", params)),
		},
	})

	registerToolNamespace("manage_texture", ctx.toolDescription("manage_texture"), {
		search_textures: {
			paramsSchema: z.object(searchAssetsShape).strict(),
			handler: (params) => pythonDispatch(searchAssetsCommand(params, "Texture")),
		},
		texture_info: {
			paramsSchema: assetLookupSchema,
			handler: (params) =>
				pythonDispatch(editorTools.UEGetAssetInfo(requiredStringParam(params, ["asset_path", "path", "name"]))),
		},
		import_texture: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						source_file: z.string().optional(),
						file_path: z.string().optional(),
						local_path: z.string().optional(),
						destination_path: z.string().optional(),
						content_path: z.string().optional(),
						path: z.string().optional(),
						asset_name: z.string().optional(),
						name: z.string().optional(),
						replace_existing: z.boolean().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["source_file", "file_path", "local_path"],
				"Provide source_file, file_path, or local_path.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UETextureTool("import_texture", {
						source_file: requiredStringParam(params, ["source_file", "file_path", "local_path"]),
						destination_path: optionalStringParam(params, ["destination_path", "content_path", "path"]),
						asset_name: optionalStringParam(params, ["asset_name", "name"]),
						replace_existing: typeof params.replace_existing === "boolean" ? params.replace_existing : true,
						save: typeof params.save === "boolean" ? params.save : true,
					}),
				),
		},
	})

	registerToolNamespace("manage_data", ctx.toolDescription("manage_data"), {
		search_data_assets: {
			paramsSchema: z
				.object({
					search_term: z.string().optional(),
					query: z.string().optional(),
					pattern: z.string().optional(),
					name: z.string().optional(),
					include_engine: z.boolean().optional(),
					limit: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEDataTool("search_data_assets", {
						search_term: optionalStringParam(params, ["search_term", "query", "pattern", "name"]) ?? "",
						include_engine: Boolean(params.include_engine),
						limit: params.limit,
					}),
				),
		},
		asset_info: {
			paramsSchema: assetLookupSchema,
			handler: (params) =>
				pythonDispatch(editorTools.UEGetAssetInfo(requiredStringParam(params, ["asset_path", "path", "name"]))),
		},
		create_data_asset: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						name: z.string().optional(),
						asset_name: z.string().optional(),
						path: z.string().optional(),
						data_asset_class: z.string().optional(),
						class_name: z.string().optional(),
					})
					.strict(),
				["name", "asset_name"],
				"Provide name or asset_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEDataTool("create_data_asset", {
						name: requiredStringParam(params, ["name", "asset_name"]),
						path: optionalStringParam(params, ["path"]),
						data_asset_class: optionalStringParam(params, ["data_asset_class", "class_name"]),
					}),
				),
		},
		create_data_table: {
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							name: z.string().optional(),
							asset_name: z.string().optional(),
							path: z.string().optional(),
							row_struct: z.string().optional(),
							struct: z.string().optional(),
						})
						.strict(),
					["name", "asset_name"],
					"Provide name or asset_name.",
				),
				["row_struct", "struct"],
				"Provide row_struct or struct.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEDataTool("create_data_table", {
						name: requiredStringParam(params, ["name", "asset_name"]),
						path: optionalStringParam(params, ["path"]),
						row_struct: requiredStringParam(params, ["row_struct", "struct"]),
					}),
				),
		},
		create_string_table: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						name: z.string().optional(),
						asset_name: z.string().optional(),
						path: z.string().optional(),
					})
					.strict(),
				["name", "asset_name"],
				"Provide name or asset_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEDataTool("create_string_table", {
						name: requiredStringParam(params, ["name", "asset_name"]),
						path: optionalStringParam(params, ["path"]),
					}),
				),
		},
	})
}
