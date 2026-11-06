import { z } from "zod"

import {
	blueprintNameShape,
	requireAtLeastOneValue,
	vector3TransformShape,
} from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"

export function registerContentBlueprintNamespaces(ctx: RegistrationContext) {
	const {
		blueprintNameParam,
		editorTools,
		optionalStringParam,
		pythonDispatch,
		registerToolNamespace,
		requiredStringParam,
		toRotatorArray,
		toVector3Array,
	} = ctx

	const blueprintTargetNoNameShape = {
		blueprint_name: z.string().optional(),
		asset_path: z.string().optional(),
	}

	const graphSelectorShape = {
		graph_id: z.string().optional(),
		graph_name: z.string().optional(),
		function_name: z.string().optional(),
		macro_name: z.string().optional(),
	}

	const signaturePinShape = z
		.object({
			name: z.string().optional(),
			pin_name: z.string().optional(),
			type: z.string().optional(),
			pin_type: z.string().optional(),
			default: z.any().optional(),
			direction: z.string().optional(),
		})
		.strict()

	const renamePinShape = z
		.object({
			from: z.string().optional(),
			name: z.string().optional(),
			to: z.string().optional(),
			new_name: z.string().optional(),
		})
		.strict()

	const functionFlagsShape = z.union([z.record(z.any()), z.array(z.string())])

	const functionMetaShape = z.record(z.any())

	registerToolNamespace("manage_blueprint", ctx.toolDescription("manage_blueprint"), {
		create_blueprint: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						name: z.string().optional(),
						blueprint_name: z.string().optional(),
						parent_class: z.string().optional(),
						path: z.string().optional(),
					})
					.strict(),
				["name", "blueprint_name"],
				"Provide name or blueprint_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("create_blueprint", {
						name: requiredStringParam(params, ["name", "blueprint_name"]),
						parent_class: optionalStringParam(params, ["parent_class"]),
						path: optionalStringParam(params, ["path"]),
					}),
				),
		},
		add_component: {
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					requireAtLeastOneValue(
						z
							.object({
								...blueprintTargetNoNameShape,
								component_type: z.string().optional(),
								class_name: z.string().optional(),
								component_name: z.string().optional(),
								name: z.string().optional(),
								...vector3TransformShape,
								component_properties: z.record(z.any()).optional(),
								parent_component_name: z.string().optional(),
							})
							.strict(),
						["blueprint_name", "asset_path"],
						"Provide blueprint_name or asset_path for the target Blueprint.",
					),
					["component_type", "class_name"],
					"Provide component_type or class_name.",
				),
				["component_name", "name"],
				"Provide component_name or name for the new component.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.add_component", {
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path"]),
						component_type: requiredStringParam(params, ["component_type", "class_name"]),
						component_name: requiredStringParam(params, ["component_name", "name"]),
						location: toVector3Array(params.location),
						rotation: toRotatorArray(params.rotation),
						scale: toVector3Array(params.scale),
						component_properties: params.component_properties,
						parent_component_name: optionalStringParam(params, ["parent_component_name"]),
						save: params.save,
					}),
				),
		},
		set_static_mesh: {
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							component_name: z.string(),
							static_mesh: z.string().optional(),
							mesh_path: z.string().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["static_mesh", "mesh_path"],
				"Provide static_mesh or mesh_path.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("set_static_mesh_properties", {
						blueprint_name: blueprintNameParam(params),
						component_name: requiredStringParam(params, ["component_name"]),
						static_mesh: requiredStringParam(params, ["static_mesh", "mesh_path"]),
					}),
				),
		},
		set_component_property: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						component_name: z.string(),
						property_name: z.string(),
						property_value: z.any().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("set_component_property", {
						blueprint_name: blueprintNameParam(params),
						component_name: requiredStringParam(params, ["component_name"]),
						property_name: requiredStringParam(params, ["property_name"]),
						property_value: params.property_value,
					}),
				),
		},
		set_physics_properties: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						component_name: z.string(),
						simulate_physics: z.boolean().optional(),
						gravity_enabled: z.boolean().optional(),
						mass: z.number().optional(),
						linear_damping: z.number().optional(),
						angular_damping: z.number().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("set_physics_properties", {
						blueprint_name: blueprintNameParam(params),
						component_name: requiredStringParam(params, ["component_name"]),
						simulate_physics: params.simulate_physics,
						gravity_enabled: params.gravity_enabled,
						mass: params.mass,
						linear_damping: params.linear_damping,
						angular_damping: params.angular_damping,
					}),
				),
		},
		set_blueprint_property: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						property_name: z.string(),
						property_value: z.any().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("set_blueprint_property", {
						blueprint_name: blueprintNameParam(params),
						property_name: requiredStringParam(params, ["property_name"]),
						property_value: params.property_value,
					}),
				),
		},
		compile: {
			paramsSchema: requireAtLeastOneValue(
				z.object(blueprintNameShape).strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.compile", {
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		read: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						include_nodes: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEBlueprintAnalysisTool("read_blueprint_content", {
						blueprint_name: blueprintNameParam(params),
						include_nodes: Boolean(params.include_nodes),
					}),
				),
		},
		inspect_components: {
			description: "Inspect the Blueprint SimpleConstructionScript components, classes, parents, and edited properties.",
			paramsSchema: requireAtLeastOneValue(
				z.object(blueprintNameShape).strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_components", {
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		inspect_graph: {
			description:
				"Inspect Blueprint graphs, including EventGraph and UserConstructionScript, with nodes, pins, links, and positions.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						...graphSelectorShape,
						include_nodes: z.boolean().optional(),
						include_pins: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_graph", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		add_node: {
			description:
				"Add an event, function call, variable node, branch, sequence, macro, component reference, comment, or raw K2 node. Set graph_name to UserConstructionScript for Construction Script authoring.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							node_type: z.string().optional(),
							node_class: z.string().optional(),
							event_name: z.string().optional(),
							function_name: z.string().optional(),
							target: z.string().optional(),
							component_name: z.string().optional(),
							variable_name: z.string().optional(),
							action_name: z.string().optional(),
							macro_name: z.string().optional(),
							macro_library: z.string().optional(),
							macro_path: z.string().optional(),
							comment: z.string().optional(),
							node_position: z.array(z.number()).optional(),
							params: z.record(z.any()).optional(),
							properties: z.record(z.any()).optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["node_type", "node_class"],
				"Provide node_type or node_class.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.add_node", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		connect_nodes: {
			description: "Connect a source output pin to a target input pin in a Blueprint graph.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						graph_name: z.string().optional(),
						source_node_id: z.string(),
						source_pin: z.string(),
						target_node_id: z.string(),
						target_pin: z.string(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.connect_nodes", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		disconnect_nodes: {
			description: "Break one pin link, or all links from a pin when target_pin is omitted.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						graph_name: z.string().optional(),
						source_node_id: z.string(),
						source_pin: z.string(),
						target_node_id: z.string().optional(),
						target_pin: z.string().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.disconnect_nodes", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		delete_node: {
			description: "Remove a Blueprint graph node and its links.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						graph_name: z.string().optional(),
						node_id: z.string(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.delete_node", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		add_variable: {
			description: "Add a Blueprint variable with a supported type and optional default, category, and tooltip.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						variable_name: z.string().optional(),
						name: z.string().optional(),
						variable_type: z.string(),
						default_value: z.any().optional(),
						is_exposed: z.boolean().optional(),
						is_instance_editable: z.boolean().optional(),
						category: z.string().optional(),
						tooltip: z.string().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			).superRefine((params, refineCtx) => {
				if (!params.variable_name && !params.name) {
					refineCtx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Provide variable_name or name.",
					})
				}
			}),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.add_variable", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		set_variable_flags: {
			description: "Update Blueprint variable flags: instance editability and expose-on-spawn.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						variable_name: z.string().optional(),
						name: z.string().optional(),
						is_instance_editable: z.boolean().optional(),
						is_exposed: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.set_variable_flags", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		set_pin_default: {
			description: "Set a Blueprint graph pin default value.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						node_id: z.string(),
						pin: z.string(),
						value: z.any(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.set_pin_default", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		create_function: {
			description:
				"Create a user function graph with optional typed inputs/outputs, flags, category, and tooltip. duplicate_policy=fail refuses an existing name (default); reuse returns the existing graph.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						function_name: z.string().optional(),
						name: z.string().optional(),
						inputs: z.array(signaturePinShape).optional(),
						outputs: z.array(signaturePinShape).optional(),
						flags: functionFlagsShape.optional(),
						category: z.string().optional(),
						tooltip: z.string().optional(),
						meta: functionMetaShape.optional(),
						duplicate_policy: z.enum(["fail", "reuse"]).optional(),
						compile: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			).superRefine((params, refineCtx) => {
				if (!params.function_name && !params.name) {
					refineCtx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Provide function_name or name.",
					})
				}
			}),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.create_function", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		list_graphs: {
			description:
				"List every graph in a Blueprint with its stable graph_id, kind (ubergraph/function/macro/delegate/subgraph), owner, and node count.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						include_subgraphs: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.list_graphs", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		inspect_function: {
			description:
				"Inspect one function graph: typed inputs/outputs, local variables, flags, metadata, and call sites.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_function", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		inspect_blueprint_model: {
			description:
				"Inspect the whole Blueprint model: graphs, functions, macros, local variables, construction script, and components.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						include_graphs: z.boolean().optional(),
						include_functions: z.boolean().optional(),
						include_macros: z.boolean().optional(),
						include_components: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_blueprint_model", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		inspect_construction_script: {
			description:
				"Inspect the UserConstructionScript graph: nodes, orphaned nodes, parent call node, and the PIE-verification requirement.",
			paramsSchema: requireAtLeastOneValue(
				z.object(blueprintNameShape).strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_construction_script", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		set_function_signature: {
			description:
				"Add, remove, or rename function parameters/results and update flags or metadata. Every change recompiles synchronously and reports stale call sites.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							add_inputs: z.array(signaturePinShape).optional(),
							add_outputs: z.array(signaturePinShape).optional(),
							remove_pins: z.array(z.union([z.string(), signaturePinShape])).optional(),
							rename_pins: z.array(renamePinShape).optional(),
							flags: functionFlagsShape.optional(),
							meta: functionMetaShape.optional(),
							category: z.string().optional(),
							tooltip: z.string().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.set_function_signature", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		rename_function: {
			description: "Rename a function graph and report the call sites that were rewritten.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							new_name: z.string().optional(),
							function_name: z.string().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.rename_function", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		delete_function: {
			description: "Delete a function graph and report the references that are now broken.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.delete_function", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		add_local_variable: {
			description:
				"Add a local variable to a function graph with a supported type, default value, category, and property flags.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							variable_name: z.string().optional(),
							name: z.string().optional(),
							pin_type: z.string().optional(),
							variable_type: z.string().optional(),
							default_value: z.any().optional(),
							category: z.string().optional(),
							flags: z.record(z.any()).optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			).superRefine((params, refineCtx) => {
				if (!params.variable_name && !params.name) {
					refineCtx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Provide variable_name or name.",
					})
				}
			}),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.add_local_variable", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		update_local_variable: {
			description:
				"Rename, retype, or retune a local variable. Retyping a referenced variable rewrites its nodes and requires force=true.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							variable_name: z.string().optional(),
							name: z.string().optional(),
							new_name: z.string().optional(),
							pin_type: z.string().optional(),
							variable_type: z.string().optional(),
							default_value: z.any().optional(),
							category: z.string().optional(),
							flags: z.record(z.any()).optional(),
							force: z.boolean().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.update_local_variable", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		remove_local_variable: {
			description:
				"Remove a local variable from a function graph. Referenced variables require force=true, which also deletes their nodes.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
							...graphSelectorShape,
							variable_name: z.string().optional(),
							name: z.string().optional(),
							force: z.boolean().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.remove_local_variable", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		create_macro_library: {
			description:
				"Create a Blueprint Macro Library asset (BPTYPE_MacroLibrary) that holds reusable macros.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						macro_library_name: z.string().optional(),
						name: z.string().optional(),
						path: z.string().optional(),
						parent_class: z.string().optional(),
						save: z.boolean().optional(),
					})
					.strict(),
				["macro_library_name", "name"],
				"Provide macro_library_name or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.create_macro_library", {
						...params,
					}),
				),
		},
		list_macros: {
			description:
				"List the macros in a macro library or Blueprint, with inputs, outputs, and instance counts.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						macro_library: z.string().optional(),
						library_path: z.string().optional(),
						query: z.string().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name", "macro_library", "library_path"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.list_macros", {
						...params,
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path", "name", "macro_library", "library_path"]),
					}),
				),
		},
		inspect_macro: {
			description: "Inspect one macro graph: inputs, outputs, metadata, and the nodes that instance it.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
						macro_library: z.string().optional(),
						library_path: z.string().optional(),
							...graphSelectorShape,
						})
						.strict(),
					["blueprint_name", "asset_path", "name", "macro_library", "library_path"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.inspect_macro", {
						...params,
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path", "name", "macro_library", "library_path"]),
					}),
				),
		},
		create_macro: {
			description: "Create a macro graph inside a macro library with optional typed inputs/outputs and description.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							macro_library: z.string().optional(),
							library_path: z.string().optional(),
							blueprint_name: z.string().optional(),
							asset_path: z.string().optional(),
							macro_name: z.string().optional(),
							name: z.string().optional(),
							inputs: z.array(signaturePinShape).optional(),
							outputs: z.array(signaturePinShape).optional(),
							description: z.string().optional(),
							category: z.string().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["macro_library", "library_path", "blueprint_name", "asset_path"],
					"Provide macro_library (or blueprint_name/asset_path) for the macro library.",
				),
				["macro_name", "name"],
				"Provide macro_name or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.create_macro", {
						...params,
					}),
				),
		},
		set_macro_signature: {
			description:
				"Add, remove, or rename macro inputs/outputs, then resynchronize every loaded macro instance.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
						macro_library: z.string().optional(),
						library_path: z.string().optional(),
							...graphSelectorShape,
							add_inputs: z.array(signaturePinShape).optional(),
							add_outputs: z.array(signaturePinShape).optional(),
							remove_pins: z.array(z.union([z.string(), signaturePinShape])).optional(),
							rename_pins: z.array(renamePinShape).optional(),
							meta: functionMetaShape.optional(),
							description: z.string().optional(),
							sync_instances: z.boolean().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name", "macro_library", "library_path"],
					"Provide blueprint_name, asset_path, or name of the macro library.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.set_macro_signature", {
						...params,
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path", "name", "macro_library", "library_path"]),
					}),
				),
		},
		rename_macro: {
			description: "Rename a macro graph and resynchronize its instances.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
						macro_library: z.string().optional(),
						library_path: z.string().optional(),
							...graphSelectorShape,
							new_name: z.string().optional(),
							macro_name: z.string().optional(),
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name", "macro_library", "library_path"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.rename_macro", {
						...params,
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path", "name", "macro_library", "library_path"]),
					}),
				),
		},
		delete_macro: {
			description: "Delete a macro graph and destroy its instances in loaded Blueprints.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintNameShape,
						macro_library: z.string().optional(),
						library_path: z.string().optional(),
							...graphSelectorShape,
							compile: z.boolean().optional(),
						})
						.strict(),
					["blueprint_name", "asset_path", "name", "macro_library", "library_path"],
					"Provide blueprint_name, asset_path, or name.",
				),
				["graph_id", "graph_name", "function_name", "macro_name"],
				"Provide graph_id or graph_name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.delete_macro", {
						...params,
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path", "name", "macro_library", "library_path"]),
					}),
				),
		},
		reset_construction_script: {
			description:
				"Clear the UserConstructionScript back to the parent call (or an empty body) without touching its signature.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						keep_parent_call: z.boolean().optional(),
						compile: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.reset_construction_script", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		verify_blueprint: {
			description:
				"Verify a Blueprint against an expected model (graphs, function signatures, locals, macros, construction script) and compile it.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						expected: z.record(z.any()).optional(),
						compile: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.verify_blueprint", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
		save: {
			description: "Save a Blueprint after graph edits.",
			paramsSchema: requireAtLeastOneValue(
				z.object(blueprintNameShape).strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGraphTool("blueprint.save", {
						...params,
						blueprint_name: blueprintNameParam(params),
					}),
				),
		},
	})
}
