# 1.7.0 clean break

1.7.0 is the **clean-break release**. Everything the package ships, reads and writes has one
identity: UEV. There are no earlier names, paths, environment variables or launchers, and no
state migration: installing 1.7.0 does not read, move or delete state from an earlier build.
Tool behavior, protocol version and client registration key do not change.

## Version, supervisor and paths

- **Product version 1.7.0.** `/api/health`, the control descriptor, the control panel About
  surface, `manifest.json` and the installer all report product `1.7.0` on protocol `2`.
  The server version (`2026.11.6-1`) and protocol do not change, so a client that only gates on
  them is unaffected.
- **`UEVSupervisor.exe` is the only supervisor.** The C# project, assembly, namespace,
  installer registration, stack-manager lookup, run scripts and docs use that name, and the
  supervisor serves exactly one pipe, `\\.\pipe\uev-supervisor`.
- **State paths.** Project runtime state lives in `Saved\UEV` and per-user state in `~/.uev`.
  The installer reads and writes those paths only and records them in the install manifest.
- **Uninstall is residue-free.** `-Uninstall` removes the install root, the control descriptor,
  the project data directory (`Saved\UEV`), the per-user state directory (`~/.uev`)
  and backups. The installer creates no shortcuts, services, firewall rules, scheduled tasks or
  registry run keys, so there is nothing else to remove.

Nothing carries over from an earlier install: save anything you need from an old state
directory before you uninstall it. Uninstall the old build with its own `uninstall.bat` (editor
closed) and install 1.7.0 fresh. The `1.7.0-c` package is the archived compatibility snapshot,
built separately for anyone who still needs the old behaviour.

## Removed namespaces

These names are not part of the 1.7.0 surface; use the canonical owner instead.

| Removed | Use instead |
| --- | --- |
| `manage_level_structure` | `manage_level` (`world_outliner`) and `manage_geometry` (structure builders) |
| `manage_environment` | `manage_geometry` |
| `manage_animation_physics` | `manage_physics` (`compile_blueprint` lives on `manage_blueprint.compile`) |
| `manage_behavior_tree` | `manage_ai` (`create_behavior_tree`, `search_behavior_trees`) |
| `manage_ai_debug` | `manage_ai` |

A client that still calls one of them gets an unknown-tool error rather than a silent
redirect, so the break surfaces at the first call.

## Native plugin and module rename

The project plugins changed identity in 1.7.0. The installer migrates an existing project in
place: it backs the old folder up under `Saved\UEV\backups\<timestamp>\plugins`, removes
it, drops its `.uproject` entry and installs the renamed plugin on the same project. Nothing
else in the project changes, and `uninstall -KeepBackups` puts the old folders and entries back.

| 1.6.0 | 1.7.0 |
| --- | --- |
| `Plugins\MCPHistory` (`MCPHistory.uplugin`) | `Plugins\UEVNative` (`UEVNative.uplugin`) |
| modules `MCPHistory`, `MCPGraphAuthoring`, `MCPReflect`, `MCPMaterial` | `UEVNative`, `UEVGraphAuthoring`, `UEVReflect`, `UEVMaterial` |
| `unreal.MCPHistoryLibrary`, `MCPGraphLibrary`, `MCPReflectLibrary`, `MCPMaterialLibrary`, `MCPInputLibrary`, `MCPGraphAI` | `unreal.UEVLibrary`, `UEVGraphLibrary`, `UEVReflectLibrary`, `UEVMaterialLibrary`, `UEVInputLibrary`, `UEVGraphAI` |
| `Plugins\MCPControlPanel` | `Plugins\UEVControlPanel` |

Editor console commands are now `UEV.ControlPanel`, `UEV.DockControlPanel`, `UEV.StartControl`
and `UEV.StopControl`; the old `MCP.*` spellings are not registered. Panel state and exports live in `Saved\UEV`. The tool surface does not change: a 1.7.0 server
calls the new `unreal.<Class>` names only, so the rename is invisible to MCP clients.

## Environment variables

`UEV_*` is the only spelling that is read. No other prefix is aliased, warned about or
inspected: a client config or launcher that sets a different prefix still starts, but those
variables have no effect.

The supervisor named pipe is `\\.\pipe\uev-supervisor` and nothing else. `UEVSupervisor.exe`
is the only supervisor the package ships or registers, and it serves that one pipe.

## Tool surface

`manage_vite.screenshot` was folded into `manage_editor.screenshot`, which owns the strict
`{target, destination_path, width, height}` schema, the OS window capture, and the viewport
crash guard. Use it for every capture.

`get_unreal_engine_path` and `get_unreal_project_path` stay as direct tools: the project
inspection action on `manage_editor` reports the project name, directory and engine version,
but neither the `.uproject` path nor the engine install root. `get_unreal_version` is removed:
`manage_editor.project_info` returns the same engine version string in `engine_version`, so
the direct tool was surface without capability. The catalog is now 45 tools (7 direct + 38
namespaces) with 393 actions; `tests/fixtures/catalog-1.7.0.json` was recorded from that
catalog.

## New in 1.7.0: behavior tree graph authoring

1.7.0 adds thirteen `manage_ai` actions for authoring the Behavior Tree graph itself, not just
the asset. They require the `UEVGraphAuthoring` module (shipped inside `Plugins\UEVNative`);
without it they answer `plugin.unavailable` and change nothing.

| Action | Kind | Does |
| --- | --- | --- |
| `bt_create` | W | New Behavior Tree asset, optional path, blackboard and root composite class |
| `bt_inspect` | R | Structure, ids, classes, properties and (optionally) graph layout |
| `bt_add_node` | W | Composite or task node under a parent, at an index (appends when omitted) |
| `bt_remove_node` | W | Remove a node and its subtree |
| `bt_move_node` | W | Re-parent and re-order a node |
| `bt_set_node_property` | W | Write one node property (enum, bool, number, class) |
| `bt_add_decorator` / `bt_remove_decorator` | W | Attach or detach a decorator on a node, with `logic_op` and properties |
| `bt_add_service` / `bt_remove_service` | W | Attach or detach a service on a composite |
| `bt_set_blackboard` | W | Re-point the tree at another Blackboard |
| `bt_compile` | W | Rebuild the runtime tree and report node/execution counts |
| `bt_repair_graph` | W | Rebuild a missing or divergent editor graph from the runtime tree |

Node ids are readable: `ei:<execution_index>` for runtime nodes, `ei:<n>/d<k>` and `ei:<n>/s<k>`
for the k-th decorator or service on node n, and `root` for the visual root. They are a snapshot,
not a handle: a decorator or service consumes an execution index, so adding one renumbers every
node after it. Every mutation returns the full id map; read ids from that response or from
`bt_inspect` before addressing a node again rather than caching them across edits.

The existing fourteen `manage_ai` actions keep their schemas and behavior. v1 limits: blackboard
keys can be added and removed but not renamed, decorator `logic_op` is `test` only, and
`save` writes into `/Game` only (elsewhere the action reports `dirty` and leaves the asset
unsaved).

## New in 1.7.0: designer-grade UMG authoring

`manage_widget` keeps its existing actions and gains a native lane that edits the
Widget Blueprint tree the way the UMG designer does. The actions require the
`UEVGraphAuthoring` module (shipped inside `Plugins\UEVNative`); without it they answer
`plugin.unavailable` and change nothing. Reads stay reads; every mutation is one undo
transaction, marks the Blueprint structurally modified, invalidates the designer preview and
saves once at the end (pass `save: false` to batch).

| Action | Kind | Does |
| --- | --- | --- |
| `insert_widget` | W | Create a widget of a given class under a parent, at an index, with optional CanvasPanel layout |
| `reorder_child` | W | Move a widget to another index inside its current panel |
| `duplicate_widget` | W | Deep or shallow copy of a widget (and its subtree) under a new name |
| `rename_widget` | W | Rename with the designer's name validation and retarget editor bindings, animation bindings and variable nodes |
| `remove_widget` | W | Delete a subtree safely: purge event bindings, animation bindings and orphaned variable nodes before the transient rename |
| `reparent_widget` | W | Move a widget to another panel, keeping CanvasPanel layout where the slot classes allow it |
| `serialize_tree` | R | Full tree with ids, classes, parents, indexes and slot details |
| `validate_widget` | R | Orphan bindings, missing assets, unreachable widgets, duplicate names, orphan animation bindings |
| `set_style` | W | Read-modify-write `FSlateFontInfo`, colors and `FButtonStyle` states through reflected editor handles |
| `set_brush` | W | Read-modify-write an existing `FSlateBrush` (texture, material, draw type, margin, tint, image size) |
| `list_delegates` | R | Reflected multicast delegates on a widget class, with the events currently bound |
| `list_bound_events` | R | `UWidgetBlueprint::Bindings` as a table with validity per row |
| `unbind_event` | W | Remove one binding, optionally deleting the function graph |
| `designer_screenshot` | R | Render the designer preview to a PNG under the project directory |
| `inspect_selection` | R | The designer's current widget selection |

Widget identity is `<asset path>#/Root/Child/Leaf` (for example
`/Game/UI/WBP_Menu.WBP_Menu#/CanvasPanel_0/RootBox/Title`), so a call can name a widget
without depending on list order. Every structural response reports the operation, asset path,
the affected widget with its parent, index and slot class, warnings, whether the asset was
saved, and whether the designer preview was invalidated; reparenting additionally reports
`slot_class_changed`. The structural authoring actions (`add_widget`, `add_child_widget`,
`remove_widget`, `remove_child_widget`, `reparent_widget`) route through the native lane under
those names, and the old Python scripts are no longer used for those paths.

`designer_screenshot` renders the open designer preview with `FWidgetRenderer` (no
`HighResShot` and no viewport dependency); if the asset has no open editor it is opened
first. Output paths must stay inside the project directory and default to
`Saved/UEV/Screenshots/<WBP>_<timestamp>.png`.

## New in 1.7.0: Blueprint authoring depth (functions, macros, Construction Script)

`manage_blueprint` keeps its existing actions and gains a native lane for the parts of a
Blueprint that previously needed the editor UI: typed function signatures, local variables,
macro libraries, and the Construction Script. The actions require the `UEVGraphAuthoring`
module (shipped inside `Plugins\UEVNative`); without it they answer `plugin.unavailable` and
change nothing.

| Action | Kind | Does |
| --- | --- | --- |
| `list_graphs` | R | Every graph in the asset with a stable id, kind (ubergraph/function/macro/delegate/subgraph) and owner |
| `inspect_function` | R | Flags, inputs, outputs, local variables, metadata, and the call sites of a function graph |
| `inspect_blueprint_model` | R | Whole-asset model: graphs, functions, macros, local variables, components |
| `inspect_construction_script` | R | The Construction Script graph, its entry node, orphaned nodes and warnings |
| `set_function_signature` | W | Add, remove, rename and retype function pins; flags and metadata; recompiles |
| `rename_function` | W | Rename a function graph and rewrite its call sites |
| `delete_function` | W | Delete a function graph and report the references it orphaned |
| `add_local_variable` | W | Add a local variable to a function graph |
| `update_local_variable` | W | Rename, retype, re-default or re-flag a local variable (retype/removal of a used variable needs `force: true`) |
| `remove_local_variable` | W | Remove a local variable and report the nodes that referenced it |
| `create_macro_library` | W | Create a `BPTYPE_MacroLibrary` asset with the given name and path |
| `list_macros` | R | Macros across loaded libraries or one library, with instance counts |
| `inspect_macro` | R | Macro signature, metadata, and every instance in loaded Blueprints (with stale pins) |
| `create_macro` | W | Add a macro graph to a library with typed inputs and outputs |
| `set_macro_signature` | W | Edit macro pins and metadata and resynchronise instances in other Blueprints |
| `rename_macro` | W | Rename a macro graph and keep its instances attached |
| `delete_macro` | W | Delete a macro graph, destroy its instances elsewhere, and save the affected Blueprints |
| `reset_construction_script` | W | Clear the Construction Script back to its entry (optionally keeping the parent call) |
| `verify_blueprint` | R | Compare the asset against an expected model and report per-path differences |

`create_function` now accepts `inputs`, `outputs`, `flags`, `category`, `tooltip`, `meta` and
`duplicate_policy` (`fail` is the default and returns `duplicate_function` instead of renaming
an existing graph out of the way). `inspect_graph` and `add_node` accept `graph_id`.
`add_node` with `node_type: "macro"` now takes `macro_library` (or `macro_path`) to instantiate
a macro from any loaded macro-library asset, not only `StandardMacros`.

### Graph identity

Every graph response carries a `graph_id` derived from `UEdGraph::GraphGuid`, which survives
renames, saves and editor restarts. Actions resolve a graph by exact `graph_id` first, then by
`graph_name`, then by the documented aliases (`event`, `construction`, `animgraph`). Unknown ids
return `graph_not_found` with the candidate list instead of guessing. Pin identity is
`<node_id>:<pin_name>`; macro parameters are `<graph_id>/in:<name>` and `<graph_id>/out:<name>`.

### Transactions, compiles and PIE

Every mutating action in this lane is a single undo transaction, and that now also holds for
the pre-existing mutating blueprint actions (`add_node`, `connect_nodes`, `delete_node`,
`add_variable`, `create_function` and the component setters). Previously the namespace opened
no transaction at all, so a failed edit could leave half-applied changes behind. `save: false`
still batches work; the response reports `saved` and `dirty` honestly.

Signature, macro and Construction Script edits compile the owning Blueprint synchronously,
because the generated class and the pin sets are only valid after a compile. While Play In
Editor is running these actions refuse with `unsafe_operation_refused` (the same guard the
`compile` action already used); `verify_blueprint` degrades to a model-only check and reports
`compile_skipped`.

Macro edits resynchronise instances in every loaded Blueprint and re-save the affected assets;
the response lists them under `instances_resynced` and `affected_blueprints`. Deleting a
macro destroys its instances rather than leaving dangling nodes, and reports them under
`destroyed_instances`.

The Construction Script is bound to the real `AActor::UserConstructionScript`, so its
signature is read-only (`construction_script_read_only`). `inspect_construction_script` and
`reset_construction_script` are the supported operations; both set
`requires_pie_verification`, because the script runs on spawn and in the editor preview.

### Failure codes

Structured errors replace the `check()`/`ensure()` paths the editor UI would hit:
`duplicate_graph_name`, `duplicate_function`, `duplicate_pin_name`, `not_a_function_graph`,
`not_a_macro_graph`, `construction_script_read_only`, `unsupported_blueprint_type`
(functions in a macro library), `pin_creation_failed`, `pin_rename_failed`,
`local_variable_in_use`, `local_variable_retype_requires_force`, `asset_already_exists`,
`graph_not_found` and `unsafe_operation_refused`.

Known limits: a local variable retype reconstructs the variable nodes it owns but reports
external call sites as stale rather than rewriting them, and `save` still refuses paths outside
`/Game` (the response reports `dirty` instead).

## Verifying the install

```powershell
node tests/identity-1.7.mjs
node tests/identity-1.7.mjs --project <path-to-project>.uproject
```

Both paths are relative to the unzipped package, which ships `tests/`. From a source checkout the
same suites are also wired into `app/package.json` (`npm --prefix app run test:no-unreal`).

Passing `--project` adds the native plugin checks: `Plugins\UEVNative` and
`Plugins\UEVControlPanel` present with a built `UE4Editor-UEVNative.dll`, no `MCP*` folders and no
`MCP*` entry in the `.uproject`, and `Saved\UEV` present.

Both run without an editor and also prove the install-level identity: `/api/health` reports
`1.7.0`, `%LOCALAPPDATA%\UEV\supervisor\UEVSupervisor.exe` is the only supervisor binary, and the
control API only answers when `UEV_*` variables are set.
