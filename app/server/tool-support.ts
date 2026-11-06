export type SupportStatus = "Supported" | "Partial"

export interface ToolSupportInfo {
	note?: string
	status: SupportStatus
}

const sourceControlProviderNote =
	"Requires a configured and available Unreal source-control provider in the active editor session."

const sourceControlQueryNote =
	"Returns structured state even when source control is disabled, but meaningful revision status requires a configured and available provider."

const sourceControlPackageReloadNote =
	"Requires a configured and available Unreal source-control provider plus valid long package names to reload."

const sourceControlProviderDependentTools = [
	"check_out_file",
	"check_out_files",
	"check_out_or_add_file",
	"check_out_or_add_files",
	"mark_file_for_add",
	"mark_files_for_add",
	"mark_file_for_delete",
	"mark_files_for_delete",
	"revert_file",
	"revert_files",
	"revert_unchanged_files",
	"sync_file",
	"sync_files",
	"check_in_files",
] as const

export const toolSupport: Record<string, ToolSupportInfo> = {
	...Object.fromEntries(
		sourceControlProviderDependentTools.map((name) => [
			name,
			{
				status: "Supported" as const,
				note: sourceControlProviderNote,
			},
		]),
	),
	get_source_control_provider: {
		status: "Supported",
		note: "Reports provider name plus enabled or available status even when source control is disabled.",
	},
	query_source_control_state: {
		status: "Supported",
		note: sourceControlQueryNote,
	},
	query_source_control_states: {
		status: "Supported",
		note: sourceControlQueryNote,
	},
	revert_and_reload_packages: {
		status: "Supported",
		note: sourceControlPackageReloadNote,
	},
	read_blueprint_content: {
		status: "Partial",
		note: "Blueprint graph listings depend on what UE4.27 Python exposes; asset and component reads still work.",
	},
	add_component_to_blueprint: {
		status: "Partial",
		note: "Basic component adds work; parent_component_name and some hierarchy edits require SimpleConstructionScript exposure.",
	},
	editor_umg_add_widget: {
		status: "Partial",
		note: "Widget tree edits work for native PanelWidget parents, but nested UserWidget subclasses are not supported and absolute positioning still requires CanvasPanel slots.",
	},
	editor_umg_set_widget_position: {
		status: "Partial",
		note: "Only widgets attached to CanvasPanel slots can be repositioned or resized.",
	},
	editor_umg_reparent_widget: {
		status: "Partial",
		note: "Cannot directly reparent the current root widget; use manage_widget.ensure_canvas_root to wrap a non-Canvas root when CanvasPanel positioning is required.",
	},
	editor_umg_add_child_widget: {
		status: "Partial",
		note: "Supports native widget classes under any PanelWidget parent; nested UserWidget subclasses are not supported, and absolute positioning requires CanvasPanel slots.",
	},
	editor_umg_set_child_widget_position: {
		status: "Partial",
		note: "Only direct children attached to CanvasPanel slots can be repositioned or resized.",
	},
	add_widget_to_viewport: {
		status: "Partial",
		note: "Requires an active PIE or game world. start_pie_if_needed can request PIE, but UE4.27 may need a follow-up add_to_viewport retry after the game world is ready.",
	},
	manage_editor: {
		status: "Supported",
		note: "Canonical namespace for project_info, map_info, world_outliner, start_pie, stop_pie, is_pie_running, console_command, and run_python.",
	},
	manage_system: {
		status: "Supported",
		note: "Polling helper only. Use manage_editor.console_command and manage_asset.validate for the canonical console and validation actions.",
	},
	manage_blueprint: {
		status: "Partial",
		note: "Blueprint asset, component, graph, typed function signature, local-variable, macro-library, and Construction Script authoring are available through the UEVGraphAuthoring plugin module; the remaining gap is stock UE4.27 Python, which exposes no equivalent graph-editing API on its own.",
	},
	manage_sequence: {
		status: "Partial",
		note: "Advanced binding, track, section, key, camera-cut, playback-range, and speed-track analysis actions require the UE4.27 SequencerScripting plugin in the target project.",
	},
	manage_editor_tool: {
		status: "Partial",
		note: "Create and launch EditorUtilityWidget Blueprints, create utility assets (EditorUtilityBlueprint when the engine exposes it; otherwise a Blueprint subclass of ActorActionUtility/AssetActionUtility), close an open utility tab, and list open editor tools; widget tree editing still uses manage_widget.",
	},
	manage_widget: {
		status: "Partial",
		note: "Widget tree creation plus anchor/alignment/offset/size/padding edits, container creation (add_panel), generic slot and widget-property setters, and event discovery work. Canvas geometry actions require a CanvasPanelSlot; use set_slot for other panel slots. add_to_viewport requires PIE; start_pie_if_needed can request PIE and may require a retry. list_events is a curated table, not reflection.",
	},
	manage_texture: {
		status: "Supported",
		note: "import_texture requires a local image file path that is accessible from the machine running the Unreal Editor session.",
	},
	manage_input: {
		status: "Supported",
		note: "Focused on classic UE4 input-mapping authoring; use manage_editor.project_info for the canonical project summary.",
	},
	manage_ai: {
		status: "Partial",
		note: "AI inspection, debugger toggles, BehaviorTree asset creation/search, blackboard creation and key editing, compiled BehaviorTree inspection, per-instance BehaviorTree assignment to an AIController, and BehaviorTree graph authoring (create, add/remove/move nodes, decorators, services, node properties, blackboard wiring, compile, graph repair) work. Persisting controller behavior-tree defaults on the Blueprint remains out of scope.",
	},
	manage_physics: {
		status: "Supported",
		note: "Spawns and edits physics-enabled Blueprint components, applies forces/impulses/torque in PIE, sets collision profile/response and CharacterMovement properties, and runs a bounded PIE drop test. Every write is read back; verify in PIE.",
	},
	manage_geometry: {
		status: "Supported",
		note: "All preset builders share manage_level geometry and actor-spawn plumbing; very large towns or mazes can exceed the default timeout.",
	},
	manage_source_control: {
		status: "Supported",
		note: "provider_info works broadly, but file and package operations require a configured and available Unreal source-control provider.",
	},
}

export const supportForTool = (name: string): ToolSupportInfo =>
	toolSupport[name] ?? {
		status: "Supported",
	}
