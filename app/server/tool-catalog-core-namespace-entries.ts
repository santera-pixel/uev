import type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const coreNamespaceEntries: ToolCatalogEntry[] = [
	{
		name: "manage_batch",
		category: "Core Direct Tools",
		description: "Execute several namespace or direct tool calls in one request and return per-call results.",
	},
	{
		name: "manage_asset",
		category: "Core Tool Namespaces",
		description: "Asset tool namespace for listing, searching, inspecting, exporting, validating, duplicating, renaming, moving, deleting, saving, and folder-management actions.",
	},
	{
		name: "manage_actor",
		category: "Core Tool Namespaces",
		description: "Actor tool namespace for listing, searching, spawning, deleting, transforming, and inspecting level actors.",
	},
	{
		name: "manage_query",
		category: "Core Tool Namespaces",
		description: "Read-only query namespace for structured project, asset, actor, and object discovery with pagination.",
	},
	{
		name: "manage_object",
		category: "Core Tool Namespaces",
		description: "Generic object substrate namespace for describe, get, set, call, spawn, ensure, destroy, duplicate, apply, and release_handles actions.",
	},
	{
		name: "manage_editor",
		category: "Core Tool Namespaces",
		description: "Editor tool namespace for run_python, console capture, enriched project/map inspection, PIE lifecycle (start_pie/stop_pie/is_pie_running) and expectations (pie_expect), screenshots, asset tab open/close/focus/list, prelude reload, and camera movement.",
	},
	{
		name: "manage_level",
		category: "Core Tool Namespaces",
		description: "Level tool namespace for map lifecycle inspection, actor listing, world outliner inspection, and map info.",
	},
	{
		name: "manage_system",
		category: "Core Tool Namespaces",
		description: "Polling helper namespace: wait_for repeats another tool action until a dotted JSON path matches an expected value.",
	},
	{
		name: "manage_editor_tool",
		category: "Core Tool Namespaces",
		description: "Editor-tool namespace for Editor Utility Widget Blueprint creation and opening as a docked editor tab.",
	},
	{
		name: "manage_stack",
		category: "Core Tool Namespaces",
		description: "Supervisor stack namespace for status, config, ensure, relaunch, and stop actions.",
	},
	{
		name: "manage_tools",
		category: "Core Tool Namespaces",
		description: "Tool-namespace registry for listing registered tool namespaces and describing supported actions. Use this as the discovery entry point for the namespace-first MCP surface.",
	},
	{
		name: "manage_source_control",
		category: "Core Tool Namespaces",
		description: "Source-control tool namespace for provider inspection and file or package source-control operations.",
	},
	{
		name: "manage_debug",
		category: "Core Tool Namespaces",
		description: "Debug tool namespace for health, supervisor status, remote execution status, Python environment, ping, editor/supervisor/audit log tails, recent calls, recent scripts, panic, and circuit reset actions.",
	},
	{
		name: "manage_history",
		category: "Core Tool Namespaces",
		description: "Action history namespace for listing and retrieving recorded calls, native editor undo/redo, semantic history metadata, status, and journal clearing.",
	},
	{
		name: "manage_vite",
		category: "Core Tool Namespaces",
		description: "Vite renderer inspection and controlled-write namespace for cvars, render state, compile switches, presets, and allowlisted console commands.",
	},
	{
		name: "manage_audit",
		category: "Core Tool Namespaces",
		description: "Read-only project audit namespace for required plugins, remote-execution config, Vite cvars, and consolidated project summaries.",
	},
	{
		name: "manage_ddgi",
		category: "Core Tool Namespaces",
		description: "NVIDIA RTXGI/DDGI namespace for listing, inspecting, validating, spawning, editing, and deleting volumes with native undo/redo.",
	},
	{
		name: "manage_profile",
		category: "Core Tool Namespaces",
		description: "Profiling namespace for stats-file capture, artifact listing/inspection, supervised profilegpu frame capture, before/after comparison, and frame-budget checks.",
	},
	{
		name: "manage_build",
		category: "Core Tool Namespaces",
		description: "Read-only build environment audit and command planning for ViteSetup, UBT, RunUAT, DDC commandlets, cache wipe, and debloat. Build execution is intentionally deferred.",
	},
	{
		name: "manage_code",
		category: "Core Tool Namespaces",
		description: "Read-first C++ and Live Coding namespace for status, project-source read/write with backups, source inventory, build/log inspection, automation-test inventory, and supervised compile/run previews.",
	},
	{
		name: "manage_ai",
		category: "Core Tool Namespaces",
		description: "AI namespace for controller, pawn, behavior-tree, blackboard, navmesh, and perception inspection, supervised debugger toggles, behavior-tree asset creation/search, and behavior-tree graph authoring (nodes, decorators, services, blackboard wiring, compile, repair).",
	},
]
