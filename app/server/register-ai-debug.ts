import { z } from "zod"

import { requireAtLeastOneValue, searchAssetsShape } from "./namespace-action-schema-fragments.js"
import type { RegistrationContext } from "./registration-context.js"
import { tryRunCommand } from "./remote-execution.js"

const parsePythonJson = (text: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				// Fall through to the raw text.
			}
		}
		return text
	}
}

const AI_READ_OPERATIONS = ["status", "actors", "assets", "navmesh", "perception"] as const
const DEBUG_MODES = ["navmesh", "gameplay_debugger", "perception"] as const
const DEBUG_COMMANDS: Record<(typeof DEBUG_MODES)[number], string> = {
	navmesh: "show Navigation",
	gameplay_debugger: "gameplaydebugger",
	perception: "show Debug AI",
}
const BLACKBOARD_KEY_TYPES = [
	"Bool",
	"Int",
	"Float",
	"Vector",
	"Rotator",
	"Name",
	"String",
	"Object",
	"Class",
] as const

export function registerAiDebugNamespace(ctx: RegistrationContext) {
	const { directDispatch, editorTools, optionalStringParam, pythonDispatch, registerToolNamespace, requiredStringParam, searchAssetsCommand } = ctx

	const readAI = async (operation: (typeof AI_READ_OPERATIONS)[number]) => {
		const text = await tryRunCommand(editorTools.UEDebugAI(operation))
		const parsed = parsePythonJson(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Unexpected AI debug response: ${text.slice(0, 200)}`)
		}
		return {
			...(parsed as Record<string, unknown>),
			generatedAt: new Date().toISOString(),
		}
	}

	const runAiOperation = async (operation: string, args: Record<string, unknown> = {}) => {
		const text = await tryRunCommand(editorTools.UEAITool(operation, args))
		const parsed = parsePythonJson(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Unexpected manage_ai response for ${operation}: ${text.slice(0, 300)}`)
		}
		return directDispatch({
			...(parsed as Record<string, unknown>),
			operation,
			generatedAt: new Date().toISOString(),
		})
	}

	const runBtOperation = async (operation: string, args: Record<string, unknown> = {}) => {
		const text = await tryRunCommand(editorTools.UEBehaviorTreeTool(operation, args))
		const parsed = parsePythonJson(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Unexpected manage_ai ${operation} response: ${text.slice(0, 300)}`)
		}
		return directDispatch({
			...(parsed as Record<string, unknown>),
			operation,
			generatedAt: new Date().toISOString(),
		})
	}

	const actions = {
		status: {
			description: "Summarize AI controllers, behavior tree/blackboard assets, navmesh actors, and perception actors.",
			handler: async () => directDispatch(await readAI("status")),
		},
		actors: {
			description: "List AI controllers with their possessed pawn, brain component, and perception state.",
			handler: async () => directDispatch(await readAI("actors")),
		},
		assets: {
			description: "List BehaviorTree and BlackboardData assets under /Game with their blackboard assignment.",
			handler: async () => directDispatch(await readAI("assets")),
		},
		navmesh: {
			description: "List NavMeshBoundsVolume and RecastNavMesh actors with their bounds.",
			handler: async () => directDispatch(await readAI("navmesh")),
		},
		perception: {
			description: "List actors with AI perception components and their known perceived actors.",
			handler: async () => directDispatch(await readAI("perception")),
		},
		toggle_debug: {
			description: "Preview or execute an allowlisted AI debugger console command (navmesh, gameplay debugger, perception).",
			paramsSchema: z
				.object({
					mode: z.enum(DEBUG_MODES),
					confirm: z.boolean().optional(),
				})
				.strict(),
			handler: async (params: Record<string, any>) => {
				const value = params as { mode: (typeof DEBUG_MODES)[number]; confirm?: boolean }
				const command = DEBUG_COMMANDS[value.mode]
				if (!value.confirm) {
					return directDispatch({
						success: true,
						preview: true,
						mode: value.mode,
						command,
						note: "Set confirm=true to execute the allowlisted debugger console command. It is supervised.",
					})
				}
				const text = await tryRunCommand(editorTools.UEConsoleCommand(command))
				return directDispatch({
					success: true,
					preview: false,
					mode: value.mode,
					command,
					output: text,
					note: "Debugger command requested; inspect the viewport and editor log.",
				})
			},
		},
		create_behavior_tree: {
			description: "Create a BehaviorTree asset under /Game (default /Game/AI).",
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
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEContentFactoryTool("create_behavior_tree", {
						name: requiredStringParam(params, ["name", "asset_name"]),
						path: optionalStringParam(params, ["path"]),
					}),
				),
		},
		search_behavior_trees: {
			description: "Search BehaviorTree assets by name, path, or class.",
			paramsSchema: z.object(searchAssetsShape).strict(),
			handler: (params: Record<string, any>) => pythonDispatch(searchAssetsCommand(params, "BehaviorTree")),
		},
		create_blackboard: {
			description: "Create a BlackboardData asset under /Game (default /Game/AI). Report created=false when the asset already exists.",
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
			handler: (params: Record<string, any>) =>
				runAiOperation("create_blackboard", {
					name: requiredStringParam(params, ["name", "asset_name"]),
					path: optionalStringParam(params, ["path"]),
				}),
		},
		list_blackboard_keys: {
			description: "List the keys of a BlackboardData asset with their type, instance-sync flag, category, and base class.",
			paramsSchema: z.object({ blackboard_path: z.string() }).strict(),
			handler: (params: Record<string, any>) =>
				runAiOperation("list_blackboard_keys", { blackboard_path: requiredStringParam(params, ["blackboard_path"]) }),
		},
		add_blackboard_key: {
			description:
				"Add a key (Bool, Int, Float, Vector, Rotator, Name, String, Object, Class) to a BlackboardData asset and save it. Object/Class keys accept an optional base_class.",
			paramsSchema: z
				.object({
					blackboard_path: z.string(),
					key_name: z.string(),
					key_type: z.enum(BLACKBOARD_KEY_TYPES),
					instance_synced: z.boolean().optional(),
					category: z.string().optional(),
					base_class: z.string().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runAiOperation("add_blackboard_key", {
					blackboard_path: requiredStringParam(params, ["blackboard_path"]),
					key_name: requiredStringParam(params, ["key_name"]),
					key_type: requiredStringParam(params, ["key_type"]),
					instance_synced: params.instance_synced === true,
					category: optionalStringParam(params, ["category"]),
					base_class: optionalStringParam(params, ["base_class"]),
				}),
		},
		remove_blackboard_key: {
			description: "Remove a key from a BlackboardData asset and save it. Inherited parent keys are rejected.",
			paramsSchema: z
				.object({
					blackboard_path: z.string(),
					key_name: z.string(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runAiOperation("remove_blackboard_key", {
					blackboard_path: requiredStringParam(params, ["blackboard_path"]),
					key_name: requiredStringParam(params, ["key_name"]),
				}),
		},
		inspect_behavior_tree: {
			description:
				"Inspect a BehaviorTree: root node, recursive composites/tasks with child indices, decorators, services, node count, and the assigned blackboard with its keys.",
			paramsSchema: z.object({ behavior_tree_path: z.string() }).strict(),
			handler: (params: Record<string, any>) =>
				runAiOperation("inspect_behavior_tree", { behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]) }),
		},
		assign_behavior_tree: {
			description:
				"Run a BehaviorTree on a placed AIController (actor name/label/path) or a controller Blueprint path, optionally possessing a pawn. Reports the controller, pawn, and running state; the assignment is per instance and not persisted to the Blueprint.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					target: z.string(),
					pawn: z.string().optional(),
					spawn_if_missing: z.boolean().optional(),
					possess: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runAiOperation("assign_behavior_tree", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					target: requiredStringParam(params, ["target"]),
					pawn: optionalStringParam(params, ["pawn"]),
					spawn_if_missing: params.spawn_if_missing === true,
					possess: params.possess === true,
				}),
		},
		bt_create: {
			description:
				"Create a BehaviorTree asset under /Game (default /Game/AI). Pass root_class to author the root composite immediately and blackboard_path to assign a BlackboardData; no editor graph exists until a node is authored.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						name: z.string().optional(),
						asset_name: z.string().optional(),
						path: z.string().optional(),
						blackboard_path: z.string().optional(),
						root_class: z.string().optional(),
					})
					.strict(),
				["name", "asset_name"],
				"Provide name or asset_name.",
			),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_create", {
					name: requiredStringParam(params, ["name", "asset_name"]),
					path: optionalStringParam(params, ["path"]),
					blackboard_path: optionalStringParam(params, ["blackboard_path"]),
					root_class: optionalStringParam(params, ["root_class"]),
				}),
		},
		bt_inspect: {
			description:
				"Inspect a BehaviorTree with readable snapshot ids (ei:<n> tree nodes, ei:<n>/d<k> decorators, ei:<n>/s<k> services, root) plus editor-graph state (exists, root_linked, node_count, mod_counter) and structural issues. Decorators and services consume execution indices, so ids renumber after a structural edit; re-read the id map from the response or from bt_inspect before addressing a node again.",
			paramsSchema: z.object({ behavior_tree_path: z.string(), include_graph: z.boolean().optional() }).strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_inspect", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					include_graph: params.include_graph !== false,
				}),
		},
		bt_add_node: {
			description:
				"Add a composite (Selector/Sequence/SimpleParallel/...) or task node under parent_id, or as the tree root when no parent_id is given. Children are appended when index is omitted. Authors the compiled tree and the editor graph in one transaction; returns node_id, execution_index and the full id map.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					parent_id: z.string().optional(),
					kind: z.enum(["composite", "task"]),
					node_class: z.string(),
					index: z.number().int().nonnegative().optional(),
					save: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_add_node", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					parent_id: optionalStringParam(params, ["parent_id"]),
					kind: requiredStringParam(params, ["kind"]),
					node_class: requiredStringParam(params, ["node_class"]),
					index: params.index,
					save: params.save !== false,
				}),
		},
		bt_remove_node: {
			description:
				"Remove a composite or task with its runtime subtree from the tree and its editor graph node, reporting every removed id. The visual root node cannot be removed.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), node_id: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_remove_node", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					save: params.save !== false,
				}),
		},
		bt_move_node: {
			description:
				"Reparent a composite or task under new_parent_id at new_index (default: append). Sibling order is stored in the graph pin layout, so moving also relinks the graph and renumbers execution indices.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					node_id: z.string(),
					new_parent_id: z.string(),
					new_index: z.number().int().nonnegative().optional(),
					index: z.number().int().nonnegative().optional(),
					save: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_move_node", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					new_parent_id: requiredStringParam(params, ["new_parent_id"]),
					new_index: params.new_index ?? params.index,
					save: params.save !== false,
				}),
		},
		bt_set_node_property: {
			description:
				"Set one reflected property on a composite, task, decorator or service instance and report previous/current values with a verified flag. Edit-const properties are rejected.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					node_id: z.string(),
					property: z.string(),
					value: z.unknown(),
					save: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_set_node_property", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					property: requiredStringParam(params, ["property"]),
					value: params.value,
					save: params.save !== false,
				}),
		},
		bt_add_decorator: {
			description:
				"Attach a decorator to a node (or the tree root) with optional properties and array index. Several decorators on one node combine with AND; logic_op other than test is rejected in 1.7.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					node_id: z.string(),
					decorator_class: z.string(),
					properties: z.record(z.unknown()).optional(),
					index: z.number().int().nonnegative().optional(),
					logic_op: z.literal("test").optional(),
					save: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_add_decorator", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					decorator_class: requiredStringParam(params, ["decorator_class"]),
					properties: params.properties,
					index: params.index,
					logic_op: optionalStringParam(params, ["logic_op"]),
					save: params.save !== false,
				}),
		},
		bt_remove_decorator: {
			description: "Remove a decorator (id ei:<n>/d<k>) from a node and report the removed ids.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), node_id: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_remove_decorator", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					save: params.save !== false,
				}),
		},
		bt_add_service: {
			description:
				"Attach a service to a composite or task with optional properties and array index. Services run on their own tick interval and are renumbered into execution indices.",
			paramsSchema: z
				.object({
					behavior_tree_path: z.string(),
					node_id: z.string(),
					service_class: z.string(),
					properties: z.record(z.unknown()).optional(),
					index: z.number().int().nonnegative().optional(),
					save: z.boolean().optional(),
				})
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_add_service", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					service_class: requiredStringParam(params, ["service_class"]),
					properties: params.properties,
					index: params.index,
					save: params.save !== false,
				}),
		},
		bt_remove_service: {
			description: "Remove a service (id ei:<n>/s<k>) from a node and report the removed ids.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), node_id: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_remove_service", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					node_id: requiredStringParam(params, ["node_id"]),
					save: params.save !== false,
				}),
		},
		bt_set_blackboard: {
			description:
				"Assign (or clear) the BlackboardData of a behavior tree, sync the editor graph root node, and re-initialize every node so blackboard key indices resolve.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), blackboard_path: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_set_blackboard", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					blackboard_path: requiredStringParam(params, ["blackboard_path"]),
					save: params.save !== false,
				}),
		},
		bt_compile: {
			description:
				"Rebuild the compiled behavior tree from the editor graph (the same path the behavior tree editor uses on save), renumber execution indices, and report node_count, execution_index_max and warnings.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_compile", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					save: params.save !== false,
				}),
		},
		bt_repair_graph: {
			description:
				"Discard the editor graph of a behavior tree and mirror the compiled tree into a fresh graph (root, composites, tasks, decorators, services). Use it when the graph is missing or diverged.",
			paramsSchema: z
				.object({ behavior_tree_path: z.string(), save: z.boolean().optional() })
				.strict(),
			handler: (params: Record<string, any>) =>
				runBtOperation("bt_repair_graph", {
					behavior_tree_path: requiredStringParam(params, ["behavior_tree_path"]),
					save: params.save !== false,
				}),
		},
	}

	registerToolNamespace(
		"manage_ai",
		"Inspect AI controllers, pawns, behavior trees, blackboards, navmesh actors, and perception; toggle debugger views; author behavior tree graphs (nodes, decorators, services, blackboard wiring, compile and repair); create behavior trees and blackboards; add, remove, and list blackboard keys; inspect and run behavior trees.",
		actions,
	)
}
