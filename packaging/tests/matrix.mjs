#!/usr/bin/env node
// UEV declarative test matrix.
//
// Every case is data: { id, group, tool, action, params, expect }. The runner
// turns each case into a control-API call, applies assertions taken from
// expect, prints PASS/FAIL per case and writes a JSON report.
//
// Usage:
//   node matrix.mjs                       # read-only cases against the live stack
//   node matrix.mjs --include-writes      # also run the mutating round trips
//   node matrix.mjs --only refusals       # group filter (repeatable)
//   node matrix.mjs --case identity.health
//   node matrix.mjs --out matrix-results.json --record-fixture
//
// Group list: identity, catalog, query, editor, refusals, writes.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	Checker,
	createClient,
	loadDescriptor,
	parseArgv,
	readPath,
	writeArtifact,
} from "./lib/uev-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgv();
const descriptor = loadDescriptor(args);
const client = createClient(descriptor);

const onlyGroups = collectList("only");
const onlyCases = collectList("case");
const includeWrites = args.flag("include-writes");
const recordFixture = args.flag("record-fixture");
const outPath = args.get("out", "");

function collectList(name) {
	const single = args.get(name);
	if (!single) {
		return [];
	}
	return String(single)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

// The fixture material carries one static switch named UEVSwitch, so the switch
// cases work on any freshly restarted project without extra manual authoring.
const PY_FIXTURE_SETUP = [
	"import unreal",
	"pkg = '/Game/UEVTests'",
	"if not unreal.EditorAssetLibrary.does_directory_exist(pkg):",
	"    unreal.EditorAssetLibrary.make_directory(pkg)",
	"path = pkg + '/M_UEV_SwitchFixture'",
	"lib = unreal.MaterialEditingLibrary",
	"if unreal.EditorAssetLibrary.does_asset_exist(path):",
	"    mat = unreal.EditorAssetLibrary.load_asset(path)",
	"else:",
	"    mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset('M_UEV_SwitchFixture', pkg, unreal.Material, unreal.MaterialFactoryNew())",
	"names = [str(n) for n in lib.get_static_switch_parameter_names(mat)]",
	"if 'UEVSwitch' not in names:",
	"    sw = lib.create_material_expression(mat, unreal.MaterialExpressionStaticSwitchParameter, -600, 0)",
	"    sw.set_editor_property('parameter_name', 'UEVSwitch')",
	"    sw.set_editor_property('default_value', False)",
	"    lib.connect_material_property(sw, '', unreal.MaterialProperty.MP_BASE_COLOR)",
	"lib.recompile_material(mat)",
	"unreal.EditorAssetLibrary.save_loaded_asset(mat)",
	"bp = pkg + '/BP_UEVMatrixProbe'",
	"if not unreal.EditorAssetLibrary.does_asset_exist(bp):",
	"    factory = unreal.BlueprintFactory()",
	"    factory.set_editor_property('parent_class', unreal.Actor)",
	"    unreal.AssetToolsHelpers.get_asset_tools().create_asset('BP_UEVMatrixProbe', pkg, unreal.Blueprint, factory)",
	"print('FIXTURE ok')",
	"print('NATIVE ' + str(hasattr(unreal, 'UEVMaterialLibrary')))",
].join("\n");

const CASES = [];

function addCase(entry) {
	CASES.push(entry);
}

// ------------------------------------------------------------------ identity
addCase({
	id: "identity.health",
	group: "identity",
	kind: "health",
	expect: {
		equals: {
			ok: true,
			productName: "UEV",
			productSlug: "uev",
			protocolVersion: 2,
			"engine.strictEnvVar": "UEV_STRICT_ENGINE",
		},
		matches: {
			productVersion: "^\\d+\\.\\d+\\.\\d+$",
			serverVersion: "^\\d{4}\\.\\d+\\.\\d+-\\d+$",
		},
	},
});

addCase({
	id: "identity.descriptor",
	group: "identity",
	kind: "descriptor",
	expect: {
		equals: { productName: "UEV", host: "127.0.0.1" },
		nonEmpty: ["token"],
		matches: { port: "^\\d+$", pid: "^\\d+$" },
	},
});

addCase({
	id: "identity.catalog-header",
	group: "identity",
	kind: "catalog",
	expect: {
		equals: { ok: true, productVersion: "1.7.0", productSlug: "uev", protocolVersion: 2 },
		assert: (catalog) => {
			const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
			if (tools.length !== 45) {
				return "expected 45 tools, found " + tools.length;
			}
			const actions = tools.reduce((total, tool) => total + (tool.actions?.length ?? 0), 0);
			if (actions < 340) {
				return "expected at least 340 actions, found " + actions;
			}
			return null;
		},
	},
});

addCase({
	id: "identity.catalog-action-shape",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const problems = [];
			const modes = new Set();
			let actions = 0;
			let withTimeout = 0;
			for (const tool of catalog.tools ?? []) {
				const seen = new Set();
				for (const action of tool.actions ?? []) {
					actions += 1;
					if (!action.name) {
						problems.push(tool.name + ": action without a name");
						continue;
					}
					if (seen.has(action.name)) {
						problems.push(tool.name + "." + action.name + ": duplicate action");
					}
					seen.add(action.name);
					modes.add(action.mode);
					if (!Array.isArray(action.params)) {
						problems.push(tool.name + "." + action.name + ": missing params array");
					}
					if (action.timeoutMs !== undefined) {
						withTimeout += 1;
						if (!(action.timeoutMs > 0)) {
							problems.push(tool.name + "." + action.name + ": non-positive timeoutMs");
						}
					}
					if (action.allowed !== true && action.allowed !== false) {
						problems.push(tool.name + "." + action.name + ": allowed is not a boolean");
					}
					for (const param of action.params ?? []) {
						if (!param.name || !param.type) {
							problems.push(tool.name + "." + action.name + ": parameter without name/type");
						}
					}
				}
			}
			for (const mode of ["read", "write", "supervised"]) {
				if (!modes.has(mode)) {
					problems.push("missing action mode: " + mode);
				}
			}
			if (problems.length) {
				return problems.slice(0, 8).join("; ");
			}
			return null;
		},
	},
});

addCase({
	id: "identity.catalog-handle-grammar",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_object");
			const action = findAction(tool, "describe");
			const param = (action?.params ?? []).find((entry) => entry.name === "handle");
			if (!param) {
				return "manage_object.describe has no handle parameter";
			}
			const description = String(param.description ?? "");
			if (!description.includes("uev:")) {
				return "handle parameter does not document the uev: grammar";
			}
			return null;
		},
	},
});

addCase({
	id: "identity.catalog-static-switches",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_material");
			const action = findAction(tool, "set_material_instance_parameters");
			const param = (action?.params ?? []).find((entry) => entry.name === "static_switches");
			if (!param) {
				return "set_material_instance_parameters has no static_switches parameter";
			}
			if (String(param.description ?? "").length < 20) {
				return "static_switches parameter is undocumented";
			}
			return null;
		},
	},
});

addCase({
	id: "identity.catalog-widget-aliases",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_widget");
			const action = findAction(tool, "bind_event");
			const names = new Set((action?.params ?? []).map((entry) => entry.name));
			const missing = ["widget_member_name", "widget_name"].filter((name) => !names.has(name));
			if (missing.length) {
				return "bind_event is missing " + missing.join(", ");
			}
			return null;
		},
	},
});

addCase({
	id: "identity.catalog-widget-designer-surface",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_widget");
			if (!tool) {
				return "manage_widget is missing from the catalog";
			}
			const expected = {
				insert_widget: "write",
				reorder_child: "write",
				duplicate_widget: "write",
				rename_widget: "write",
				remove_widget: "supervised",
				reparent_widget: "supervised",
				serialize_tree: "read",
				validate_widget: "read",
				set_style: "write",
				set_brush: "write",
				list_delegates: "read",
				list_bound_events: "read",
				unbind_event: "write",
				designer_screenshot: "read",
				inspect_selection: "read",
			};
			const problems = [];
			for (const [name, mode] of Object.entries(expected)) {
				const action = findAction(tool, name);
				if (!action) {
					problems.push(name + " is not registered");
					continue;
				}
				if (action.mode !== mode) {
					problems.push(name + " is " + action.mode + ", expected " + mode);
				}
			}
			const insert = findAction(tool, "insert_widget");
			const insertParams = new Set((insert?.params ?? []).map((entry) => entry.name));
			for (const name of ["widget_class", "parent_widget_name"]) {
				if (!insertParams.has(name)) {
					problems.push("insert_widget is missing " + name);
				}
			}
			const reparent = findAction(tool, "reparent_widget");
			const reparentParams = new Map((reparent?.params ?? []).map((entry) => [entry.name, entry]));
			if (reparentParams.get("new_parent_widget_name")?.required !== true) {
				problems.push("reparent_widget.new_parent_widget_name is not required");
			}
			const remove = findAction(tool, "remove_widget");
			const removeParams = new Set((remove?.params ?? []).map((entry) => entry.name));
			if (!removeParams.has("widget_name") || !removeParams.has("asset_path")) {
				problems.push("remove_widget is missing widget_name/asset_path");
			}
			const screenshot = findAction(tool, "designer_screenshot");
			const screenshotParams = new Set((screenshot?.params ?? []).map((entry) => entry.name));
			if (!screenshotParams.has("output_path")) {
				problems.push("designer_screenshot is missing output_path");
			}
			return problems.length ? problems.join("; ") : null;
		},
	},
});

addCase({
	id: "identity.catalog-behavior-tree-surface",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_ai");
			if (!tool) {
				return "manage_ai is missing from the catalog";
			}
			const expected = {
				bt_create: "write",
				bt_inspect: "read",
				bt_add_node: "write",
				bt_remove_node: "write",
				bt_move_node: "write",
				bt_set_node_property: "write",
				bt_add_decorator: "write",
				bt_remove_decorator: "write",
				bt_add_service: "write",
				bt_remove_service: "write",
				bt_set_blackboard: "write",
				bt_compile: "write",
				bt_repair_graph: "write",
			};
			const problems = [];
			const registered = (tool.actions ?? []).map((action) => action.name).filter((name) => name.startsWith("bt_"));
			if (registered.length !== 13) {
				problems.push("expected 13 bt_* actions, found " + registered.length + ": " + registered.join(", "));
			}
			for (const [name, mode] of Object.entries(expected)) {
				const action = findAction(tool, name);
				if (!action) {
					problems.push(name + " is not registered");
					continue;
				}
				if (action.mode !== mode) {
					problems.push(name + " is " + action.mode + ", expected " + mode);
				}
			}
			const required = {
				bt_inspect: ["behavior_tree_path"],
				bt_add_node: ["behavior_tree_path", "kind", "node_class"],
				bt_add_decorator: ["behavior_tree_path", "node_id", "decorator_class"],
				bt_add_service: ["behavior_tree_path", "node_id", "service_class"],
				bt_set_node_property: ["behavior_tree_path", "node_id", "property", "value"],
				bt_move_node: ["behavior_tree_path", "node_id", "new_parent_id"],
			};
			for (const [name, names] of Object.entries(required)) {
				const params = new Set((findAction(tool, name)?.params ?? []).map((entry) => entry.name));
				for (const param of names) {
					if (!params.has(param)) {
						problems.push(name + " is missing " + param);
					}
				}
			}
			const create = new Set((findAction(tool, "bt_create")?.params ?? []).map((entry) => entry.name));
			for (const param of ["name", "asset_name", "path", "blackboard_path", "root_class"]) {
				if (!create.has(param)) {
					problems.push("bt_create is missing " + param);
				}
			}
			return problems.length ? problems.join("; ") : null;
		},
	},
});

addCase({
	id: "identity.catalog-blueprint-depth-surface",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const tool = findTool(catalog, "manage_blueprint");
			if (!tool) {
				return "manage_blueprint is missing from the catalog";
			}
			const expected = {
				create_function: "write",
				delete_function: "write",
				rename_function: "write",
				set_function_signature: "write",
				create_macro: "write",
				create_macro_library: "write",
				delete_macro: "write",
				rename_macro: "write",
				set_macro_signature: "write",
				list_macros: "read",
				inspect_macro: "read",
				add_local_variable: "write",
				update_local_variable: "write",
				remove_local_variable: "write",
				reset_construction_script: "write",
				inspect_construction_script: "read",
				inspect_blueprint_model: "read",
				verify_blueprint: "write",
				inspect_function: "read",
			};
			const problems = [];
			for (const [name, mode] of Object.entries(expected)) {
				const action = findAction(tool, name);
				if (!action) {
					problems.push(name + " is not registered");
					continue;
				}
				if (action.mode !== mode) {
					problems.push(name + " is " + action.mode + ", expected " + mode);
				}
			}
			if ((tool.actions ?? []).length !== 38) {
				problems.push("expected 38 manage_blueprint actions, found " + (tool.actions ?? []).length);
			}
			const required = {
				create_function: ["name", "inputs", "outputs", "compile"],
				set_function_signature: ["graph_name", "add_inputs", "remove_pins", "rename_pins"],
				add_local_variable: ["graph_name", "variable_name", "pin_type"],
				verify_blueprint: ["expected", "compile"],
				create_macro: ["macro_name", "inputs", "outputs"],
			};
			for (const [name, names] of Object.entries(required)) {
				const params = new Set((findAction(tool, name)?.params ?? []).map((entry) => entry.name));
				for (const param of names) {
					if (!params.has(param)) {
						problems.push(name + " is missing " + param);
					}
				}
			}
			return problems.length ? problems.join("; ") : null;
		},
	},
});

addCase({
	id: "identity.catalog-nested-schema",
	group: "identity",
	kind: "catalog",
	expect: {
		assert: (catalog) => {
			const editor = findTool(catalog, "manage_editor");
			const pieExpect = findAction(editor, "pie_expect");
			const conditions = (pieExpect?.params ?? []).find((entry) => entry.name === "conditions");
			if (!conditions) {
				return "pie_expect has no conditions parameter";
			}
			if (conditions.type !== "array" || conditions.items?.type !== "object") {
				return "pie_expect.conditions is not an array of objects (" + conditions.type + "/" + conditions.items?.type + ")";
			}
			const properties = conditions.items.properties ?? {};
			if (!properties.actor_name || !properties.kind) {
				return "pie_expect.conditions items lost their discriminated-union fields";
			}
			const material = findTool(catalog, "manage_material");
			const params = findAction(material, "set_material_instance_parameters");
			const scalars = (params?.params ?? []).find((entry) => entry.name === "scalars");
			if (!scalars?.additionalProperties) {
				return "scalars is not described as a typed record";
			}
			return null;
		},
	},
});

// --------------------------------------------------------------------- query
addCase({
	id: "query.directional-light",
	group: "query",
	tool: "manage_query",
	action: "query",
	params: { class: "DirectionalLight", limit: 3 },
	save: "directionalLight",
	expect: {
		equals: { success: true },
		matches: {
			"objects.0.handle": "^uev:(actor|asset|object):",
			"objects.0.native_handle": "^obj_\\d+$",
		},
		nonEmpty: ["objects"],
	},
});

addCase({
	id: "query.handle-roundtrip",
	group: "query",
	tool: "manage_object",
	action: "describe",
	params: { handle: "{{directionalLight.objects.0.handle}}" },
	expect: {
		equals: { success: true },
		assert: (payload, ctx) => {
			const expected = readPath(ctx.vars.directionalLight, "objects.0.path");
			const actual = payload.path ?? payload.object?.path;
			if (expected && actual && expected !== actual) {
				return "describe returned " + actual + ", expected " + expected;
			}
			return null;
		},
	},
});

// -------------------------------------------------------------------- editor
addCase({
	id: "editor.is-pie-running",
	group: "editor",
	tool: "manage_editor",
	action: "is_pie_running",
	params: {},
	expect: {
		equals: { success: true },
		assert: (payload) => (typeof payload.is_pie_running === "boolean" ? null : "is_pie_running is not a boolean"),
	},
});

addCase({
	id: "editor.project-info",
	group: "editor",
	tool: "manage_editor",
	action: "project_info",
	params: {},
	expect: {
		equals: { success: true },
		nonEmpty: ["project_name"],
		assert: (payload) => (payload.total_assets > 0 ? null : "total_assets is not positive"),
	},
});

addCase({
	id: "editor.map-info",
	group: "editor",
	tool: "manage_editor",
	action: "map_info",
	params: {},
	expect: {
		nonEmpty: ["map_name", "map_path"],
		assert: (payload) => (payload.total_actors > 0 ? null : "total_actors is not positive"),
	},
});

addCase({
	id: "editor.list-open-assets",
	group: "editor",
	tool: "manage_editor",
	action: "list_open_assets",
	params: {},
	expect: { equals: { success: true } },
});

addCase({
	id: "editor.run-python-identity",
	group: "editor",
	tool: "manage_editor",
	action: "run_python",
	params: { code: "print('UEV_MATRIX_OK')" },
	expect: {
		// run_python returns the raw stdout string, not the usual { success } envelope.
		// An object here means the call was refused or throttled, so print the body.
		assert: (payload) => {
			const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
			return text.includes("UEV_MATRIX_OK") ? null : "stdout is " + text.slice(0, 200);
		},
	},
});

addCase({
	id: "tools.list-namespaces",
	group: "editor",
	tool: "manage_tools",
	action: "list_namespaces",
	params: {},
	expect: {
		equals: { success: true },
		assert: (payload) => {
			const namespaces = payload.namespaces ?? [];
			// Manage_tools reports every MCP tool namespace the server registers: 38.
			// The control-API catalog lists 45 tools = those 38 namespaces + 7 direct
			// tools (editor_capture_window, manage_batch, ...). The 1.5.x compatibility
			// aliases and the redundant get_unreal_version tool are gone in 1.7.0, so
			// namespace and catalog counts agree.
			if (namespaces.length !== 38) {
				return "expected 38 namespaces, found " + namespaces.length;
			}
			const duplicates = namespaces
				.map((entry) => entry.tool_namespace)
				.filter((name, index, all) => all.indexOf(name) !== index);
			if (duplicates.length) {
				return "duplicate namespaces: " + [...new Set(duplicates)].join(", ");
			}
			const direct = ["editor_capture_window", "editor_create_object", "editor_delete_object", "editor_update_object", "get_unreal_engine_path", "get_unreal_project_path", "manage_batch"];
			const leaked = namespaces.map((entry) => entry.tool_namespace).filter((name) => direct.includes(name));
			if (leaked.length) {
				return "direct tools listed as namespaces: " + leaked.join(", ");
			}
			const empty = namespaces.filter((entry) => !(entry.supported_actions ?? []).length).map((entry) => entry.tool_namespace);
			return empty.length ? "namespaces without actions: " + empty.join(", ") : null;
		},
	},
});

addCase({
	id: "material.inspect-fixture",
	group: "editor",
	tool: "manage_material",
	action: "inspect_material_instance",
	params: { asset_path: "/Game/UEVTests/MI_UEV_SwitchFixture" },
	expect: {
		equals: { success: true },
		assert: (payload) => {
			const effective = payload.static_switch_parameters;
			const overrides = payload.static_switch_overrides;
			if (!effective || typeof effective.UEVSwitch !== "boolean") {
				return "static_switch_parameters.UEVSwitch is missing";
			}
			if (!overrides || typeof overrides.UEVSwitch !== "boolean") {
				return "static_switch_overrides.UEVSwitch is missing";
			}
			return null;
		},
	},
});

// ------------------------------------------------------------------ refusals
addCase({
	id: "refusals.unrecognized-key",
	group: "refusals",
	tool: "manage_actor",
	action: "spawn",
	params: { bogus_key: 1 },
	expect: {
		equals: { success: false },
		includes: { message: "Invalid params for manage_actor.spawn" },
	},
});

addCase({
	id: "refusals.unknown-action",
	group: "refusals",
	tool: "manage_editor",
	action: "nope_action",
	params: {},
	expect: {
		equals: { success: false },
		includes: { message: "is not supported by manage_editor" },
		nonEmpty: ["supported_actions"],
	},
});

addCase({
	id: "refusals.missing-required-param",
	group: "refusals",
	tool: "manage_editor",
	action: "run_python",
	params: {},
	expect: {
		equals: { success: false },
		includes: { message: "Invalid params for manage_editor.run_python" },
	},
});

addCase({
	id: "refusals.unsupported-widget-property",
	group: "refusals",
	tool: "manage_widget",
	action: "set_widget_property",
	params: {
		widget_blueprint: "/Game/UEVTests/WBP_UEVApiWidget",
		widget_member_name: "UEVButton",
		property: "not_a_property",
		value: true,
	},
	expect: {
		equals: { success: false, reason: "unsupported_property" },
		nonEmpty: ["supported_properties"],
	},
});

addCase({
	id: "refusals.graph-not-found",
	group: "refusals",
	tool: "manage_blueprint",
	action: "connect_nodes",
	params: {
		blueprint_name: "/Game/UEVTests/BP_UEVMatrixProbe",
		graph_name: "NoSuchGraph_UEV",
		source_node_id: "x",
		source_pin: "y",
		target_node_id: "z",
		target_pin: "w",
	},
	expect: {
		equals: { success: false },
		includes: { message: "Graph not found: NoSuchGraph_UEV" },
	},
});

addCase({
	id: "refusals.stale-handle",
	group: "refusals",
	tool: "manage_object",
	action: "describe",
	params: { handle: "uev:actor:/Game/UEVTests/DoesNotExist.DoesNotExist:PersistentLevel.Nope" },
	expect: {
		equals: { success: false },
		includes: { message: "no longer resolves" },
	},
});

addCase({
	id: "refusals.bt-create-outside-game",
	group: "refusals",
	tool: "manage_ai",
	action: "bt_create",
	params: { name: "UEV_RefusalTree", path: "/Script/UEVRefusal" },
	expect: {
		equals: { success: false },
		includes: { message: "must live under /Game/" },
	},
});

addCase({
	id: "refusals.bt-missing-asset",
	group: "refusals",
	tool: "manage_ai",
	action: "bt_inspect",
	params: { behavior_tree_path: "/Game/UEVTests/BT_UEV_DoesNotExist" },
	expect: {
		equals: { success: false },
		includes: { message: "Asset not found" },
	},
});

addCase({
	id: "refusals.blueprint-construction-signature",
	group: "refusals",
	fixtures: true,
	tool: "manage_blueprint",
	action: "set_function_signature",
	params: {
		blueprint_name: "/Game/UEVTests/BP_UEVMatrixProbe",
		graph_name: "UserConstructionScript",
		add_inputs: [{ name: "InUEVProbe", type: "float" }],
	},
	expect: {
		equals: { success: false, "error.code": "construction_script_read_only" },
		includes: { message: "Construction Script" },
	},
});

addCase({
	id: "refusals.blueprint-invalid-params",
	group: "refusals",
	fixtures: true,
	tool: "manage_blueprint",
	action: "delete_node",
	params: {
		blueprint_name: "/Game/UEVTests/BP_UEVMatrixProbe",
		graph_name: "UserConstructionScript",
		node_id: "x",
		compile: true,
	},
	expect: {
		equals: { success: false },
		includes: { message: "Invalid params for manage_blueprint.delete_node" },
	},
});

addCase({
	id: "refusals.clean-break-removed-surfaces",
	group: "refusals",
	run: async (context) => {
		const probes = [
			["manage_behavior_tree", "inspect_behavior_tree"],
			["manage_level_structure", "status"],
			["manage_environment", "status"],
			["manage_animation_physics", "status"],
			["manage_ai_debug", "status"],
		];
		const problems = [];
		for (const [tool, action] of probes) {
			const result = await context.client.call(tool, action, {}, { timeoutMs: 30000 });
			const text = String(result.text ?? "");
			if (result.status !== 404) {
				problems.push(tool + " returned HTTP " + result.status + ", expected 404");
			} else if (!text.includes("Unknown tool")) {
				problems.push(tool + " returned " + firstLine(text));
			}
		}
		// manage_vite itself survives 1.7; only screenshot moved to manage_editor.screenshot.
		const vite = await context.client.call("manage_vite", "screenshot", {}, { timeoutMs: 30000 });
		const viteText = String(vite.text ?? "");
		if (vite.payload?.success !== false || !viteText.includes("is not supported by manage_vite")) {
			problems.push("manage_vite.screenshot was not folded away: " + firstLine(viteText));
		}
		return problems.length
			? { ok: false, detail: problems.join("; ") }
			: { ok: true, detail: "5 removed namespaces answer HTTP 404 Unknown tool; manage_vite.screenshot is gone" };
	},
});

// -------------------------------------------------------------------- writes
addCase({
	id: "writes.actor-roundtrip",
	group: "writes",
	write: true,
	run: async (context) => {
		const name = "UEV_MatrixProbe";
		await context.client.call("manage_actor", "delete", { name });
		const spawned = await context.client.call("manage_actor", "spawn", {
			actor_type: "/Script/Engine.PointLight",
			name,
		});
		if (!spawned.succeeded) {
			return { ok: false, detail: "spawn failed: " + firstLine(spawned.text) };
		}
		const queried = await context.client.call("manage_query", "query", { label: name, limit: 5 });
		const handle = (queried.payload?.objects ?? []).find((entry) => (entry.label ?? "") === name)?.handle ?? queried.payload?.objects?.[0]?.handle;
		if (!handle) {
			return { ok: false, detail: "spawned actor is not queryable" };
		}
		const described = await context.client.call("manage_object", "describe", { handle });
		if (!described.succeeded) {
			return { ok: false, detail: "describe failed: " + firstLine(described.text) };
		}
		const deleted = await context.client.call("manage_actor", "delete", { name });
		if (!deleted.succeeded) {
			return { ok: false, detail: "delete failed: " + firstLine(deleted.text) };
		}
		return { ok: true, detail: "spawn -> query -> describe -> delete via " + handle.slice(0, 60) };
	},
});

addCase({
	id: "writes.blueprint-node-roundtrip",
	group: "writes",
	write: true,
	run: async (context) => {
		const added = await context.client.call("manage_blueprint", "add_node", {
			blueprint_name: "/Game/UEVTests/BP_UEVMatrixProbe",
			graph_name: "UserConstructionScript",
			node_type: "comment",
			comment: "UEV matrix probe comment",
		});
		if (!added.succeeded) {
			return { ok: false, detail: "add_node failed: " + firstLine(added.text) };
		}
		const nodeId = added.payload?.node_id ?? added.payload?.node?.node_id ?? added.payload?.node?.id;
		if (!nodeId) {
			return { ok: false, detail: "add_node returned no node id" };
		}
		const removed = await context.client.call("manage_blueprint", "delete_node", {
			blueprint_name: "/Game/UEVTests/BP_UEVMatrixProbe",
			graph_name: "UserConstructionScript",
			node_id: nodeId,
		});
		if (!removed.succeeded) {
			return { ok: false, detail: "delete_node failed: " + firstLine(removed.text) };
		}
		return { ok: true, detail: "comment node added and deleted in UserConstructionScript" };
	},
});

addCase({
	id: "writes.static-switch-roundtrip",
	group: "writes",
	write: true,
	run: async (context) => {
		for (const value of [true, false]) {
			const set = await context.client.call("manage_material", "set_material_instance_parameter", {
				asset_path: "/Game/UEVTests/MI_UEV_SwitchFixture",
				parameter_name: "UEVSwitch",
				parameter_type: "static_switch",
				value,
			});
			if (!set.succeeded) {
				return { ok: false, detail: "set " + value + " failed: " + firstLine(set.text) };
			}
			const inspected = await context.client.call("manage_material", "inspect_material_instance", {
				asset_path: "/Game/UEVTests/MI_UEV_SwitchFixture",
			});
			const effective = inspected.payload?.static_switch_parameters?.UEVSwitch;
			const overridden = inspected.payload?.static_switch_overrides?.UEVSwitch;
			if (effective !== value) {
				return { ok: false, detail: "read-back is " + effective + ", expected " + value };
			}
			if (overridden !== true) {
				return { ok: false, detail: "override flag is " + overridden + ", expected true" };
			}
		}
		return { ok: true, detail: "true/false written and read back with override flags" };
	},
});

addCase({
	id: "writes.widget-alias-conflict",
	group: "writes",
	write: true,
	run: async (context) => {
		const conflicted = await context.client.call("manage_widget", "bind_event", {
			widget_blueprint: "/Game/UEVTests/WBP_UEVApiWidget",
			widget_member_name: "UEVButton",
			widget_name: "OtherButton",
			event_name: "OnClicked",
		});
		if (conflicted.payload?.success !== false) {
			return { ok: false, detail: "conflicting aliases were accepted" };
		}
		if (!String(conflicted.payload?.message ?? "").includes("conflicts with widget_name")) {
			return { ok: false, detail: "unexpected conflict message: " + firstLine(conflicted.text) };
		}
		return { ok: true, detail: "conflicting widget aliases refused with the documented message" };
	},
});

addCase({
	id: "writes.widget-designer-round-trip",
	group: "writes",
	write: true,
	run: async (context) => {
		const asset = "/Game/UEVTests/WBP_UEVDesignerMatrix";
		const call = (action, params) => context.client.call("manage_widget", action, { asset_path: asset, ...params });
		const fail = (detail) => ({ ok: false, detail });
		const exists = await context.client.call("manage_asset", "exists", { asset_path: asset });
		if (exists.payload?.exists === true) {
			await context.client.call("manage_asset", "delete", { asset_path: asset });
		}
		const created = await call("create_widget_blueprint", { widget_name: asset });
		if (created.payload?.success === false) {
			return fail("create failed: " + firstLine(created.text));
		}
		await call("ensure_canvas_root", {});
		const box = await call("insert_widget", { widget_class: "VerticalBox", widget_name: "RootBox", parent_widget_name: "CanvasPanel_0" });
		if (box.payload?.success === false) {
			return fail("insert panel failed: " + firstLine(box.text));
		}
		for (const [name, cls] of [["Label", "TextBlock"], ["Cta", "Button"], ["Icon", "Image"]]) {
			const inserted = await call("insert_widget", { widget_class: cls, widget_name: name, parent_widget_name: "RootBox" });
			if (inserted.payload?.success === false) {
				return fail("insert " + name + " failed: " + firstLine(inserted.text));
			}
			if (!String(inserted.payload?.widget?.id ?? "").includes("#/CanvasPanel_0/RootBox/" + name)) {
				return fail("insert " + name + " returned no stable id: " + JSON.stringify(inserted.payload?.widget?.id));
			}
		}
		const reordered = await call("reorder_child", { widget_name: "Label", index: 2 });
		if (reordered.payload?.success === false) {
			return fail("reorder failed: " + firstLine(reordered.text));
		}
		const duplicated = await call("duplicate_widget", { widget_name: "RootBox", new_name: "RootBoxCopy", deep: true });
		if ((duplicated.payload?.duplicated_count ?? 0) < 4) {
			return fail("deep duplicate copied " + duplicated.payload?.duplicated_count + " widgets");
		}
		const bound = await call("bind_event", { widget_name: "Cta", event_name: "OnClicked", function_name: "OnCtaClicked" });
		if (bound.payload?.success === false) {
			return fail("bind_event failed: " + firstLine(bound.text));
		}
		const renamed = await call("rename_widget", { widget_name: "Cta", new_name: "CtaMain" });
		if (renamed.payload?.retargeted_bindings !== 1) {
			return fail("rename retargeted " + renamed.payload?.retargeted_bindings + " bindings, expected 1");
		}
		const boundAfter = await call("list_bound_events", {});
		const rows = boundAfter.payload?.bindings ?? [];
		if (rows.length !== 1 || rows[0]?.object_name !== "CtaMain" || rows[0]?.valid !== true) {
			return fail("binding table after rename: " + JSON.stringify(rows));
		}
		const style = await call("set_style", { widget_name: "Label", style: { font: { size: 26 }, color: { r: 0.9, g: 0.8, b: 0.1, a: 1 } } });
		const styleApplied = style.payload?.applied ?? [];
		if (!styleApplied.includes("font.size") || !styleApplied.includes("color")) {
			return fail("set_style applied " + JSON.stringify(styleApplied));
		}
		if (!String(style.payload?.read_back?.font ?? "").includes("Size=26")) {
			return fail("font read-back is " + JSON.stringify(style.payload?.read_back?.font));
		}
		const brush = await call("set_brush", { widget_name: "Icon", texture_path: "/Engine/EngineResources/DefaultTexture", tint: { r: 0.2, g: 0.4, b: 0.9, a: 1 } });
		if (!String(brush.payload?.read_back?.brush ?? "").includes("DefaultTexture")) {
			return fail("brush read-back is " + JSON.stringify(brush.payload?.read_back?.brush));
		}
		const removed = await call("remove_widget", { widget_name: "CtaMain" });
		if (removed.payload?.purged_bindings !== 1) {
			return fail("remove purged " + removed.payload?.purged_bindings + " bindings, expected 1");
		}
		const validate = await call("validate_widget", {});
		const problems = validate.payload ?? {};
		if (problems.valid !== true || (problems.issue_count ?? -1) !== 0) {
			return fail("validate: " + JSON.stringify({ valid: problems.valid, issue_count: problems.issue_count, dup: problems.duplicate_names, orphan: problems.orphan_bindings }));
		}
		if ((problems.duplicate_names ?? []).length > 0) {
			return fail("duplicate names survived: " + JSON.stringify(problems.duplicate_names));
		}
		const shot = await call("designer_screenshot", { width: 640, height: 360 });
		if (!String(shot.payload?.png_path ?? "").toLowerCase().endsWith(".png") || (shot.payload?.width ?? 0) !== 640) {
			return fail("screenshot: " + JSON.stringify({ png: shot.payload?.png_path, width: shot.payload?.width }));
		}
		const tree = await call("serialize_tree", {});
		const widgets = tree.payload?.widgets ?? [];
		const byName = new Map(widgets.map((entry) => [entry.name, entry]));
		const label = byName.get("Label");
		if (label?.parent !== "RootBox" || (label?.index ?? -1) < 0) {
			return fail("Label read-back: " + JSON.stringify(label));
		}
		if (label.index !== 1) {
			return fail("Label ended at index " + label.index + ", expected 1 after reorder and removal");
		}
		const rootBoxChildren = widgets.filter((entry) => entry.parent === "RootBox").map((entry) => entry.name);
		if (byName.has("CtaMain") || rootBoxChildren.includes("CtaMain")) {
			return fail("removed widget still in the tree: " + JSON.stringify(rootBoxChildren));
		}
		if (!rootBoxChildren.includes("Icon")) {
			return fail("RootBox lost its remaining children: " + JSON.stringify(rootBoxChildren));
		}
		if (!(byName.get("RootBoxCopy")?.parent === "CanvasPanel_0")) {
			return fail("duplicate panel is not under the canvas");
		}
		return { ok: true, detail: "insert/reorder/duplicate/rename/bind/style/brush/remove/validate/screenshot round trip on " + asset };
	},
});

addCase({
	id: "writes.bt-graph-roundtrip",
	group: "writes",
	write: true,
	run: async (context) => {
		const asset = "/Game/UEVTests/BT_UEVMatrixTree";
		const call = (action, params) => context.client.call("manage_ai", action, params);
		const fail = (detail) => ({ ok: false, detail });
		const exists = await context.client.call("manage_asset", "exists", { asset_path: asset });
		if (exists.payload?.exists === true) {
			const removed = await context.client.call("manage_asset", "delete", { asset_path: asset });
			if (removed.payload?.success === false) {
				return fail("stale matrix tree could not be removed: " + firstLine(removed.text));
			}
		}
		const blackboardAsset = "/Game/UEVTests/BB_UEVMatrixProbe";
		const swapBlackboardAsset = "/Game/UEVTests/BB_UEVMatrixSwap";
		for (const stale of [blackboardAsset, swapBlackboardAsset]) {
			const staleExists = await context.client.call("manage_asset", "exists", { asset_path: stale });
			if (staleExists.payload?.exists === true) {
				await context.client.call("manage_asset", "delete", { asset_path: stale });
			}
		}
		const blackboard = await call("create_blackboard", { name: "BB_UEVMatrixProbe", path: "/Game/UEVTests" });
		if (blackboard.payload?.success !== true) {
			return fail("create_blackboard failed: " + firstLine(blackboard.text));
		}
		const blackboardPath = String(blackboard.payload?.blackboard?.path ?? "");
		if (!blackboardPath.includes("BB_UEVMatrixProbe")) {
			return fail("create_blackboard returned no usable path: " + JSON.stringify(blackboard.payload));
		}
		const key = await call("add_blackboard_key", {
			blackboard_path: blackboardPath,
			key_name: "MatrixTarget",
			key_type: "Object",
		});
		if (key.payload?.success !== true || key.payload?.key?.name !== "MatrixTarget") {
			return fail("add_blackboard_key failed: " + firstLine(key.text));
		}
		const keyList = await call("list_blackboard_keys", { blackboard_path: blackboardPath });
		if (!(keyList.payload?.blackboard?.keys ?? []).some((entry) => entry.name === "MatrixTarget")) {
			return fail("list_blackboard_keys did not report MatrixTarget: " + JSON.stringify(keyList.payload?.blackboard?.keys));
		}
		const created = await call("bt_create", {
			name: "BT_UEVMatrixTree",
			path: "/Game/UEVTests",
			blackboard_path: blackboardPath,
			root_class: "/Script/AIModule.BTComposite_Sequence",
		});
		if (created.payload?.success !== true) {
			return fail("bt_create failed: " + firstLine(created.text));
		}
		const tree = String(created.payload?.behavior_tree_path ?? "");
		if (!tree) {
			return fail("bt_create returned no behavior_tree_path");
		}
		if (!String(created.payload?.blackboard_path ?? blackboardPath).includes("BB_UEVMatrixProbe")) {
			return fail("bt_create did not attach the matrix blackboard: " + JSON.stringify(created.payload?.blackboard_path));
		}
		const rootId = created.payload?.root_id;
		if (rootId !== "ei:0") {
			return fail("bt_create did not return root ei:0 (got " + JSON.stringify(rootId) + ")");
		}
		const addNode = (params) => call("bt_add_node", { behavior_tree_path: tree, ...params });
		const seqA = await addNode({ parent_id: rootId, kind: "composite", node_class: "/Script/AIModule.BTComposite_Sequence" });
		if (seqA.payload?.success !== true || !seqA.payload?.node_id) {
			return fail("add sequence A failed: " + firstLine(seqA.text));
		}
		const service = await call("bt_add_service", {
			behavior_tree_path: tree,
			node_id: seqA.payload.node_id,
			service_class: "/Script/AIModule.BTService_DefaultFocus",
		});
		if (service.payload?.success !== true || !service.payload?.service_id) {
			return fail("add service failed: " + firstLine(service.text));
		}
		const dropService = await call("bt_remove_service", {
			behavior_tree_path: tree,
			node_id: service.payload.service_id,
		});
		if (dropService.payload?.success !== true) {
			return fail("remove service failed: " + firstLine(dropService.text));
		}
		const wait = await addNode({
			parent_id: seqA.payload.node_id,
			kind: "task",
			node_class: "/Script/AIModule.BTTask_Wait",
		});
		if (wait.payload?.success !== true || !wait.payload?.node_id) {
			return fail("add wait task failed: " + firstLine(wait.text));
		}
		const styled = await call("bt_set_node_property", {
			behavior_tree_path: tree,
			node_id: wait.payload.node_id,
			property: "WaitTime",
			value: 1.5,
		});
		if (styled.payload?.success !== true || styled.payload?.applied !== true) {
			return fail("set WaitTime failed: " + firstLine(styled.text));
		}
		const decorator = await call("bt_add_decorator", {
			behavior_tree_path: tree,
			node_id: wait.payload.node_id,
			decorator_class: "/Script/AIModule.BTDecorator_ForceSuccess",
		});
		if (decorator.payload?.success !== true || !decorator.payload?.decorator_id) {
			return fail("add decorator failed: " + firstLine(decorator.text));
		}
		const dropDecorator = await call("bt_remove_decorator", {
			behavior_tree_path: tree,
			node_id: decorator.payload.decorator_id,
		});
		if (dropDecorator.payload?.success !== true) {
			return fail("remove decorator failed: " + firstLine(dropDecorator.text));
		}
		const seqB = await addNode({ parent_id: rootId, kind: "composite", node_class: "/Script/AIModule.BTComposite_Sequence" });
		if (seqB.payload?.success !== true || !seqB.payload?.node_id) {
			return fail("add sequence B failed: " + firstLine(seqB.text));
		}
		const before = await call("bt_inspect", { behavior_tree_path: tree, include_graph: true });
		const waitNode = (before.payload?.nodes ?? []).find((node) => String(node.class_name ?? "").includes("BTTask_Wait"));
		if (!waitNode?.id) {
			return fail("bt_inspect did not list the wait task: " + firstLine(before.text));
		}
		const moved = await call("bt_move_node", {
			behavior_tree_path: tree,
			node_id: waitNode.id,
			new_parent_id: seqB.payload.node_id,
			new_index: 0,
		});
		if (moved.payload?.success !== true || moved.payload?.moved !== true) {
			return fail("move wait under sequence B failed: " + firstLine(moved.text));
		}
		const refuseRoot = await call("bt_remove_node", { behavior_tree_path: tree, node_id: "root" });
		if (refuseRoot.payload?.success !== false || !String(refuseRoot.payload?.message ?? "").includes("graph root cannot be removed")) {
			return fail("removing the graph root token was not refused as documented: " + firstLine(refuseRoot.text));
		}
		const refuseMove = await call("bt_move_node", { behavior_tree_path: tree, node_id: "root", new_parent_id: seqA.payload.node_id });
		if (refuseMove.payload?.success !== false || !String(refuseMove.payload?.message ?? "").includes("cannot be moved")) {
			return fail("moving the graph root token was not refused as documented: " + firstLine(refuseMove.text));
		}
		const refuseUnknown = await call("bt_remove_node", { behavior_tree_path: tree, node_id: "ei:9999" });
		if (refuseUnknown.payload?.success !== false || !String(refuseUnknown.payload?.message ?? "").includes("Could not resolve node_id")) {
			return fail("unknown node id was not refused as documented: " + firstLine(refuseUnknown.text));
		}
		const compiled = await call("bt_compile", { behavior_tree_path: tree });
		if (compiled.payload?.success !== true) {
			return fail("bt_compile failed: " + firstLine(compiled.text));
		}
		const after = await call("bt_inspect", { behavior_tree_path: tree });
		const nodes = after.payload?.nodes ?? [];
		const movedWait = nodes.find((node) => node.id === waitNode.id) ?? nodes.find((node) => String(node.class_name ?? "").includes("BTTask_Wait"));
		const parent = nodes.find((node) => node.id === movedWait?.parent_id);
		if (!movedWait || !parent || !String(parent.class_name ?? "").includes("BTComposite_Sequence")) {
			return fail("wait task is not parented to a sequence after the move: " + JSON.stringify({ wait: movedWait?.id, parent: movedWait?.parent_id }));
		}
		if ((after.payload?.tree_node_count ?? 0) < 4) {
			return fail("inspect reports " + after.payload?.tree_node_count + " nodes, expected at least 4");
		}
		const swap = await call("create_blackboard", { name: "BB_UEVMatrixSwap", path: "/Game/UEVTests" });
		if (swap.payload?.success !== true) {
			return fail("second create_blackboard failed: " + firstLine(swap.text));
		}
		const swapped = await call("bt_set_blackboard", {
			behavior_tree_path: tree,
			blackboard_path: String(swap.payload?.blackboard?.path ?? ""),
		});
		if (swapped.payload?.success !== true) {
			return fail("bt_set_blackboard failed: " + firstLine(swapped.text));
		}
		const cleanup = await context.client.call("manage_asset", "delete", { asset_path: asset });
		if (cleanup.payload?.success === false) {
			return fail("matrix tree could not be deleted: " + firstLine(cleanup.text));
		}
		for (const blackboardToDelete of [blackboardAsset, swapBlackboardAsset]) {
			await context.client.call("manage_asset", "delete", { asset_path: blackboardToDelete });
		}
		return {
			ok: true,
			detail:
				"blackboard create/key/list + bt_create/attach/add/remove service/property/decorator/move/set_blackboard/compile/inspect round trip with root-move-unknown refusals on " +
				tree,
		};
	},
});

addCase({
	id: "writes.blueprint-depth-roundtrip",
	group: "writes",
	write: true,
	run: async (context) => {
		const blueprint = "/Game/UEVTests/BP_UEVMatrixProbe";
		const library = "/Game/UEVTests/ML_UEVMatrix";
		const call = (action, params) => context.client.call("manage_blueprint", action, params);
		const fail = (detail) => ({ ok: false, detail });
		const pinNames = (pins) => (pins ?? []).map((pin) => pin?.name ?? pin?.pin_name ?? "").filter(Boolean);
		await call("delete_function", { blueprint_name: blueprint, graph_name: "UEV_MatrixFunction", compile: false });
		const exists = await context.client.call("manage_asset", "exists", { asset_path: library });
		if (exists.payload?.exists === true) {
			const removed = await context.client.call("manage_asset", "delete", { asset_path: library });
			if (removed.payload?.success === false) {
				return fail("stale matrix macro library could not be removed: " + firstLine(removed.text));
			}
		}
		const created = await call("create_function", {
			blueprint_name: blueprint,
			name: "UEV_MatrixFunction",
			inputs: [{ name: "InValue", type: "float" }],
			outputs: [{ name: "Result", type: "float" }],
			compile: true,
		});
		if (created.payload?.success !== true) {
			return fail("create_function failed: " + firstLine(created.text));
		}
		const inspected = await call("inspect_function", { blueprint_name: blueprint, graph_name: "UEV_MatrixFunction" });
		if (inspected.payload?.success !== true) {
			return fail("inspect_function failed: " + firstLine(inspected.text));
		}
		if (!pinNames(inspected.payload?.inputs).includes("InValue")) {
			return fail("inspect_function did not report the InValue input: " + JSON.stringify(inspected.payload?.inputs));
		}
		const signed = await call("set_function_signature", {
			blueprint_name: blueprint,
			graph_name: "UEV_MatrixFunction",
			add_inputs: [{ name: "InScale", type: "float", default: "2.0" }],
			compile: true,
		});
		if (signed.payload?.success !== true) {
			return fail("set_function_signature failed: " + firstLine(signed.text));
		}
		const reSigned = await call("inspect_function", { blueprint_name: blueprint, graph_name: "UEV_MatrixFunction" });
		if (!pinNames(reSigned.payload?.inputs).includes("InScale")) {
			return fail("signature did not gain InScale: " + JSON.stringify(reSigned.payload?.inputs));
		}
		const local = await call("add_local_variable", {
			blueprint_name: blueprint,
			graph_name: "UEV_MatrixFunction",
			variable_name: "LocalCount",
			pin_type: "int",
			compile: false,
		});
		if (local.payload?.success !== true) {
			return fail("add_local_variable failed: " + firstLine(local.text));
		}
		const withLocal = await call("inspect_function", { blueprint_name: blueprint, graph_name: "UEV_MatrixFunction" });
		const locals = (withLocal.payload?.local_variables ?? []).map((entry) => entry?.name ?? entry?.variable_name ?? entry);
		if (!locals.includes("LocalCount")) {
			return fail("local variable was not reported: " + JSON.stringify(withLocal.payload?.local_variables));
		}
		const droppedLocal = await call("remove_local_variable", {
			blueprint_name: blueprint,
			graph_name: "UEV_MatrixFunction",
			variable_name: "LocalCount",
			force: true,
			compile: false,
		});
		if (droppedLocal.payload?.success !== true) {
			return fail("remove_local_variable failed: " + firstLine(droppedLocal.text));
		}
		const libraryCreated = await call("create_macro_library", {
			macro_library_name: "ML_UEVMatrix",
			path: "/Game/UEVTests",
			save: true,
		});
		if (libraryCreated.payload?.success !== true) {
			return fail("create_macro_library failed: " + firstLine(libraryCreated.text));
		}
		const libraryPath = String(libraryCreated.payload?.asset_path ?? libraryCreated.payload?.blueprint ?? library);
		const macro = await call("create_macro", {
			macro_library: libraryPath,
			macro_name: "UEV_ScaleBy",
			inputs: [{ name: "InValue", type: "float" }],
			outputs: [{ name: "OutValue", type: "float" }],
			description: "UEV matrix macro",
			compile: true,
		});
		if (macro.payload?.success !== true) {
			return fail("create_macro failed: " + firstLine(macro.text));
		}
		const macroInspect = await call("inspect_macro", { blueprint_name: libraryPath, graph_name: "UEV_ScaleBy" });
		if (macroInspect.payload?.success !== true || !pinNames(macroInspect.payload?.inputs).includes("InValue")) {
			return fail("inspect_macro did not report the macro input: " + firstLine(macroInspect.text));
		}
		const macroSigned = await call("set_macro_signature", {
			blueprint_name: libraryPath,
			graph_name: "UEV_ScaleBy",
			add_inputs: [{ name: "InMax", type: "float", default: "10.0" }],
			compile: true,
		});
		if (macroSigned.payload?.success !== true) {
			return fail("set_macro_signature failed: " + firstLine(macroSigned.text));
		}
		const renamed = await call("rename_macro", { blueprint_name: libraryPath, graph_name: "UEV_ScaleBy", new_name: "UEV_ScaleBy2" });
		if (renamed.payload?.success !== true) {
			return fail("rename_macro failed: " + firstLine(renamed.text));
		}
		const verified = await call("verify_blueprint", {
			blueprint_name: blueprint,
			expected: { functions: [{ name: "UEV_MatrixFunction" }] },
			compile: true,
		});
		if (verified.payload?.success !== true || verified.payload?.match !== true) {
			return fail("verify_blueprint did not match: " + firstLine(verified.text) + " " + JSON.stringify(verified.payload?.differences));
		}
		const deletedMacro = await call("delete_macro", { blueprint_name: libraryPath, graph_name: "UEV_ScaleBy2" });
		if (deletedMacro.payload?.success !== true) {
			return fail("delete_macro failed: " + firstLine(deletedMacro.text));
		}
		const cleanup = await context.client.call("manage_asset", "delete", { asset_path: library });
		if (cleanup.payload?.success === false) {
			return fail("matrix macro library could not be deleted: " + firstLine(cleanup.text));
		}
		return {
			ok: true,
			detail: "create/inspect/sign/local-variable/macro library/create/sign/rename/verify/delete depth round trip on " + blueprint,
		};
	},
});

addCase({
	id: "writes.pie-blueprint-refusal",
	group: "writes",
	write: true,
	run: async (context) => {
		const call = (action, params) => context.client.call("manage_editor", action, params);
		const blueprintCall = (action, params) => context.client.call("manage_blueprint", action, params);
		const fail = (detail) => ({ ok: false, detail });
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const isPie = async () => {
			const state = await call("is_pie_running", {});
			return state.payload?.is_pie_running === true;
		};
		const waitForPie = async (expected, timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if ((await isPie()) === expected) {
					return true;
				}
				await pause(1000);
			}
			return false;
		};
		if (await isPie()) {
			await call("stop_pie", { timeout_seconds: 60 });
			if (!(await waitForPie(false, 60000))) {
				return fail("editor was already in PIE and did not stop within 60s");
			}
		}
		const probeFunction = "UEV_PieSignatureProbe";
		const blueprint = "/Game/UEVTests/BP_UEVMatrixProbe";
		await blueprintCall("delete_function", { blueprint_name: blueprint, graph_name: "UEV_PieBlocked", compile: false });
		await blueprintCall("delete_function", { blueprint_name: blueprint, graph_name: probeFunction, compile: false });
		const prepared = await blueprintCall("create_function", {
			blueprint_name: blueprint,
			name: probeFunction,
			inputs: [],
			outputs: [],
			compile: false,
		});
		if (prepared.payload?.success !== true) {
			return fail("could not prepare the signature probe function: " + firstLine(prepared.text));
		}
		const started = await call("start_pie", { timeout_seconds: 90 });
		if (started.payload?.success === false) {
			return fail("start_pie failed: " + firstLine(started.text));
		}
		if (!(await waitForPie(true, 90000))) {
			await call("stop_pie", { timeout_seconds: 60 });
			return fail("PIE did not report is_pie_running within 90s: " + firstLine(started.text));
		}
		try {
			const created = await blueprintCall("create_function", {
				blueprint_name: blueprint,
				name: "UEV_PieBlocked",
				inputs: [],
				outputs: [],
				compile: true,
			});
			if (created.payload?.success !== false || created.payload?.error?.code !== "unsafe_operation_refused") {
				return fail("create_function was not refused with unsafe_operation_refused during PIE: " + firstLine(created.text));
			}
			const signature = await blueprintCall("set_function_signature", {
				blueprint_name: blueprint,
				graph_name: probeFunction,
				add_inputs: [{ name: "PieProbe", type: "float" }],
				compile: true,
			});
			if (signature.payload?.success !== false || signature.payload?.error?.code !== "unsafe_operation_refused") {
				return fail("set_function_signature was not refused with unsafe_operation_refused during PIE: " + firstLine(signature.text));
			}
			const tree = await context.client.call("manage_ai", "bt_create", {
				name: "BT_UEV_PieProbe",
				path: "/Game/UEVTests",
				root_class: "/Script/AIModule.BTComposite_Sequence",
			});
			if (tree.payload?.success !== false || !String(tree.payload?.message ?? "").includes("Play In Editor")) {
				return fail("bt_create was not refused during PIE: " + firstLine(tree.text));
			}
			const guard = created.payload?.guard?.id ?? created.payload?.error?.guard;
			if (guard !== "pie-editor-mutation") {
				return fail("PIE refusal reported guard " + JSON.stringify(guard) + ", expected pie-editor-mutation");
			}
			return { ok: true, detail: "PIE active: blueprint function/signature and behavior-tree mutations refused with unsafe_operation_refused" };
		} finally {
			await call("stop_pie", { timeout_seconds: 60 });
			const stopped = await waitForPie(false, 60000);
			await blueprintCall("delete_function", { blueprint_name: blueprint, graph_name: "UEV_PieBlocked", compile: false });
			await blueprintCall("delete_function", { blueprint_name: blueprint, graph_name: probeFunction, compile: false });
			if (!stopped) {
				return fail("PIE did not stop within 60s after the refusal checks");
			}
		}
	},
});

// ------------------------------------------------------------------- helpers
function findTool(catalog, name) {
	return (catalog.tools ?? []).find((tool) => tool.name === name);
}

function findAction(tool, name) {
	return (tool?.actions ?? []).find((action) => action.name === name);
}

function firstLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function interpolate(value, vars) {
	if (typeof value === "string") {
		return value.replace(/\{\{([^}]+)\}\}/g, (_match, expression) => {
			const [name, ...rest] = String(expression).split(".");
			const found = readPath(vars[name], rest.join("."));
			return found === undefined ? "" : String(found);
		});
	}
	if (Array.isArray(value)) {
		return value.map((entry) => interpolate(entry, vars));
	}
	if (value && typeof value === "object") {
		const result = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = interpolate(entry, vars);
		}
		return result;
	}
	return value;
}

function matchesExpectation(id, payload, expect, checker, group, ms) {
	const problems = [];
	if (expect.equals) {
		for (const [key, expected] of Object.entries(expect.equals)) {
			const actual = readPath(payload, key);
			if (actual !== expected) {
				problems.push(key + " = " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
			}
		}
	}
	if (expect.matches) {
		for (const [key, pattern] of Object.entries(expect.matches)) {
			const actual = readPath(payload, key);
			if (!new RegExp(pattern).test(String(actual ?? ""))) {
				problems.push(key + " = " + JSON.stringify(actual) + " does not match " + pattern);
			}
		}
	}
	if (expect.includes) {
		for (const [key, needle] of Object.entries(expect.includes)) {
			const actual = readPath(payload, key);
			if (!String(actual ?? "").includes(needle)) {
				problems.push(key + " does not include " + JSON.stringify(needle));
			}
		}
	}
	if (expect.nonEmpty) {
		for (const key of expect.nonEmpty) {
			const actual = readPath(payload, key);
			const empty =
				actual === undefined ||
				actual === null ||
				actual === "" ||
				(Array.isArray(actual) && actual.length === 0) ||
				(typeof actual === "object" && !Array.isArray(actual) && Object.keys(actual).length === 0);
			if (empty) {
				problems.push(key + " is empty");
			}
		}
	}
	return { problems, checker, group, id, ms };
}

// ---------------------------------------------------------------------- main
const checker = new Checker("UEV test matrix");
const context = { client, descriptor, vars: {} };

function wanted(entry) {
	if (entry.write && !includeWrites) {
		return false;
	}
	if (onlyGroups.length && !onlyGroups.includes(entry.group)) {
		return false;
	}
	if (onlyCases.length && !onlyCases.includes(entry.id)) {
		return false;
	}
	return true;
}

async function main() {
	console.log("UEV test matrix against " + client.root + " (descriptor " + descriptor.descriptorPath + ")");
	console.log("");

	const health = await client.getJson("/api/health");
	const healthPayload = health.payload ?? {};
	let healthOk = true;
	if (health.status !== 200) {
		healthOk = false;
	}
	if (!healthPayload.productName) {
		healthOk = false;
	}
	if (!healthOk) {
		checker.fail("identity", "stack.reachable", "control API returned " + health.status + " at " + client.root);
		checker.finish(outPath, { descriptor: descriptor.descriptorPath });
		return;
	}
	checker.add(
		"identity",
		"stack.reachable",
		true,
		healthPayload.productName + " " + healthPayload.productVersion + " / " + healthPayload.serverVersion + " / protocol " + healthPayload.protocolVersion,
		health.ms,
	);

	let catalog = null;
	const needsCatalog = CASES.some((entry) => wanted(entry) && (entry.kind === "catalog" || entry.group === "identity"));
	if (needsCatalog) {
		const response = await client.getJson("/api/catalog");
		catalog = response.payload;
		if (!catalog || catalog.ok !== true) {
			checker.fail("identity", "catalog.available", "GET /api/catalog returned " + response.status);
			checker.finish(outPath, { descriptor: descriptor.descriptorPath });
			return;
		}
		if (recordFixture) {
			const version = String(catalog.productVersion ?? "unknown");
			const fixturePath = path.join(__dirname, "fixtures", "catalog-" + version + ".json");
			writeArtifact(fixturePath, catalog);
			console.log("Recorded catalog fixture: " + fixturePath);
		}
	}

	const needsFixtures = CASES.some(
		(entry) => wanted(entry) && (entry.group === "writes" || entry.group === "editor" || entry.fixtures === true),
	);
	if (needsFixtures) {
		const setup = await client.call("manage_editor", "run_python", { code: PY_FIXTURE_SETUP }, { timeoutMs: 180000 });
		const text = String(setup.text ?? "");
		checker.add("setup", "fixtures", text.includes("FIXTURE ok"), text.includes("NATIVE True") ? "native UEVMaterial present" : "native UEVMaterial missing", setup.ms);
		const instance = await client.call("manage_material", "create_material_instance", {
			parent_material: "/Game/UEVTests/M_UEV_SwitchFixture",
			instance_name: "MI_UEV_SwitchFixture",
			package_path: "/Game/UEVTests",
		});
		const createdOrExisting = instance.succeeded || String(instance.text ?? "").toLowerCase().includes("exist");
		checker.add("setup", "material-instance", createdOrExisting, firstLine(instance.text), instance.ms);
		const widgetProbe = await client.call("manage_query", "query", { path: "/Game/UEVTests/WBP_UEVApiWidget", limit: 1 });
		if (!String(widgetProbe.text ?? "").includes("WBP_UEVApiWidget")) {
			await client.call("manage_widget", "create_widget_blueprint", {
				widget_name: "/Game/UEVTests/WBP_UEVApiWidget",
				path: "/Game/UEVTests",
			});
			await client.call("manage_widget", "add_button", {
				widget_blueprint: "/Game/UEVTests/WBP_UEVApiWidget",
				button_name: "UEVButton",
				text: "Click",
			});
		}
	}

	for (const entry of CASES) {
		if (!wanted(entry)) {
			continue;
		}
		if (entry.write) {
			// A successful read clears the supervised circuit breaker before each write group member.
			await client.call("manage_editor", "is_pie_running");
		}
		if (entry.run) {
			try {
				const result = await entry.run(context);
				checker.add(entry.group, entry.id, result.ok, result.detail ?? "");
			} catch (error) {
				checker.add(entry.group, entry.id, false, error instanceof Error ? error.message : String(error));
			}
			continue;
		}
		if (entry.kind === "health") {
			const outcome = matchesExpectation(entry.id, healthPayload, entry.expect ?? {}, checker, entry.group, health.ms);
			checker.add(entry.group, entry.id, outcome.problems.length === 0, outcome.problems.join("; ") || describePayload(healthPayload), health.ms);
			continue;
		}
		if (entry.kind === "descriptor") {
			const outcome = matchesExpectation(entry.id, descriptor, entry.expect ?? {}, checker, entry.group, null);
			checker.add(entry.group, entry.id, outcome.problems.length === 0, outcome.problems.join("; ") || descriptor.descriptorPath);
			continue;
		}
		if (entry.kind === "catalog") {
			const problems = [];
			const outcome = matchesExpectation(entry.id, catalog, entry.expect ?? {}, checker, entry.group, null);
			problems.push(...outcome.problems);
			if (typeof entry.expect?.assert === "function") {
				const asserted = entry.expect.assert(catalog, context);
				if (asserted) {
					problems.push(asserted);
				}
			}
			const detail = problems.length ? problems.join("; ") : checklistDetail(catalog);
			checker.add(entry.group, entry.id, problems.length === 0, detail);
			continue;
		}

		const params = interpolate(entry.params ?? {}, context.vars);
		const result = await client.call(entry.tool, entry.action, params, { timeoutMs: entry.timeoutMs ?? 120000 });
		if (entry.save) {
			context.vars[entry.save] = result.payload;
		}
		const problems = [];
		if (result.status !== 200) {
			problems.push("HTTP " + result.status);
		}
		if (result.payload && result.payload.success === undefined && entry.expect?.equals?.success !== undefined) {
			problems.push("payload has no success flag");
		}
		const outcome = matchesExpectation(entry.id, result.payload, entry.expect ?? {}, checker, entry.group, result.ms);
		problems.push(...outcome.problems);
		if (typeof entry.expect?.assert === "function") {
			const asserted = entry.expect.assert(result.payload, context);
			if (asserted) {
				problems.push(asserted);
			}
		}
		const detail = problems.length ? problems.join("; ") : firstLine(result.text);
		checker.add(entry.group, entry.id, problems.length === 0, detail, result.ms);
	}

	checker.finish(outPath, {
		descriptor: descriptor.descriptorPath,
		controlApi: client.root,
		includeWrites,
		groups: onlyGroups.length ? onlyGroups : "all",
	});
}

function describePayload(payload) {
	return [payload.productName, payload.productVersion, payload.serverVersion, "protocol " + payload.protocolVersion].join(" ");
}

function checklistDetail(catalog) {
	const tools = catalog.tools?.length ?? 0;
	const actions = (catalog.tools ?? []).reduce((total, tool) => total + (tool.actions?.length ?? 0), 0);
	return tools + " tools / " + actions + " actions";
}

main().catch((error) => {
	console.error("UEV test matrix crashed: " + (error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});
