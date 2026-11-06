# UEV server runtime

UEV (UnrealEngineVite MCP) is the Unreal Engine 4.27 tool server: a stdio MCP server plus an
optional HTTP control plane, backed by the project-side UEVNative plugin.

This directory is the bundled server runtime. Do not launch it by hand: the project launcher
`Saved/UEV/run-stack.ps1` and the UEV supervisor (`UEVSupervisor.exe`) start it with the right
environment and supervision.

## Run modes

- `node dist/bin.js` - stdio MCP server for an MCP client.
- `node dist/bin.js --control` - HTTP control API on `127.0.0.1:8765` (supervised profile),
  descriptor at `%LOCALAPPDATA%\UEV\control.json`.

## Environment

Only the `UEV_*` prefix is read: `UEV_PROFILE`, `UEV_READ_ONLY`, `UEV_CONTROL_PORT`,
`UEV_CONTROL_TOKEN`, `UEV_CONTROL_DESCRIPTOR`, `UEV_SNAPSHOT_DIR`. See `SAFETY.md`.

## Requirements

- Unreal Engine 4.27.2 (Vite fork) with the project plugins `UEVNative` and `UEVControlPanel`.
- `PythonScriptPlugin` enabled (remote execution transport).

## Attribution

The server derives from the MIT-licensed `conaman/unreal-mcp-ue4` project. See
`THIRD_PARTY_NOTICES.md` and `LICENSE`.

## Available Tools

Notes call out important requirements or UE4.27 limitations when they matter. Empty notes mean there are no additional caveats beyond normal editor setup.

The recommended public surface is the `manage_*` namespace layer. Prefer `manage_editor.project_info`, `manage_editor.map_info`, and `manage_level.world_outliner` as canonical read entry points, and treat the small direct-tool set as low-level primitives for path discovery and actor CRUD.

### Editor Session Info

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>get_unreal_engine_path</code></td>
		<td width="52%">Get the active Unreal Engine root path from the connected editor session</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>get_unreal_project_path</code></td>
		<td width="52%">Get the active Unreal project file path from the connected editor session</td>
		<td width="30%">&nbsp;</td>
	</tr>
	</tbody>
</table>

### Core Direct Tools

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>editor_create_object</code></td>
		<td width="52%">Create a new object/actor in the world</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>editor_update_object</code></td>
		<td width="52%">Update an existing object/actor in the world</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>editor_delete_object</code></td>
		<td width="52%">Delete an object/actor from the world</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>editor_capture_window</code></td>
		<td width="52%">Capture the Unreal Editor window to a PNG artifact for visual verification.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_batch</code></td>
		<td width="52%">Execute several namespace or direct tool calls in one request and return per-call results.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	</tbody>
</table>

### Core Tool Namespaces

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>manage_asset</code></td>
		<td width="52%">Asset tool namespace for listing, searching, inspecting, exporting, validating, duplicating, renaming, moving, deleting, saving, and folder-management actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_actor</code></td>
		<td width="52%">Actor tool namespace for listing, searching, spawning, deleting, transforming, and inspecting level actors.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_query</code></td>
		<td width="52%">Read-only query namespace for structured project, asset, actor, and object discovery with pagination.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_object</code></td>
		<td width="52%">Generic object substrate namespace for describe, get, set, call, spawn, ensure, destroy, duplicate, apply, and release_handles actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_editor</code></td>
		<td width="52%">Editor tool namespace for run_python, console capture, enriched project/map inspection, PIE lifecycle (start_pie/stop_pie/is_pie_running) and expectations (pie_expect), screenshots, asset tab open/close/focus/list, prelude reload, and camera movement.</td>
		<td width="30%">Canonical namespace for project_info, map_info, world_outliner, start_pie, stop_pie, is_pie_running, console_command, and run_python.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_level</code></td>
		<td width="52%">Level tool namespace for map lifecycle inspection, actor listing, world outliner inspection, and map info.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_system</code></td>
		<td width="52%">Polling helper namespace: wait_for repeats another tool action until a dotted JSON path matches an expected value.</td>
		<td width="30%">Polling helper only. Use manage_editor.console_command and manage_asset.validate for the canonical console and validation actions.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_editor_tool</code></td>
		<td width="52%">Editor-tool namespace for Editor Utility Widget Blueprint creation and opening as a docked editor tab.</td>
		<td width="30%">Create and launch EditorUtilityWidget Blueprints, create utility assets (EditorUtilityBlueprint when the engine exposes it; otherwise a Blueprint subclass of ActorActionUtility/AssetActionUtility), close an open utility tab, and list open editor tools; widget tree editing still uses manage_widget.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_stack</code></td>
		<td width="52%">Supervisor stack namespace for status, config, ensure, relaunch, and stop actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_tools</code></td>
		<td width="52%">Tool-namespace registry for listing registered tool namespaces and describing supported actions. Use this as the discovery entry point for the namespace-first MCP surface.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_source_control</code></td>
		<td width="52%">Source-control tool namespace for provider inspection and file or package source-control operations.</td>
		<td width="30%">provider_info works broadly, but file and package operations require a configured and available Unreal source-control provider.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_debug</code></td>
		<td width="52%">Debug tool namespace for health, supervisor status, remote execution status, Python environment, ping, editor/supervisor/audit log tails, recent calls, recent scripts, panic, and circuit reset actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_history</code></td>
		<td width="52%">Action history namespace for listing and retrieving recorded calls, native editor undo/redo, semantic history metadata, status, and journal clearing.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_vite</code></td>
		<td width="52%">Vite renderer inspection and controlled-write namespace for cvars, render state, compile switches, presets, and allowlisted console commands.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_audit</code></td>
		<td width="52%">Read-only project audit namespace for required plugins, remote-execution config, Vite cvars, and consolidated project summaries.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_ddgi</code></td>
		<td width="52%">NVIDIA RTXGI/DDGI namespace for listing, inspecting, validating, spawning, editing, and deleting volumes with native undo/redo.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_profile</code></td>
		<td width="52%">Profiling namespace for stats-file capture, artifact listing/inspection, supervised profilegpu frame capture, before/after comparison, and frame-budget checks.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_build</code></td>
		<td width="52%">Read-only build environment audit and command planning for ViteSetup, UBT, RunUAT, DDC commandlets, cache wipe, and debloat. Build execution is intentionally deferred.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_code</code></td>
		<td width="52%">Read-first C++ and Live Coding namespace for status, project-source read/write with backups, source inventory, build/log inspection, automation-test inventory, and supervised compile/run previews.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_ai</code></td>
		<td width="52%">AI namespace for controller, pawn, behavior-tree, blackboard, navmesh, and perception inspection, supervised debugger toggles, behavior-tree asset creation/search, and behavior-tree graph authoring (nodes, decorators, services, blackboard wiring, compile, repair).</td>
		<td width="30%">AI inspection, debugger toggles, BehaviorTree asset creation/search, blackboard creation and key editing, compiled BehaviorTree inspection, per-instance BehaviorTree assignment to an AIController, and BehaviorTree graph authoring (create, add/remove/move nodes, decorators, services, node properties, blackboard wiring, compile, graph repair) work. Persisting controller behavior-tree defaults on the Blueprint remains out of scope.</td>
	</tr>
	</tbody>
</table>

### World & Environment Tool Namespaces

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>manage_lighting</code></td>
		<td width="52%">Lighting tool namespace for spawning common light actors, transforming them, and inspecting level lighting state.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_volumes</code></td>
		<td width="52%">Volume tool namespace for spawning common engine volumes and applying delete or transform actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_navigation</code></td>
		<td width="52%">Navigation tool namespace for spawning navigation volumes and proxies plus basic map inspection actions.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_splines</code></td>
		<td width="52%">Spline tool namespace for spawning a spline-host actor or Blueprint and then transforming or deleting it.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_geometry</code></td>
		<td width="52%">Geometry tool namespace for all preset builders: wall, maze, pyramid, bridge, town, house, mansion, tower, suspension bridge, aqueduct, castle fortress, arch, and staircase.</td>
		<td width="30%">All preset builders share manage_level geometry and actor-spawn plumbing; very large towns or mazes can exceed the default timeout.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_effect</code></td>
		<td width="52%">Effects tool namespace for spawning debug-shape actors, assigning materials, tinting them, and deleting them.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	</tbody>
</table>

### Content & Authoring Tool Namespaces

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>manage_skeleton</code></td>
		<td width="52%">Skeleton tool namespace for searching Skeleton and SkeletalMesh assets and inspecting their metadata.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_material</code></td>
		<td width="52%">Material tool namespace for listing/applying materials and tinting material instances, plus Material and MaterialFunction expression-graph authoring.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_texture</code></td>
		<td width="52%">Texture tool namespace for searching texture assets, importing image files as textures, and reading their asset metadata.</td>
		<td width="30%">import_texture requires a local image file path that is accessible from the machine running the Unreal Editor session.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_data</code></td>
		<td width="52%">Data tool namespace for searching data assets, creating common data containers, and inspecting their asset metadata.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_blueprint</code></td>
		<td width="52%">Blueprint tool namespace for Blueprint creation, component editing, graph/event/function/variable authoring, typed function signatures, local variables, macro libraries, Construction Script nodes, compilation, verification, and summary actions.</td>
		<td width="30%">Blueprint asset, component, graph, typed function signature, local-variable, macro-library, and Construction Script authoring are available through the UEVGraphAuthoring plugin module; the remaining gap is stock UE4.27 Python, which exposes no equivalent graph-editing API on its own.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_sequence</code></td>
		<td width="52%">Sequence tool namespace for creating, searching, inspecting, and editing LevelSequence assets, including bindings, tracks, sections, keys, camera cuts, playback ranges, and speed-track time calculations.</td>
		<td width="30%">Advanced binding, track, section, key, camera-cut, playback-range, and speed-track analysis actions require the UE4.27 SequencerScripting plugin in the target project.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_animation</code></td>
		<td width="52%">Animation authoring namespace for AnimBlueprint AnimGraphs and state machines, AnimSequence notifies/curves/markers, and AnimMontage slots/sections/segments/notifies.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_audio</code></td>
		<td width="52%">Audio tool namespace for importing audio files, searching audio assets, and inspecting their asset metadata.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_widget</code></td>
		<td width="52%">Widget tool namespace for UMG Blueprint creation, widget-tree inspection, widget-tree edits, CanvasPanel root normalization, and viewport spawning actions. Use inspect_tree to verify designer contents, add_child_widget for nested layout work, and ensure_canvas_root when absolute CanvasPanel positioning is required.</td>
		<td width="30%">Widget tree creation plus anchor/alignment/offset/size/padding edits, container creation (add_panel), generic slot and widget-property setters, and event discovery work. Canvas geometry actions require a CanvasPanelSlot; use set_slot for other panel slots. add_to_viewport requires PIE; start_pie_if_needed can request PIE and may require a retry. list_events is a curated table, not reflection.</td>
	</tr>
	</tbody>
</table>

### Gameplay & Systems Tool Namespaces

<table width="100%">
	<colgroup>
		<col width="18%">
		<col width="52%">
		<col width="30%">
	</colgroup>
	<thead>
		<tr>
			<th width="18%">Tool</th>
			<th width="52%">Description</th>
			<th width="30%">Notes</th>
		</tr>
	</thead>
	<tbody>
	<tr>
		<td width="18%"><code>manage_physics</code></td>
		<td width="52%">Physics tool namespace for spawning physics-enabled Blueprints, editing component physics, applying forces and impulses in PIE, setting collision profile/response and CharacterMovement properties, and running a bounded PIE drop test.</td>
		<td width="30%">Spawns and edits physics-enabled Blueprint components, applies forces/impulses/torque in PIE, sets collision profile/response and CharacterMovement properties, and runs a bounded PIE drop test. Every write is read back; verify in PIE.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_input</code></td>
		<td width="52%">Input tool namespace for creating classic UE4 input mappings.</td>
		<td width="30%">Focused on classic UE4 input-mapping authoring; use manage_editor.project_info for the canonical project summary.</td>
	</tr>
	<tr>
		<td width="18%"><code>manage_gas</code></td>
		<td width="52%">GAS tool namespace for searching gameplay-ability-related assets and inspecting their asset metadata.</td>
		<td width="30%">&nbsp;</td>
	</tr>
	</tbody>
</table>

### Excluded Capability Areas

These capability areas are intentionally not exposed through the MCP surface in this UE4.27 port because they fail reliably in the current Python environment and only add prompt or context overhead until a native bridge exists.

| Capability Area | Effect on MCP Surface | Why It Is Excluded |
|-----------------|-----------------------|---------------------|
| Blueprint event-graph event insertion | Related event-node and input-action helpers are excluded from the MCP surface. | The current UE4.27 Python environment does not expose reliable event graph access or K2 event reference setup. |
| Blueprint graph inspection and node search | Graph-analysis, graph-inspection, and node-search helpers are excluded from the MCP surface. | The current UE4.27 Python environment does not expose Blueprint graph arrays such as UbergraphPages or FunctionGraphs reliably enough for deterministic inspection. |
| Low-level Blueprint graph node creation | Generic graph-node helpers and related self or component reference insertion helpers are excluded from the MCP surface. | The current UE4.27 Python environment does not expose stable low-level graph node creation or member-reference wiring. |
| Blueprint function-call node authoring | Function-node helpers that depend on editor graph member-reference setup are excluded from the MCP surface. | The current UE4.27 Python environment does not expose reliable function-call node reference setup. |
| Blueprint variable and function metadata inspection | Variable-detail and function-detail helpers are excluded from the MCP surface. | The current UE4.27 Python environment does not expose NewVariables or FunctionGraphs reliably enough for deterministic inspection. |
| Blueprint variable authoring | Variable-creation helpers are excluded from the MCP surface. | BPVariableDescription and EdGraphPinType are not exposed in the current UE4.27 Python environment. |
| UMG delegate-binding authoring | Widget event-binding and text-binding helpers are excluded from the MCP surface. | DelegateEditorBinding is not exposed in the current UE4.27 Python environment. |

