# A tour of the tools

The server exposes **45 tools**: 38 namespaces plus seven direct tools. Inside the namespaces there
are **393 actions**. You don't have to memorize them. The control panel lists every one, and
`manage_tools.list` / `manage_tools.describe` answer "what can you do?" from inside a session.

This page is the map. For the generated, always-current list of actions and parameters, see
[TOOLS.md](TOOLS.md).

## How the surface is organized

Namespace tools all share one envelope:

```json
{ "action": "<action>", "params": { ... } }
```

`params` is a real JSON object, not a string. Unknown actions fail loudly and list the valid ones.

Direct tools skip the envelope because they do exactly one thing:
`editor_capture_window`, `editor_create_object`, `editor_delete_object`,
`editor_update_object`, `get_unreal_engine_path`, `get_unreal_project_path`, `manage_batch`.

## Level, actors and space

| Tool | Actions | What it covers |
| --- | ---: | --- |
| `manage_actor` | 9 | `find`, `list`, `spawn`, `spawn_blueprint`, `transform`, `delete`, `get_properties`, `set_property`, `get_material_info` |
| `manage_level` | 3 | Map info, actor listing, world outliner |
| `manage_query` | 1 | Find objects or assets by class, label, tag, component or reference |
| `manage_geometry` | 13 | Preset builders: wall, maze, pyramid, bridge, town, house, mansion, tower, suspension bridge, aqueduct, castle fortress |
| `manage_volumes` | 6 | Spawn common engine volumes, transform or delete them |
| `manage_lighting` | 5 | Spawn and move lights, inspect level lighting state |
| `manage_navigation` | 4 | Nav volumes, nav proxies, map inspection |
| `manage_splines` | 3 | Spawn a spline host actor or Blueprint, then move or delete it |
| `manage_physics` | 9 | Physics Blueprints, collision profiles, forces and impulses in PIE |

## Blueprints, widgets and animation

| Tool | Actions | What it covers |
| --- | ---: | --- |
| `manage_blueprint` | 38 | Create Blueprints; components; event, function, macro and Construction Script graphs; variables; compile and verify |
| `manage_widget` | 38 | UMG widget Blueprints: tree edits, slots, anchors, styling, events, designer screenshots, viewport spawn |
| `manage_animation` | 43 | AnimGraph nodes and state machines, sequence notifies and curves, montage slots and sections |
| `manage_sequence` | 14 | Level sequences: bindings, tracks, sections, keys, camera cuts |
| `manage_ai` | 27 | AI controllers, behavior trees and blackboards, navmesh actors, perception, debugger views |
| `manage_editor_tool` | 7 | Editor Utility Widget Blueprints, created and opened as docked tabs |

## Materials, textures and content

| Tool | Actions | What it covers |
| --- | ---: | --- |
| `manage_material` | 22 | Material and MaterialFunction graphs, material instances, parameters, apply to actor or Blueprint |
| `manage_texture` | 3 | Search textures, import images as textures, read metadata |
| `manage_asset` | 15 | List, search, inspect, export, validate, duplicate, rename, move, delete, save assets; folders |
| `manage_data` | 5 | Data assets, data tables, string tables: create, search, inspect |
| `manage_skeleton` | 3 | Search skeletons and skeletal meshes, read metadata |
| `manage_audio` | 3 | Import audio, search audio assets, inspect them |
| `manage_gas` | 2 | Search gameplay-ability assets, inspect them |

## Editor, runtime and debugging

| Tool | Actions | What it covers |
| --- | ---: | --- |
| `manage_editor` | 25 | `run_python`, console, PIE start/stop/expectations, camera, input injection, screenshots, open assets |
| `manage_debug` | 12 | Health, plugins, supervisor, log tails, recent scripts, panic and reset |
| `manage_stack` | 5 | Bring editor, supervisor and control API up on demand; attach; inspect readiness; stop |
| `manage_history` | 6 | Native undo/redo with semantic metadata, history listing and clear |
| `manage_profile` | 6 | Profiling captures, artifact inspection, log comparison, frame-budget checks |
| `manage_code` | 8 | C++ and Live Coding status, source read/write with backups, build logs, automation-test inventory |
| `manage_source_control` | 12 | Provider inspection plus file and package source-control operations |
| `manage_audit` | 4 | Read-only project audits: plugins, remote execution, Vite cvars, summary |
| `manage_build` | 2 | Read-only build environment audit and command planning |
| `manage_vite` | 13 | Vite renderer state: cvars, compile switches, presets, allowlisted console commands |
| `manage_ddgi` | 7 | Inspect, validate and edit RTXGI/DDGI volumes, with native undo |
| `manage_effect` | 4 | Debug-shape actors, material tinting, cleanup |
| `manage_input` | 1 | Create classic UE4 input mappings |
| `manage_object` | 10 | Any UObject: schema, property paths, function calls, spawn by class, duplicate, destroy |
| `manage_system` | 2 | `wait_for`: repeat an action until a dotted JSON path matches a value |
| `manage_tools` | 3 | The registry itself: list namespaces, describe actions |

The Vite rows (`manage_vite`, `manage_ddgi`, and the DDGI checks in `manage_audit`) target the
[Vite fork](https://vitestudio-tech.github.io/UnrealEngineVite-Docs/default-topic.html) of 4.27. On
stock 4.27 they report what is absent rather than pretending a cvar took effect.

## Reading a real call

Ask for something and the assistant turns it into a call like this:

```json
{
  "action": "spawn",
  "params": {
    "class": "PointLight",
    "label": "Key Light",
    "location": [120, 0, 260],
    "rotation": [0, 0, 0]
  }
}
```

and gets a structured answer back:

```json
{ "success": true, "actor_name": "PointLight_3", "actor_label": "Key Light" }
```

Every result is `ok: true/false` with a structured `error` when it fails, and the panel shows the
same thing. `manage_debug.last_calls` can replay the recent history.

## Handles: how tools refer to the same object twice

`manage_query` and the inspectors return stable handles of the form `uev:<kind>:<object path>`.
Pass a handle back into a later call and it resolves to the same object, which is steadier than
matching by label after something was renamed.

## Two knobs worth knowing

- **`dry_run: true`** validates a call without changing anything, where the action supports it. The
  panel marks actions that can't dry-run.
- **`save: false`** turns off the default autosave for graph edits. For many-node work, build the
  graph with saving off, then call the explicit `save` action once.

## Ready-made recipes

| Ask | Calls it produces |
| --- | --- |
| "Put a light 300 units above the player start" | `manage_actor.find` then `manage_actor.spawn` |
| "Make the rock material wet" | `manage_material.create_material_instance` then `set_material_instance_parameter` then `apply_to_actor` |
| "Build a health bar in the corner" | `manage_widget.create_widget_blueprint` then `add_panel` then `set_anchors` then `add_to_viewport` |
| "Show me what the editor looks like" | `editor_capture_window` or `manage_editor.screenshot` |
| "Why did the last call fail?" | `manage_debug.last_calls` then `manage_debug.logs` |
| "Undo that" | `manage_history.undo` |
