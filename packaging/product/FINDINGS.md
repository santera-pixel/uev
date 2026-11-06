# Battle-test findings: UEV 1.7 for UE 4.27 (Vite fork)

Package 1.7.0, protocol 2, tested against Unreal Engine 4.27.2 (NvRTX/Vite fork) on Windows 11, project `mcptest2`. 45 tools / 38 namespaces / 393 actions.

This document records what was exercised, what was fast, what was slow, and what remains limited. Timings are end-to-end from the control API (HTTP + tool dispatch + editor work), measured on a warm editor unless stated otherwise. Single-run probe timings vary by roughly ±20%.

## Executive summary

- The 1.5 pass reduced the surface from 48 tools / 321 actions to **46 tools / 349 actions**, removed duplicate inspection and alias actions, and made the catalog live instead of a startup snapshot.
- Version identity is now explicit: package `1.5.0`, server `2026.11.5-1`, protocol `2`, engine range `>=4.27.0 <4.28.0`. Unknown 4.27 builds are allowed with a warning; `UEV_STRICT_ENGINE=1` turns that warning into a failure. Non-4.27 engines are rejected.
- The control API now identifies every call (`callId`), exposes `GET /api/calls`, and accepts `POST /api/cancel`. Cancel means **stop waiting**, not interrupt the editor; the response says `applied: false`, `status: "abandoned"`. A second concurrent write returns HTTP 409 `editor_busy`.
- Handler failures now return HTTP 200 with `ok:false, isError:true, error` instead of HTTP 500, so clients see structured errors.
- Material instances gained native-free Python inspection and parameter editing (`inspect_material_instance`, `set_material_instance_parameter`, `set_material_instance_parent`).
- Editor Utility Widget creation and launch moved to a dedicated `manage_editor_tool` namespace; duplicate launch actions were removed from `manage_widget`.
- The 1.7 pass added behavior tree graph authoring: thirteen `manage_ai` actions that edit the behavior tree graph and the runtime tree together, at 25-100 ms per call instead of the 250-400 ms an asset-level authoring round trip cost in 1.5.
- The same 1.7 pass made widget authoring designer-grade (hierarchy, slots, anchors, styling, events, preview capture), added nineteen Blueprint actions for functions, macros and the Construction Script, and finished the UEV identity; the shipped surface is 45 tools / 38 namespaces / 393 actions.
- The biggest performance costs are unchanged: editor cold start and shader compilation dominate, material recompiles are blocking, and asset create/save is still slower than native graph edits.

## What got faster (or newly possible)

| Operation | Warm latency | Notes |
|---|---:|---|
| `manage_debug.ping` | 68-370 ms | first ping after restart 1.4-4.5 s |
| Remote Python round trip | 38 ms | transport only |
| `manage_blueprint.read` | 189-333 ms | native SCS inspection |
| `manage_blueprint.add_node` | ~390 ms | PrintString via plain or `class:` target |
| `manage_blueprint.compile` | 258-363 ms | includes save |
| `manage_material.add_expression` | 264-334 ms | color shorthand and property preview |
| `manage_material.recompile` | 0.77-4 s | shader compile dominates |
| `manage_material.inspect_material_instance` | 692 ms | parent plus scalar/vector/texture/switch parameters |
| `manage_material.set_material_instance_parameter` | 198 ms | no shader recompile for a parameter value |
| `manage_widget.bind_event` | ~430 ms | native path creates function and delegate binding |
| `manage_editor_tool.create_editor_utility_widget` | 167-182 ms | correct EUW factory |
| `manage_system.compatibility` | 73 ms | engine version + plugin/capability probe |

C++ graph operations remain faster than asset-level Python operations: a node or expression edit is ~0.25-0.4 s, while creating/saving a new asset is ~0.3-0.9 s. The difference is Python asset lookup/save overhead, not graph traversal.

## What is slower, and why

1. **Editor cold start and shader compilation.** The control server answers first; the first real tool call can take 1.4-4.5 s, and a full editor launch after a plugin rebuild can take minutes while shaders compile. This is engine behavior, not MCP overhead.
2. **Material recompile (0.77-4 s).** Blocking; batch expression edits with `save: false`, then recompile once. Instance parameter edits avoid recompiling the master material.
3. **Asset creation/save (0.3-0.9 s each).** Creating a Blueprint or Widget Blueprint, adding components, and saving each cost hundreds of milliseconds. `manage_batch` helps when operations are independent.
4. **C++ iteration loop.** Editing the native plugin requires closing the editor, running UBT (9-19 s incremental), copying the DLL, and relaunching. Most wall-clock time is editor startup, not compilation.
5. **Single-threaded editor.** Parallel write calls serialize in the editor and can trip request timeouts. Parallel reads are fine; writes should be sequential. 1.5 makes this explicit with 409 `editor_busy`.
6. **PIE state transitions are asynchronous.** `start_pie` returns `transition_pending: true` before the game world exists. Poll `is_pie_running` or use `manage_system.wait_for`.
7. **Catalog reads are cheap.** A live `/api/catalog` request with 45 tools and nested parameter schemas completes in milliseconds; the cost is in schema generation, not I/O.

## 1.5 contract and control-server findings

- Version identity had five disagreeing surfaces before this pass (package manifest, installer module, server package, `version.ts`, plugin descriptors). The package build script now derives `manifest.json` (productVersion, serverVersion, protocolVersion) from the built `dist/version.js` and refuses to build when `package.json` or `-Version` disagrees with it, and stamps only the installer's fallback constant. The package README and this document are not stamped: `Release-UEV.ps1` regenerates `docs/TOOLS.md` from the live catalog and fails the release when either file quotes counts or a version banner the server does not report. Plugin descriptors and server constants are checked by release tests.
- A server-side call registry is enough to make cancel honest. The editor is single-threaded and cannot be pre-empted from Python; the only cooperative cancel path is `manage_editor.run_python_async`, which polls `<ProjectSaved>/UEV/async/<id>.cancel`.
- `POST /api/cancel` therefore returns `accepted:true`, `applied:true|false`, and `status:"abandoned"`. It never claims the editor stopped executing.
- The second concurrent non-read call is rejected with 409 and the active call's id, so clients do not queue invisibly behind a slow editor operation.
- Structured errors keep the original text for compatibility but add `data`, `error`, and `warnings` fields parsed from JSON results.

## Correctness findings by domain

### Blueprints
- Before the native fix, `read` returned empty components/variables/functions because UE 4.27 Python only exposes generic `UObject` members. The C++ path returns the real SimpleConstructionScript, parent class/path, generated class, components with transforms and physics, variables, functions, and graphs.
- `add_node` for `PrintString` accepts plain class names; the native resolver falls through to class lookup.
- `connect_nodes` rejects unknown fields (strict schema); there is no `graph_name`.
- Physics mass reports the override value when set, otherwise `GetMass()`. A PIE drop measured the component falling from Z=800 to Z≈760.8 in ~2.5 s with mass 30.
- A non-placeable Blueprint (AIController) passed to `spawn_blueprint` formerly crashed the editor in `UActorFactoryBlueprint::PreSpawnActor`. Spawning now validates placeability and returns a structured error.

### Materials
- Working shapes:
  - `create_material`: `{asset_name, path, save}`
  - `add_expression`: `{asset_path, expression_class, x, y, properties, save}`
  - `set_expression_property`: `{asset_path, expression, property, value, save}`
  - `inspect_graph`: `{asset_path}`
  - `inspect_material_instance`: `{asset_path}`
  - `set_material_instance_parameter`: `{asset_path, parameter_name, parameter_type, value}`
- Short expression names such as `Constant3Vector_0` resolve case-insensitively; errors list available expressions.
- `inspect_graph` emits a `properties` object (constant/default value color, parameter name, texture, R/G/B/A) exported from the native property system.
- Color shorthand works: `properties: {r, g, b, a}` maps to `Constant` for Constant3Vector/Constant4Vector and `DefaultValue` for VectorParameter.
- Material instance parameter values can be inspected and changed without touching the parent graph. A scalar Roughness change took 198 ms.
- Cosmetic quirk: `VectorParameter` reports five generic outputs (`Output`..`Output4`); do not rely on the output count.

### Widgets / editor tools
- Creating an Editor Utility Widget with `parent_class: "EditorUtilityWidget"` formerly produced a plain `WidgetBlueprint`; launching it failed with "Cannot nativize WidgetBlueprint as EditorUtilityWidgetBlueprint". The factory now chooses `EditorUtilityWidgetBlueprintFactory`.
- UE 4.27 Python does not expose `DelegateEditorBinding`, so `bind_event` uses the native `blueprint.bind_widget_event` path: validates the widget, creates the handler function if needed, writes the binding, compiles, and saves.
- `manage_editor_tool.create_editor_utility_widget` creates the correct asset class in 167-182 ms; `launch_editor_utility` resolves short names and spawns the tab.
- End-to-end verified: EUW created with a button and a function, event bound, compiled with 0 errors, and the tab launched.

### AI / behavior trees
- Inspection is correct; the test map has no AI controllers, navmesh, or perception assets, so empty lists are true results.
- `toggle_debug` with `confirm: true` executes the allowlisted console command (`show Navigation`) and returns success; it does not capture the viewport result.
- Blackboard creation and key editing remain blocked in UE 4.27 Python: `UBlackboardDataFactory` is abstract, `FBlackboardEntry` is not `BlueprintType`, and key types are `EditInlineNew` subobjects. This needs native C++.
- Behavior Tree `blackboard_asset` and `root_node` are invisible to Python; inspection requires the reflect/export-text path.
- AI capability remains inspection plus Behavior Tree asset creation. No blackboard editing, BT graph authoring, AI-controller assignment, or navmesh volume spawn yet. C-lite BT graph authoring is scoped behind a capability probe for a later 1.5.x build.

### Actor spawning
- Spawning `BP_BattleProbe` and `BP_PhysProbe` succeeds (~330 ms); spawning an AIController Blueprint returns a clear "could not be placed" message and leaves the editor alive.

## API and documentation drift observed

| Documented / intuitive name | Actual name |
|---|---|
| `manage_asset.asset_info` | `manage_asset.info` |
| `create_material(material_name, package_path)` | `create_material(asset_name, path)` |
| `add_expression(expression_type)` | `add_expression(expression_class)` |
| `set_expression_property(expression_id)` | `set_expression_property(expression)` |
| `manage_blueprint.connect_nodes(graph_name, ...)` | no `graph_name`; strict schema |
| `manage_behavior_tree.*` | removed in 1.7.0; canonical `manage_ai.create_behavior_tree` / `search_behavior_trees` |
| `manage_animation_physics.*` | removed in 1.7.0; canonical `manage_physics` |
| `manage_level_structure.*`, `manage_environment.*` | removed in 1.7.0; canonical `manage_level` / `manage_geometry` |
| `manage_ai_debug.*` | removed in 1.7.0; canonical `manage_ai` |
| `manage_widget.launch_editor_utility` | moved to `manage_editor_tool.launch_editor_utility` |

## Bugs fixed in this pass

- Contract: one product/server/protocol identity, engine compatibility range, strict-mode switch, live catalog, structured errors.
- Control API: call ids, `/api/calls`, `/api/cancel`, 409 `editor_busy`, abandon semantics that do not claim editor interruption.
- Catalog: nested object/array parameter schemas, hidden alias filtering, missing metadata for `manage_query`, `manage_object`, `manage_stack`, `manage_batch`, `manage_editor_tool`.
- Surface: duplicate world/geometry builders collapsed into `manage_geometry`; `manage_level` keeps map lifecycle/outliner; `manage_ai` and `manage_physics` replace their aliases; `manage_system` is polling plus `compatibility` only.
- Material instances: inspect and set scalar/vector/texture/static-switch parameters and parent.
- Compatibility probe returned "Unknown compat operation" because the script read `OPERATION` instead of the injected lowercase `operation`; fixed and verified live (73 ms).
- Build: `-Version` now drives the installer's fallback `ProductVersion`; the manifest writes `productVersion`, `serverVersion`, `protocolVersion` and `engine`, all cross-checked against the built server identity; plugin descriptors aligned to 1.5.0.
- Asset deletion safety from 1.1.8 retained: save loaded assets, close asset editors, close spawned EUW dock tabs before `ForceDeleteObjects`, refuse if a tab cannot be closed.

## Core B additions (1.5.0)

- **AI authoring.** `create_blackboard` 250-400 ms, `add_blackboard_key` 300-370 ms, `list_blackboard_keys` 240 ms, `create_behavior_tree` 107-377 ms. `inspect_behavior_tree` on an uncompiled tree returns `success:false` with "no root node" instead of inventing a tree; `assign_behavior_tree` refuses when no placed controller matches the target and `spawn_if_missing` is false.
- **Material instances.** Batch `get_material_instance_parameters` ~130 ms and `set_material_instance_parameters` 250-380 ms with per-parameter read-back; scalar/vector/texture overrides verify, and static switches raise a clear 4.27 error instead of silently failing.
- **Physics.** Native `set_collision_profile` 308 ms and `set_collision_response` 327 ms both read back and save; `set_character_movement` 376 ms against the native Character CDO (CharMoveComp); `add_impulse` 325 ms (an immediate `linear_velocity_after` read is still 0 because the physics tick applies it later). `pie_drop_test` spawns through native `gameplay.spawn_pie_actor` and polls the child primitive component: at z=900 it fell 898.9 to 769.6 over 3 s; at z=250 it fell to 178 then bounced and reported `not_settled` after 5 s, which is honest but shows ground tracing is unreliable in ThirdPersonExampleMap.
- **UMG.** Widget creation 187-470 ms; panels, slots, anchors, padding, size, properties, and event listing each ~300 ms. `list_events` returned the five Button delegates; `inspect_tree` reported the full tree with slots.
- **Editor tools.** EUW create ~300 ms, launch 312 ms, `list_open_editor_tools` confirms the registered dock tab, close removes it. Actor/Asset Action Utilities are created as plain `Blueprint` subclasses because UE 4.27 Python does not expose `EditorUtilityBlueprint`.
- **Editor runtime.** `project_info` 333-606 ms with game modes/characters/source roots; `console_command` 352-457 ms reading the editor log (honest `output_captured:false` when the command logs nothing); window screenshot 2 s (1290×730 PNG); asset open/close 189-480 ms; `pie_expect` returns a structured not-running failure when PIE is off.
- **Panel contract.** `callId` on every call, `GET /api/calls` lists active calls only, unknown cancel id returns HTTP 404, and a concurrent mutating call returns 409 `editor_busy`.

## Crash guards and auto-recovery (1.6.0)

1.5.0 dodged the crashes it had already seen, one by one, and a crash still took the whole stack down. 1.6.0 makes that systematic: every known crash class has a named guard that refuses the unsafe operation with a structured error *before* the engine is touched, and the supervisor restarts the editor when something still dies.

| Guard | Crash class it prevents | Enforced by |
| --- | --- | --- |
| `protected-content` | Deleting, moving, or renaming engine or project-root content corrupts the install and the project | Server `crash-guards.ts`, before the tool handler runs |
| `loaded-asset-delete` | Force-deleting an asset that still has a loaded editor tab | Python asset tools: save, close editors, refuse when a tab cannot be closed |
| `pie-editor-mutation` | Mutating the editor world while PIE worlds are alive (actor destroy/spawn, asset delete/move, blueprint compile) | Python prelude (`ue_compat/05_crash_guards.py`) and, for blueprint compile, native `UEVGraphAuthoring` |
| `unplaceable-blueprint` | `UActorFactoryBlueprint::PreSpawnActor` assertion when a controller, game mode, or abstract blueprint is spawned | Python spawn tools, placeability check before the factory runs |
| `viewport-capture` | In-process `HighResShot` trips a render profiler assertion | `manage_editor.screenshot` downgrades to an editor-window capture |
| `panel-reentrancy` | A refresh triggered from inside a refresh recurses through `RebuildToolRows`/`RebuildParamForm` until the Slate stack dies | Control Panel: in-flight refresh flag plus a rebuild depth cap of 8 |
| `retained-actor-delete` | Destroying an actor that had been handed out as a handle tripped `Assertion failed: !IsRooted()` in `UObjectBaseUtility.h`; the native registry rooted every retained object | `UEVLibrary` keeps `TWeakObjectPtr` entries and never roots, so a delete of a previously queried actor is safe |
| `crash-watchdog` | Any remaining crash kills the editor and the control plane together | Supervisor: restarts the child, records the crash report |

Refusals keep the tool's normal result shape, so a client can branch on them without string matching:

```json
{
  "success": false,
  "message": "Refusing to spawn actor: Play In Editor is running (1 PIE world(s)).",
  "error": {
    "code": "unsafe_operation_refused",
    "guard": "pie-editor-mutation",
    "message": "Refusing to spawn actor: Play In Editor is running (1 PIE world(s)).",
    "hint": "Stop Play In Editor first (manage_pie.stop_pie), then retry. Set UEV_ALLOW_UNSAFE_OPERATIONS=1 only for a deliberate, backed-up operation."
  }
}
```

`UEV_ALLOW_UNSAFE_OPERATIONS=1` turns the destructive guards off for one session. Use it only with a backup and a reason; it is the documented escape hatch for scripted migrations.

Watchdog behaviour: on an unexpected child exit the supervisor logs `watchdog: crash detected (child exit=<code>)`, the newest `Saved/Crashes/UE4CC-*` report with its assertion text, and restarts the editor after `--restart-delay-ms` (default 5000). It gives up after `--max-restarts` (default 3) restarts inside `--restart-window-seconds` (default 600) and stops with a logged reason. `--no-restart` disables the watchdog; a normal exit (code 0) and a deliberate panic stop are never restarted. `GET` on the supervisor status pipe reports `restartOnCrash`, `maxRestarts`, `restarts`, `lastExitCode`, and `lastCrashPath`.

Regression suite: `tests/crash-guards.mjs` (no dependencies, runs against a live stack) exercises every guard that is reachable over the control API and then crashes the editor on purpose (`os._exit(3)`) to prove the watchdog recovers it. It reports `SKIP` and never `PASS` for behaviour the machine cannot exercise, and exits non-zero on any failure. On this build it reported `9 passed, 0 skipped, 0 failed`.

Scope, stated honestly: `loaded-asset-delete` is a *save-and-close* guard, not a refusal. Deleting a loaded asset whose editors can be saved still deletes it; that is the documented 1.5.0 behaviour and it is exactly what happened to a test blueprint during verification of this card (restored from a backup copy, then re-opened, recompiled, and played). Treat a delete of a loaded asset as destructive even when the guard is in place.
## Object handles (1.6.0)

1.5.0 returns handles as `obj_<n>`, a positional index into the native retained-object array. That index is only meaningful until something clears the array: `manage_object.release_handles`, a PIE transition, or an editor restart. After a clear, the same `obj_N` silently names a *different* object, so a stored handle can quietly retarget a later call, which is the worst kind of bug to debug.

1.6.0 adds a stable handle beside the numeric one. Every query result now carries both:

```json
{
  "name": "PointLight",
  "path": "/Game/ThirdPersonCPP/Maps/ThirdPersonExampleMap.ThirdPersonExampleMap:PersistentLevel.PointLight",
  "handle": "uev:actor:/Game/ThirdPersonCPP/Maps/ThirdPersonExampleMap.ThirdPersonExampleMap:PersistentLevel.PointLight",
  "native_handle": "obj_2"
}
```

The `uev:` handle is `uev:<kind>:<object path>` with kind `actor`, `asset`, or `object`. It is deterministic: the same object always produces the same handle, so it survives `release_handles`, PIE start/stop, and an editor restart, and it can be written into a config or a test. Resolution re-finds the object by path (an actor scan over the editor and PIE worlds, or an asset load), which costs one lookup per call but cannot silently retarget.

Handles that genuinely cannot resolve now fail loudly instead of drifting:

```json
{
  "success": false,
  "message": "Handle uev:actor:/Game/.../PointLight no longer resolves: the object was deleted or its path changed.",
  "error": { "code": "handle_stale", "message": "...", "hint": "Re-run the query to get a fresh handle." }
}
```

The numeric `obj_N` handle still works for live objects, so a 1.5.0 client script keeps running; when one no longer resolves the error names the registry generation and points at the stable form. `manage_object.release_handles` returns `{ released, generation, stable_handle_prefix }` so a caller can tell that the native table was cleared without losing its stable handles.

The native side no longer roots what it retains. 1.5.0 called `AddToRoot()` on every retained object, which made deleting an actor that had ever appeared in a query result crash the editor with `Assertion failed: !IsRooted()`. The registry is now a `TWeakObjectPtr` array: it dedupes and prunes dead entries, holds nothing alive, and a deleted object simply stops resolving. That is the same bug class as the crash guards, fixed at the source rather than refused.

Regression suite: `tests/stable-handles.mjs` runs against a live stack, spawns probe actors, releases the native registry mid-flight, deletes a previously handled actor, and asserts that the stable handle survives and that a stale one reports `handle_stale` rather than retargeting.

## Control-plane latency and cold start (1.6.0)

1.5.0 answered a warm ping in ~42 ms, but the first ping after a supervisor restart took 1.4-4.5 s and some calls paid avoidable, repeated work. 1.6.0 instruments the startup, removes the per-request rebuilds, and publishes a budget benchmark.

Phase instrumentation: `GET /api/health` now carries a `startup` object (`bootAt`, `elapsedMs`, and `phases: [{name, atMs, sincePreviousMs}]`), and the control server logs one `UEV startup: <phase>=<ms>ms ...; elapsed=<ms>ms` line per process. Recorded phases are `preludes`, `imports`, `runtime`, `registry`, `catalog`, `prewarm`, `control-listen` and (when the editor is reachable) `editor-probe`, so a slow start can be attributed instead of guessed.

Measured on this machine with `tests/control-latency.mjs` (host `D:/Uprojects/mcptest2`, UE4.27 Vite fork, 45 tools):

| Measurement | 1.5.0 baseline | 1.6.0 | Budget |
| --- | --- | --- | --- |
| Cold first ping (new process, cold file cache) | 1628 ms | 847 ms installed app; 415-737 ms packaged (one 1600 ms first-ever launch of the freshly copied `node.exe`) | <= 1500 ms |
| Cold first ping (same build, warm file cache) | - | 409 ms | <= 1500 ms |
| Cold first catalog | 1649 ms | 853 ms installed app; 413-740 ms packaged | - |
| Warm ping p50 / p95 | 42 ms (p50 only) | 15.8 / 20.9 ms | p95 <= 60 ms |
| Catalog p50 / p95 (164,707 bytes) | rebuilt per request | 15.4 / 16.5 ms | - |
| `manage_actor.list` p50 / p95 | - | 331.5 / 358.9 ms (server 314 / 327) | - |
| `manage_actor.spawn` p50 / p95 | - | 334.0 / 337.2 ms (server 326 / 335) | - |
| Transport overhead (client - server `durationMs`) p50 / p95 | - | 17.5 / 37.9 ms | p95 <= 100 ms |

The control-plane rows are stable; the two engine rows are not. The same actor read and spawn measured 104.6 ms and 41.3 ms right after a stack start with an idle editor, and 331.5 ms and 334.0 ms in the recorded run while the editor was still settling. The server's own `durationMs` tracks the client almost exactly (22 ms of overhead or less), so the control plane is not what makes those calls slow. The editor's asset/actor bookkeeping is.

What changed:

- The catalog is built once per process and served as one cached, compact JSON string. 1.5.0 rebuilt the whole document (46 tools, 349 actions, per-action policy) on *every* `GET /api/catalog` and pretty-printed it, so the same bytes were recomputed and re-indented per request.
- The catalog is prewarmed before the descriptor is written. The descriptor is the readiness signal, so a client that sees it never pays the build; `prewarm` measured 8-45 ms.
- `GET /api/health` no longer awaits a supervisor-pipe round trip on the ping path. The status is cached for 1 s and refreshed in the background (stale-while-revalidate), so a ping costs a JSON serialisation instead of a pipe round trip.
- The editor-side plugin availability probe is warmed in the background once the API is up, so the first tool call usually finds a warm probe cache instead of paying a cold supervisor round trip.
- Preludes are already read once at import (`editorPreludes`); the `preludes` phase makes that cost visible (~80-250 ms, warm file cache) instead of hiding it in the first call.

Where the remaining time goes, stated honestly: a cold start is dominated by the Node process bootstrap plus the module graph (`imports` accounted for 600-960 ms on a cold file cache and 100-180 ms once the OS has cached the ~87 dist files), not by our own registration work (`runtime` 3-5 ms, `registry` 23-38 ms, `catalog` 8-45 ms, `control-listen` 14-17 ms). The one cold-start outlier worth knowing about: the very first launch of a freshly installed `node.exe` took 1.6 s (the rest of the process was listening in 359 ms), which is antivirus paging the newly copied 90 MB binary in; every repeat run of the same packaged build landed between 415 ms and 740 ms. Deferred work stays deferred on purpose: the editor probe cannot finish before the editor exists, and `manage_editor.reload_preludes` re-reads the guard and tool scripts by design. `manage_editor.screenshot` costs ~1.8 s because this engine build cannot do an in-process viewport capture; it captures the editor window instead.

Regression: `tests/control-latency.mjs` is the repeatable measurement (`--cold`, `--calls N`, `--json <file>`, `--enforce` to fail on a budget miss). A recorded run ships as `docs/latency-1.6.0.json`.

## Catalog schema fidelity (1.6.0)

The catalog is what every AI client and the Control Panel read to decide which fields to show, so a schema that stops at the top level forces callers to guess. 1.5.0 described nested parameters only as `object` / `array` / `any`: a colour parameter arrived as a bare object, discriminated unions flattened to `any`, and records lost their value type. The panel could render a flat form but every nested value had to be typed as JSON by hand.

1.6.0 makes `/api/catalog` describe what the Zod schemas actually say, recursively:

- `ZodTuple` becomes `{ type: "array", items }` when every element describes to the same type, which is how the vector/rotator/color shorthand (`[x, y, z]`) is published with its item type instead of as an opaque array.
- `ZodObject` nesting now goes to depth 6 (was 4) and every level keeps `required`, `description`, `enum`, and its own children.
- `ZodRecord` publishes `additionalProperties` only when the value type is something other than `any`, so `record<number>` and `record<string>` are typed while `z.record(z.any())` stays a plain object.
- `ZodUnion` merges enum values, reports `variants: ["object", "array"]`, and prefers the object variant with the most declared properties. That is what turns `background_color` into an object with `r`, `g`, `b`, `a` plus an array-of-number alternative.
- `ZodDiscriminatedUnion` merges every variant's properties into one object, keeps fields unique to a single variant optional, forces the discriminator required, and publishes `discriminator`, so `manage_pie.expect` conditions list `kind`, `actor_name`, `expected`, `tolerance`, `property`, `pattern`, `text`, `regex` and `case_sensitive` in one table.

Measured on this build: 151 object parameters, 119 of them with typed properties, 59 arrays carrying an item schema, 3 typed records, maximum nesting depth 4.

The panel consumes the same metadata. A parameter with properties renders one typed row per child (`background_color.r` as a number, not a JSON blob), array parameters render per-element child rows (`conditions[0].actor_name`), and record parameters render key editors seeded from the value type with the hint `Record values are number.` Writes go through a dotted-path setter, so editing `conditions[0].case_sensitive` updates element 0 in place instead of appending a second element. Anything the panel cannot type still falls back to the JSON box with an explicit hint rather than silently dropping the field.

Regression suite: `tests/catalog-schema.mjs` asserts the nested shapes over the live API: typed colour with both variants, typed size, discriminated-union array items, at least two typed records, recursion statistics, a JSON round-trip, and materialising a subform value from metadata alone. On this build it reports 15 passed, 0 skipped, 0 failed.

`docs/TOOLS.md` is generated from the live catalog by `tests/make-tool-reference.mjs` and now prints the nested rows, the union variants and the record element types, so the shipped reference cannot drift from the server.

## API consistency (1.6.0)

1.5.0 required agents to remember which action accepted which key for the same intent. Four of those differences were real bugs rather than documentation gaps:

- Inherited function calls. `manage_object.call` resolves a function by exact name, by the `K2_` Blueprint alias in both directions (`GetActorLocation` resolves to `K2_GetActorLocation` with resolution `alias_k2`; a `K2_` request resolves with `alias_without_k2`), case-insensitively, and across the parent class chain, so an `AActor` function is callable on a `PointLight`. Near misses now come back as `code: not_found` with a `suggestions` list scored by bounded edit distance: `GetActorLocaton` previously produced no suggestion because the matcher only looked for substrings, and now lists `GetActorLocation`.
- Widget targeting. `widget_member_name` is the documented name; `widget_component_name` and `widget_name` are accepted aliases for the widget inside the blueprint on `bind_event`, `set_anchors`, `set_alignment`, `set_offsets`, `set_size`, `set_padding`, `set_slot`, `set_widget_property`, and `list_events`. Supplying two different names is an error (`widget_member_name 'A' conflicts with widget_name 'B'. widget_name is only an alias for the widget inside the blueprint; drop it or make both the same.`) instead of silently preferring one.
- Static switch writes. UE 4.27 exposes no writer for a `MaterialInstanceConstant` static switch: `UMaterialInstance` only has `GetStaticParameterValues`, and `SetStaticSwitchParameterValueEditorOnly` lives on `UMaterial`. 1.5.0 could report the parameter and then refused the write. 1.6.0 ships a small editor module, `UEVMaterial`, whose `SetMaterialInstanceStaticSwitch` / `GetMaterialInstanceStaticSwitch` / `ListMaterialInstanceStaticSwitches` set the `FStaticParameterSet` switch value plus `bOverride`, call `UpdateStaticPermutation(...)` inside an `FMaterialUpdateContext`, and return JSON. `manage_material.set_material_instance_parameter` (`parameter_type` `static_switch` / `switch` / `bool`) and the batch `static_switches` map use it; `inspect_material_instance` reports effective values in `static_switch_parameters` and override flags in `static_switch_overrides`. Without the module the action still returns an explicit "no static switch writer" refusal rather than a false success.
- `graph_name` parity. Every Blueprint graph action resolves through one helper with the aliases `event`/`eventgraph`, `construction`/`userconstructionscript`, and `anim`/`animgraph`. A bogus name used to fall back to a whole-blueprint node scan on connect/disconnect/delete (the "named" flag was only set after a successful resolve) and reported a misleading "node not found"; all graph actions now answer `Graph not found: <name>` for the same bad input, and `add_node`/`delete_node` scope to the named graph (verified on `UserConstructionScript`).

Regression suite: `tests/api-consistency.mjs` checks the inherited call, the K2 alias, the typo suggestion, all three widget alias paths plus the conflict message, the native static switch write (single and batch, with override and effective value read back), rejection of an invalid switch value, and the identical `Graph not found` answer from all five graph actions.

## Automated verification (1.6.0)

Through 1.5.0 every release was verified by ad-hoc probes whose output was read by hand: nothing failed a build, and a regression only surfaced if someone remembered to look. 1.6.0 replaces that with three suites that assert.

- Declarative matrix (`tests/matrix.mjs`). A case list of tool, action, params and expected shape or expected refusal, in groups `identity`, `catalog`, `query`, `editor`, `refusals` and an opt-in `writes` group (`--include-writes`). Expectations cover equality, regex, containment, non-emptiness and custom assertions over the parsed payload, and `{{var.path}}` interpolation carries a handle or node id from one case into the next. Write cases are preceded by a successful read so a tripped circuit breaker does not cascade.
- No-editor contract (`tests/contract-no-editor.mjs`). Runs with no editor and no control API: `--version` matches `package.json`, package name and bin aliases, the identity module (product names, the UEV-only environment contract, the `uev-supervisor` pipe, the install and state roots, and the absence of retired identity exports), env precedence and safety config in child processes, and the recorded catalog fixture (46 tools = 38 namespaces + 8 direct, 349 actions / 1911 params with a digest, discriminated-union and record schemas, handle grammar, widget aliases, action modes) plus the existing `no-unreal-smoke.mjs` stdio smoke. This is the CI subset.
- Performance (`tests/perf.mjs`). Gates warm ping p95 <= 60 ms, catalog <= 300 ms, query p95 <= 250 ms and compile <= 2 s, writes an artifact with raw samples and p50/p95/max/mean per metric, and compares against `tests/perf-baseline.json` (the 1.5.0 measurements: ping 42/64 ms, compile 49/58 ms, ...). The 60 ms ping gate is deliberately tighter than the 1.5.0 p95 of 64 ms so 1.6.0 cannot regress the control plane and still pass.

Measured on the live 1.6.0 stack: matrix 26/26 read checks and 7/7 write checks, contract 24/24, perf 4/4. Warm ping p95 was 52.8 ms (0.82x the 1.5.0 p95 of 64 ms), catalog max 20.1 ms, query p95 217 ms, compile p95 48.8 ms. Every suite exits non-zero on failure and writes `--out` JSON.

Catalog changes are pinned by a recorded fixture written by `matrix.mjs --record-fixture`; the contract suite compares the fixture header against the build, so a stale fixture fails instead of silently blessing a new catalog. `tests/fixtures/catalog-1.6.0.json` stays frozen as history and `tests/fixtures/catalog-1.7.0.json` is the fixture the suite selects (it takes the highest-versioned file). Re-record the fixture with the change that alters the catalog.

Limits of this approach, recorded rather than hidden: the matrix and perf suites are stateful and need a live editor (the fixture setup authors `/Game/UEVTests/*` on demand); latencies are wall-clock on one machine and the gates are wide enough to catch stalls, not micro-regressions; and the no-editor suite validates schemas and contracts, not engine behaviour.

## Behavior tree graph authoring (1.7.0)

Thirteen `manage_ai` actions author the graph itself: `bt_create`, `bt_inspect`, `bt_add_node`,
`bt_remove_node`, `bt_move_node`, `bt_set_node_property`, `bt_add_decorator`, `bt_remove_decorator`,
`bt_add_service`, `bt_remove_service`, `bt_set_blackboard`, `bt_compile` and `bt_repair_graph`. Each
mutation runs in one `FScopedTransaction`, locks the graph while editing (every `UAIGraphNode::AddSubNode`
calls `UpdateAsset`), re-authors the runtime tree from the graph, and returns the full id map. They need
the `UEVGraphAuthoring` module and refuse with `plugin.unavailable` when it is missing; PIE refuses.

Verified live with a 37-check suite (`bt-live-verify2.mjs`, artifact `bt-live-verification-v2.json`):
blackboards, tree creation, root composite plus appended tasks, decorator and service add/remove, id
renumbering after a structural edit, a node property with read-back (`bAllowStrafe false -> true`),
`bt_move_node` reorder, refusals for a bad id/class/property and a missing asset, blackboard re-point,
an idempotent `bt_repair_graph`, `save:false` leaving `dirty`/`saved:false`, subtree removal, the PIE
guard, and a final compile.

Measured warm (end-to-end, HTTP + dispatch + editor work): `bt_create` 101 ms, `bt_add_node` 51-65 ms,
`bt_inspect` 25-35 ms (median 34), decorator/service add 57/63 ms, `bt_set_node_property` 51-64 ms,
`bt_compile` 48-59 ms, `bt_repair_graph` 48-63 ms, `bt_set_blackboard` 49-63 ms, removals 51-58 ms.

Three defects only a live run found:

- `bt_create` reported success while the engine had no asset: a global `FindObject` matched a transient
  object of the same package name. It now resolves through the asset registry
  (`GetAssetByObjectPath`) plus `DoesPackageExist`.
- A new node without `index` landed **first** among its siblings. `UBehaviorTreeGraph::CreateBTFromGraph`
  sorts each composite's output-pin links by `NodePosX`, and a fresh node keeps `NodePosX = 0`, so it tied
  ahead of everything. Insertion now always re-stamps sibling `NodePosX` and treats an omitted index as
  append.
- `bt_repair_graph` on a linked tree could leave the saved asset with a graph root pin whose `NodeInstance` was not serialized. `CreateBehaviorTreeGraph` discards the old graph and every spawned instance is outered to that graph; the engine reparents adopted instances into the behavior tree asset, but the compiled root composite kept the graph outer and was destroyed with it. The next editor open read `RootNode->Children` through a null root and crashed (`EXCEPTION_ACCESS_VIOLATION` reading `0x70`). The fix re-homes every graph-node instance whose outer chain reaches the graph into the tree asset before the graph is dropped (`ReparentGraphInstancesIntoAsset`), and `FinishMutation` now refuses `graph_root_invalid` instead of recompiling a graph whose root pin points at a missing composite. `bt_add_node` also refuses a non-composite root. Reproduced by bisecting 17 assets: the five that ran `bt_repair_graph` reloaded with zero tree nodes; after the fix all six damaged assets reopen with their tree intact and new assets that use `bt_repair_graph` mid-sequence survive save and reload.

Ids are snapshots, not stable handles: a decorator or service consumes an execution index, so adding one
renumbers every node after it. Clients re-read the map from the response or from `bt_inspect` before
addressing a node again, the same discipline that object handles required in 1.6.

## UMG designer authoring (1.7.0)

Thirteen new `manage_widget` actions bring the surface to 38: `insert_widget`, `reparent_widget`,
`reorder_child`, `rename_widget`, `duplicate_widget`, `serialize_tree`, `set_style`, `set_brush`,
`validate_widget`, `designer_screenshot`, `list_delegates`, `list_bound_events` and `unbind_event`.
Insertion uses `UWidgetTree::InsertChildAt` and reparenting uses `ShiftChild`, so slot, padding,
anchoring and z-order are preserved and no Python-side tree surgery is needed. Deleting a widget
purges its event bindings, generated variable nodes, animations and `WidgetVariableNameToGuidMap`
entry; renaming retargets bindings. `set_style`/`set_brush` edit only the named fields instead of
replacing whole style structs. `designer_screenshot` renders the designer preview through
`FWidgetRenderer` into a render target and writes a PNG inside the project; it needs the widget
editor tab open and captures preview state, not Play In Editor.

Verified live with 36 checks (`captures/umg-live-2.mjs`), including hierarchy and slot round trips,
style/brush field isolation, binding purge on delete, and a restart that reloaded all 17 widgets.
Warm end-to-end: `widget_insert` 124.6 ms, `widget_reorder` 122.4 ms, `widget_style` 115.5 ms,
`widget_screenshot` 277.7 ms (first preview generation 204-281 ms, repeats ~60 ms).

## Blueprint authoring depth (1.7.0)

Nineteen `manage_blueprint` actions now cover the parts of a Blueprint that previously required the
editor UI: `list_graphs`, `inspect_function`, `list_macros`, `inspect_macro`,
`inspect_construction_script`, `inspect_blueprint_model`, `set_function_signature`,
`rename_function`, `delete_function`, `add_local_variable`, `update_local_variable`,
`remove_local_variable`, `create_macro_library`, `create_macro`, `set_macro_signature`,
`rename_macro`, `delete_macro`, `reset_construction_script` and `verify_blueprint`.
`create_function` grew `inputs`/`outputs`/`flags`/`meta`/`duplicate_policy`, `inspect_graph`
and `add_node` accept `graph_id`, and `add_node` instantiates macros from any macro-library asset.

Graph addressing uses `UEdGraph::GraphGuid`; ids survived a rename, a save and an editor restart
unchanged (`EventGraph 13F9662E-4C0F-D550-ECC1-ECA7A04CCB71`,
`UserConstructionScript C85BFC24-4FDF-B05C-F359-4AABC4EB816C` both re-read identically after a
restart). The same pass made every mutating blueprint action a single `FScopedTransaction` (the namespace previously opened none), with the engine-owned local-variable add deliberately excluded so
the nested transaction assertion cannot trip.

Verified live on an isolated project (`D:/Uprojects/uevNativeFresh`, asset
`/Game/UEVDepth/BP_DepthProbe`): typed function creation with inputs/outputs, four local-variable
operations (including a rename+retype with `force`), pin add/rename/retype, function rename with a
rewritten self call site, function delete with orphan reporting, a macro library with a three-parameter
macro instanced in the Blueprint, macro signature changes resynchronising the instance, macro rename,
macro delete destroying the instance in the other Blueprint and re-saving it, Construction Script node
inspection plus reset, `verify_blueprint` matching and mismatching models, and PIE refusals
(`unsafe_operation_refused`) for `create_function`, `set_function_signature`,
`reset_construction_script` and `compile`, with `verify_blueprint` degrading to
`compile_skipped`. Final compile: 0 errors, 0 warnings.

Measured warm (HTTP + dispatch + editor work): `inspect_function` 5 ms, `inspect_graph` 34 ms,
`inspect_construction_script` 27 ms, `verify_blueprint` 28 ms, `set_function_signature` 29 ms,
`reset_construction_script` 58 ms, `rename_function` 62 ms, `create_function` 34-125 ms,
`add_local_variable` 4-364 ms (first call cold), `create_macro` 40-66 ms,
`set_macro_signature` 84 ms, `rename_macro` 195 ms, `delete_macro` 99-324 ms (it also saves the
affected Blueprints), `create_macro_library` 54-141 ms.

Four defects only a live run found:

- Renaming a user-defined pin reported success but did not persist. `UK2Node::RenameUserDefinedPinImpl`
  renames only the transient `UEdGraphPin`; `UK2Node_EditablePinBase::UserDefinedPins` still held the
  old `FName`, so the trailing `ReconstructNode()` restored the old name. The editable-pin record is now
  renamed with the pin.
- `create_macro` and `set_macro_signature` never saved the macro library: the dispatch wrapper reloaded
  the target through `blueprint_name`, which macro-library calls do not carry, so the asset stayed at
  3 KB with zero graphs while the response claimed success. The wrapper now derives the target from
  `macro_library`/`library_path` and saves `affected_blueprints` explicitly.
- `delete_macro` left dangling `UK2Node_MacroInstance` nodes in other Blueprints (and then failed to
  save them), because the engine's `RemoveGraph` only scans the library that owns the graph. Instances
  are now destroyed in their own Blueprints before the graph is removed.
- `add_node` could not call a Blueprint-local function (`Function not found on Actor`): the lookup used
  the parent class only. Self-target lookups now fall back to the generated class, which is what makes
  call-site rewriting for `rename_function` reachable at all.

The Construction Script stays inspect/reset only: it is bound to the real
`AActor::UserConstructionScript`, so signature edits answer `construction_script_read_only` and every
read sets `requires_pie_verification` (the script runs on spawn and in the editor preview).

## Unified verification layer (1.7.0)

The 1.7 authoring surfaces are pinned by two suites added to the existing harness rather than by
one-off probes, and both are repeatable against any live 1.7 stack:

- **Matrix** (`tests/matrix.mjs`). Three new identity cases assert the surfaces rather than just
  their presence: exactly 13 `bt_*` actions with their read/write modes and required params, 15
  UMG designer actions (including the supervised `remove_widget`/`reparent_widget`), and 19
  blueprint depth actions with the exact parameter list clients must send. Read run: 34/34 checks.
  Write run (`--only writes --include-writes`): 11/11, covering a BT round trip (blackboard
  create/key/list, tree create with the blackboard attached, add composite/task, decorator,
  service, property read-back, move, `bt_set_blackboard`, compile, inspect, root-token
  refusals), a blueprint depth round trip (function create/inspect/signature/local variable, macro
  library + macro create/signature/rename/verify, cleanup), and the PIE refusal lane.
- **PIE refusal lane**. `start_pie`/`stop_pie` are async (`transition_pending`), so the case polls
  `manage_editor.is_pie_running`. During PIE it asserts `create_function`,
  `set_function_signature` (on a real function; the Construction Script answers its own
  `construction_script_read_only` first), and `bt_create` all refuse with
  `error.code = unsafe_operation_refused` and `guard = pie-editor-mutation`, then stops PIE and
  removes its probe function. `verify_blueprint` degrades to `compile_skipped` with `match: true`.
- **Clean-break negatives**. `refusals.clean-break-removed-surfaces` asserts the five 1.6
  namespaces removed in 1.7 answer HTTP 404 `Unknown tool` (`manage_behavior_tree`,
  `manage_level_structure`, `manage_environment`, `manage_animation_physics`, `manage_ai_debug`)
  while `manage_vite.screenshot` answers 200 with `success: false` because only the action moved to
  `manage_editor.screenshot`.
- **Authoring perf** (`tests/perf/authoring.mjs`). Measures BT, UMG and blueprint operations through
  the same HTTP dispatch a client uses, records p50/p95/max/mean per metric, and fails the run when
  a p95 exceeds `budgetMs` in `tests/perf/perf-baseline-1.7.0.json`. It refuses to run while PIE is
  active or when the warm ping p50 is above 150 ms (a backgrounded editor invalidates budgets).

Measured on the isolated 4.27.2 project (`D:/Uprojects/uevNativeFresh`, `UEV` 1.7.0, server
2026.11.6-1), warm, end-to-end HTTP + dispatch + editor work:

| Metric | p50 | p95 | Budget (p95) |
| --- | --- | --- | --- |
| `bt_create` | 62.3 ms | 73.7 ms | 1500 ms |
| `bt_add_node` | 124.0 ms | 133.9 ms | 600 ms |
| `bt_inspect` | 32.7 ms | 40.4 ms | 600 ms |
| `bt_compile` | 49.5 ms | 66.1 ms | 600 ms |
| `widget_insert` | 109.5 ms | 124.6 ms | 600 ms |
| `widget_reorder` | 109.8 ms | 122.4 ms | 600 ms |
| `widget_style` | 106.7 ms | 115.5 ms | 600 ms |
| `widget_screenshot` (640 px) | 80.5 ms | 277.7 ms | 3000 ms |
| `blueprint_create_function` | 77.9 ms | 85.0 ms | 1500 ms |
| `blueprint_add_node` | 126.8 ms | 132.5 ms | 600 ms |
| `blueprint_compile` | 51.9 ms | 55.2 ms | 600 ms |
| `blueprint_verify` | 45.2 ms | 56.1 ms | 600 ms |

Budgets are `ceil(max(p95 * 2.5, floor) / 100) * 100` with a 600 ms floor (1500 ms for asset
creation, 3000 ms for preview screenshots). The floor dominates the fast calls on purpose: the gate
is there to catch a multi-x regression or a stall on a noisy CI editor, not to police a few
milliseconds of scheduling noise. The measured numbers sit 1.5-8x below their budgets. The first
`widget_screenshot` sample pays preview generation (204-281 ms) while repeats are ~60 ms, which is
why its p95 is the widest ratio.

The unattended runner (`tests/run-matrix.mjs`, `npm run test:unattended`) executes the read matrix,
the write matrix, the control-plane gates and the authoring budgets, and writes a timestamped
directory under `tests/artifacts/<ISO time>/` with each step's JSON plus a `summary.md` table. It
exits non-zero if any step fails. Recorded run `2026-11-06T09-34-12-193Z`: matrix-read 34/34,
matrix-writes 11/11, perf (control plane) 4/4 (warm ping p95 50.7 ms, catalog max 17.0 ms, query p95 85.3 ms,
compile max 53.4 ms), perf-authoring 13/13. Offline checks before it: `npm run typecheck`, `test:no-unreal`
(build + 14 smoke checks) and `test:contract` 24/24.

`packaging/product/docs/testing.md` documents the new suites, the budget formula, the live-editor
requirement and the screenshot output rule (`designer_screenshot` only writes inside the project,
defaulting to `Saved/UEV/Screenshots`).
## Identity finish (1.7.0)

1.7.0 is UEV everywhere the user can see or script it:

- `productVersion` is **1.7.0** (server `2026.11.6-1`, protocol `2`) in `/api/health`, the control descriptor, the control panel About surface, `manifest.json` and the installer's fallback constant. Release automation asserts the version banner, the surface sentence and the counts in README/FINDINGS against the live catalog before it will build a zip.
- The supervisor is **`UEVSupervisor.exe`**: C# assembly, namespace, installer registration, stack-manager lookup, run scripts and docs. It is the only supervisor binary the package ships or registers, and it serves exactly one pipe, `uev-supervisor`.
- Project runtime state lives in **`Saved\UEV`** and per-user state in **`~/.uev`**; the installer reads and writes those paths only and records them in the install manifest.
- `-Uninstall` removes the install root, the control descriptor, project data (`Saved\UEV`), per-user state (`~/.uev`) and backups. The installer never creates shortcuts, services, firewall rules, scheduled tasks or registry run keys, so there is nothing else to clean up.
- Packaging names are `uev-mcp-1.7.0-release` (tree) and `uev-1.7.0.zip` (artifact). The 1.6.0 catalog fixture is kept frozen; the contract suite runs against the 1.7.0 fixture.

## Remaining limitations

