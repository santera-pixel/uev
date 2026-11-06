import { z } from "zod"

import { requireAtLeastOneValue } from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"

export function registerContentAnimationNamespaces(ctx: RegistrationContext) {
	const { editorTools, pythonDispatch, registerToolNamespace } = ctx

	const graphTargetShape = {
		asset_path: z.string().optional(),
		anim_blueprint: z.string().optional(),
		blueprint_name: z.string().optional(),
		path: z.string().optional(),
		name: z.string().optional(),
		save: z.boolean().optional(),
	}
	const graphTargetKeys = ["asset_path", "anim_blueprint", "blueprint_name", "path", "name"]
	const graphTargetMessage = "Provide asset_path, anim_blueprint, blueprint_name, path, or name."
	const sequenceTargetShape = {
		sequence_path: z.string().optional(),
		asset_path: z.string().optional(),
		path: z.string().optional(),
		name: z.string().optional(),
		save: z.boolean().optional(),
	}
	const sequenceTargetKeys = ["sequence_path", "asset_path", "path", "name"]
	const montageTargetShape = {
		montage_path: z.string().optional(),
		asset_path: z.string().optional(),
		path: z.string().optional(),
		name: z.string().optional(),
		save: z.boolean().optional(),
	}
	const montageTargetKeys = ["montage_path", "asset_path", "path", "name"]

	const graphSchema = (shape: z.ZodRawShape = {}) =>
		requireAtLeastOneValue(
			z.object({ ...graphTargetShape, ...shape }).strict(),
			graphTargetKeys,
			graphTargetMessage,
		)
	const sequenceSchema = (shape: z.ZodRawShape = {}) =>
		requireAtLeastOneValue(
			z.object({ ...sequenceTargetShape, ...shape }).strict(),
			sequenceTargetKeys,
			"Provide sequence_path, asset_path, path, or name.",
		)
	const montageSchema = (shape: z.ZodRawShape = {}) =>
		requireAtLeastOneValue(
			z.object({ ...montageTargetShape, ...shape }).strict(),
			montageTargetKeys,
			"Provide montage_path, asset_path, path, or name.",
		)
	const dispatch = (operation: string, params: Record<string, unknown>) =>
		pythonDispatch(editorTools.UEGraphTool(operation, params))

	registerToolNamespace("manage_animation", ctx.toolDescription("manage_animation"), {
		search_animation_assets: {
			description: "Search AnimSequence, AnimMontage, and AnimBlueprint assets.",
			paramsSchema: z
				.object({
					search_term: z.string().optional(),
					query: z.string().optional(),
					limit: z.number().optional(),
				})
				.strict(),
			handler: (params) =>
				dispatch("animation.search_animation_assets", {
					search_term: params.search_term ?? params.query,
					limit: params.limit,
				}),
		},
		inspect_graph: {
			description:
				"Inspect an AnimGraph, including state machines, states, transitions, state graphs, and transition graphs.",
			paramsSchema: graphSchema({
				graph_node_id: z.string().optional(),
				graph_kind: z.string().optional(),
				include_nodes: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.inspect_graph", params),
		},
		inspect_node_properties: {
			description:
				"Inspect an AnimGraph node's reflected properties, including nested structs, enums, arrays, maps, and current values.",
			paramsSchema: graphSchema({ node_id: z.string() }),
			handler: (params) => dispatch("animation.inspect_node_properties", params),
		},
		create_anim_blueprint: {
			description: "Create an AnimBlueprint from a Skeleton.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_name: z.string().optional(),
						name: z.string().optional(),
						path: z.string().optional(),
						skeleton: z.string(),
						preview_mesh: z.string().optional(),
					})
					.strict(),
				["asset_name", "name"],
				"Provide asset_name or name.",
			),
			handler: (params) => dispatch("animation.create_anim_blueprint", params),
		},
		add_graph_node: {
			description:
				"Add a sequence player/evaluator, blend, layered blend, slot, state machine, or raw AnimGraph node.",
			paramsSchema: requireAtLeastOneValue(
				graphSchema({
					node_type: z.string().optional(),
					node_kind: z.string().optional(),
					node_class: z.string().optional(),
					graph_node_id: z.string().optional(),
					node_position: z.array(z.number()).optional(),
					anim_asset: z.string().optional(),
					slot_name: z.string().optional(),
					function_name: z.string().optional(),
					target: z.string().optional(),
					variable_name: z.string().optional(),
					properties: z.record(z.any()).optional(),
				}),
				["node_type", "node_class"],
				"Provide node_type or node_class.",
			),
			handler: (params) => dispatch("animation.add_graph_node", params),
		},
		set_node_property: {
			description: "Set a reflected property on an AnimGraph node.",
			paramsSchema: graphSchema({
				node_id: z.string(),
				property: z.string(),
				value: z.any(),
			}),
			handler: (params) => dispatch("animation.set_node_property", params),
		},
		connect_nodes: {
			description: "Connect AnimGraph/state/transition graph pins.",
			paramsSchema: graphSchema({
				source_node_id: z.string(),
				source_pin: z.string(),
				target_node_id: z.string(),
				target_pin: z.string(),
			}),
			handler: (params) => dispatch("animation.connect_nodes", params),
		},
		disconnect_nodes: {
			description: "Disconnect AnimGraph pins.",
			paramsSchema: graphSchema({
				source_node_id: z.string(),
				source_pin: z.string(),
				target_node_id: z.string().optional(),
				target_pin: z.string().optional(),
			}),
			handler: (params) => dispatch("animation.disconnect_nodes", params),
		},
		delete_node: {
			description: "Delete an AnimGraph, state, or transition node.",
			paramsSchema: graphSchema({ node_id: z.string() }),
			handler: (params) => dispatch("animation.delete_node", params),
		},
		add_state_machine: {
			description: "Add a state machine node to an AnimGraph.",
			paramsSchema: graphSchema({ node_position: z.array(z.number()).optional() }),
			handler: (params) => dispatch("animation.add_state_machine", params),
		},
		add_state: {
			description: "Add a state (or conduit) to a state machine.",
			paramsSchema: graphSchema({
				state_machine_node_id: z.string(),
				state_name: z.string().optional(),
				state_type: z.enum(["single_animation", "blend_graph"]).optional(),
				connect_entry: z.boolean().optional(),
				node_position: z.array(z.number()).optional(),
			}),
			handler: (params) => dispatch(params.state_type === "blend_graph" ? "animation.add_state" : "animation.add_state", params),
		},
		add_conduit: {
			description: "Add a conduit state to a state machine.",
			paramsSchema: graphSchema({
				state_machine_node_id: z.string(),
				state_name: z.string().optional(),
				node_position: z.array(z.number()).optional(),
			}),
			handler: (params) => dispatch("animation.add_conduit", params),
		},
		add_transition: {
			description: "Add and connect a transition between two states.",
			paramsSchema: graphSchema({
				from_state_node_id: z.string(),
				to_state_node_id: z.string(),
				priority: z.number().optional(),
				crossfade: z.number().optional(),
				bidirectional: z.boolean().optional(),
				automatic_rule: z.boolean().optional(),
				node_position: z.array(z.number()).optional(),
			}),
			handler: (params) => dispatch("animation.add_transition", params),
		},
		set_transition: {
			description: "Set transition priority, crossfade, direction, or automatic sequence-player rule.",
			paramsSchema: graphSchema({
				node_id: z.string(),
				priority: z.number().optional(),
				crossfade: z.number().optional(),
				blend_mode: z.string().optional(),
				custom_blend_curve: z.string().optional(),
				blend_profile: z.string().optional(),
				bidirectional: z.boolean().optional(),
				automatic_rule: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.set_transition", params),
		},
		set_state_properties: {
			description: "Set state properties such as always_reset_on_entry.",
			paramsSchema: graphSchema({
				node_id: z.string(),
				always_reset_on_entry: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.set_state_properties", params),
		},
		rename_state: {
			description: "Rename a state's bound graph.",
			paramsSchema: graphSchema({ node_id: z.string(), state_name: z.string() }),
			handler: (params) => dispatch("animation.rename_state", params),
		},
		remove_state: {
			description: "Remove a state and its bound graph.",
			paramsSchema: graphSchema({ node_id: z.string() }),
			handler: (params) => dispatch("animation.remove_state", params),
		},
		remove_transition: {
			description: "Remove a transition and its rule graph.",
			paramsSchema: graphSchema({ node_id: z.string() }),
			handler: (params) => dispatch("animation.remove_transition", params),
		},
		add_rule_node: {
			description: "Add a transition-rule K2 node: function, branch, comparison, literal, variable_get, or raw.",
			paramsSchema: graphSchema({
				transition_node_id: z.string(),
				node_type: z.string(),
				function_name: z.string().optional(),
				target: z.string().optional(),
				variable_name: z.string().optional(),
				object_path: z.string().optional(),
				node_class: z.string().optional(),
				node_position: z.array(z.number()).optional(),
			}),
			handler: (params) => dispatch("animation.add_rule_node", params),
		},
		compile: {
			description: "Compile an AnimBlueprint and return compiler errors and warnings.",
			paramsSchema: graphSchema(),
			handler: (params) => dispatch("animation.compile", params),
		},
		save: {
			description: "Save an AnimBlueprint, AnimSequence, or AnimMontage.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...graphTargetShape,
						...sequenceTargetShape,
						...montageTargetShape,
					})
					.strict(),
				[...graphTargetKeys, ...sequenceTargetKeys, ...montageTargetKeys],
				"Provide an AnimBlueprint, AnimSequence, or AnimMontage identifier.",
			),
			handler: (params) => dispatch("animation.save", params),
		},
		inspect_sequence: {
			description: "Inspect an AnimSequence: length, rate, root motion, notifies, notify tracks, markers, and curves.",
			paramsSchema: sequenceSchema(),
			handler: (params) => dispatch("animation.inspect_sequence", params),
		},
		set_sequence_properties: {
			description: "Set AnimSequence rate scale, root motion, or reflected properties.",
			paramsSchema: sequenceSchema({
				rate_scale: z.number().optional(),
				root_motion: z.boolean().optional(),
				properties: z.record(z.any()).optional(),
				save: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.set_sequence_properties", params),
		},
		add_notify: {
			description: "Add a notify or notify-state to an AnimSequence.",
			paramsSchema: sequenceSchema({
				track_name: z.string().optional(),
				time: z.number(),
				duration: z.number().optional(),
				notify_class: z.string().optional(),
				notify_state_class: z.string().optional(),
				notify_name: z.string().optional(),
				save: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.add_notify", params),
		},
		remove_notify: {
			description: "Remove AnimSequence notify events by name.",
			paramsSchema: sequenceSchema({ notify_name: z.string() }),
			handler: (params) => dispatch("animation.remove_notify", params),
		},
		add_notify_track: {
			description: "Add an AnimSequence notify track.",
			paramsSchema: sequenceSchema({ track_name: z.string() }),
			handler: (params) => dispatch("animation.add_notify_track", params),
		},
		remove_notify_track: {
			description: "Remove an AnimSequence notify track.",
			paramsSchema: sequenceSchema({ track_name: z.string() }),
			handler: (params) => dispatch("animation.remove_notify_track", params),
		},
		add_sync_marker: {
			description: "Add an AnimSequence sync marker.",
			paramsSchema: sequenceSchema({
				marker_name: z.string(),
				time: z.number(),
				track_name: z.string().optional(),
			}),
			handler: (params) => dispatch("animation.add_sync_marker", params),
		},
		remove_sync_marker: {
			description: "Remove an AnimSequence sync marker by name.",
			paramsSchema: sequenceSchema({ marker_name: z.string() }),
			handler: (params) => dispatch("animation.remove_sync_marker", params),
		},
		add_curve_key: {
			description: "Add a float curve key to an AnimSequence.",
			paramsSchema: sequenceSchema({ curve_name: z.string(), time: z.number(), value: z.number() }),
			handler: (params) => dispatch("animation.add_curve_key", params),
		},
		remove_curve: {
			description: "Remove an AnimSequence curve by name.",
			paramsSchema: sequenceSchema({ curve_name: z.string() }),
			handler: (params) => dispatch("animation.remove_curve", params),
		},
		create_montage: {
			description: "Create an AnimMontage from an AnimSequence, with an initial slot and segment.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						asset_name: z.string().optional(),
						name: z.string().optional(),
						path: z.string().optional(),
						source_sequence: z.string(),
						slot_name: z.string().optional(),
					})
					.strict(),
				["asset_name", "name"],
				"Provide asset_name or name.",
			),
			handler: (params) => dispatch("animation.create_montage", params),
		},
		inspect_montage: {
			description: "Inspect an AnimMontage: sections, slots, segments, notifies, blend settings, and length.",
			paramsSchema: montageSchema(),
			handler: (params) => dispatch("animation.inspect_montage", params),
		},
		add_montage_slot: {
			description: "Add a montage slot, optionally with an initial animation segment.",
			paramsSchema: montageSchema({ slot_name: z.string(), sequence_path: z.string().optional() }),
			handler: (params) => dispatch("animation.add_montage_slot", params),
		},
		remove_montage_slot: {
			description: "Remove a montage slot by name.",
			paramsSchema: montageSchema({ slot_name: z.string() }),
			handler: (params) => dispatch("animation.remove_montage_slot", params),
		},
		add_montage_segment: {
			description: "Add an animation segment to a montage slot.",
			paramsSchema: montageSchema({
				slot_name: z.string(),
				sequence_path: z.string(),
				start_pos: z.number().optional(),
				start_time: z.number().optional(),
				end_time: z.number().optional(),
				play_rate: z.number().optional(),
				loops: z.number().optional(),
			}),
			handler: (params) => dispatch("animation.add_montage_segment", params),
		},
		remove_montage_segment: {
			description: "Remove a segment from a montage slot by index.",
			paramsSchema: montageSchema({ slot_name: z.string(), segment_index: z.number() }),
			handler: (params) => dispatch("animation.remove_montage_segment", params),
		},
		add_montage_section: {
			description: "Add a montage section and optionally set its next section.",
			paramsSchema: montageSchema({
				section_name: z.string(),
				start_time: z.number(),
				next_section: z.string().optional(),
			}),
			handler: (params) => dispatch("animation.add_montage_section", params),
		},
		set_montage_section: {
			description: "Set a montage section's start time or next section.",
			paramsSchema: montageSchema({
				section_name: z.string().optional(),
				section_index: z.number().optional(),
				start_time: z.number().optional(),
				next_section: z.string().optional(),
			}),
			handler: (params) => dispatch("animation.set_montage_section", params),
		},
		remove_montage_section: {
			description: "Remove a montage section by name.",
			paramsSchema: montageSchema({ section_name: z.string() }),
			handler: (params) => dispatch("animation.remove_montage_section", params),
		},
		add_montage_notify: {
			description: "Add a notify or notify-state to an AnimMontage.",
			paramsSchema: montageSchema({
				track_name: z.string().optional(),
				time: z.number(),
				duration: z.number().optional(),
				notify_class: z.string().optional(),
				notify_state_class: z.string().optional(),
				notify_name: z.string().optional(),
				save: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.add_montage_notify", params),
		},
		remove_montage_notify: {
			description: "Remove a montage notify by name.",
			paramsSchema: montageSchema({ notify_name: z.string() }),
			handler: (params) => dispatch("animation.remove_montage_notify", params),
		},
		set_montage_properties: {
			description: "Set montage blend, trigger, auto-blend, rate, and sync-group properties.",
			paramsSchema: montageSchema({
				blend_in: z.number().optional(),
				blend_out: z.number().optional(),
				blend_out_trigger: z.number().optional(),
				auto_blend_out: z.boolean().optional(),
				rate_scale: z.number().optional(),
				sync_group: z.string().optional(),
				save: z.boolean().optional(),
			}),
			handler: (params) => dispatch("animation.set_montage_properties", params),
		},
	})
}
