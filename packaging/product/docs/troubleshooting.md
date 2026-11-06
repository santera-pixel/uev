# Troubleshooting

## PythonScriptPlugin is missing

The installer found no `Engine\Plugins\Experimental\PythonScriptPlugin\PythonScriptPlugin.uplugin`. Restore the plugin in the engine, or point `-Engine` at the correct UE 4.27 installation. Installing Python separately does not help.

## Python is enabled but editor calls time out

Check that `Config\DefaultEngine.ini` contains the loopback remote-execution section, restart the editor, and confirm the plugin is enabled in the editor's Plugins window. The MCP server uses UE Python remote execution, not a pip package.

## Live Coding is disabled or unavailable

If enabled is selected, the installer writes `bEnabled=True` to `Config\DefaultEditorPerProjectUserSettings.ini`; restart the editor. If the engine has no `UE4Editor-LiveCoding.dll` or `LiveCodingConsole.exe`, use a full project build. Live Coding cannot add new UCLASSes, headers, or class layouts.

## Native plugins do not load

The project must be C++-capable and the build must succeed. Close the editor, run the build manually, and inspect the log under `<Project>\Saved\UEV\install.log`. Source plugins are compiled against the project's engine; a BuildId warning is diagnostic, not a substitute for examining the build output.

## `UE4Editor is already running`

Close the editor (and any PIE session) before installing, updating, uninstalling, or rebuilding. The installer does not terminate the editor.

## Client cannot connect

Start the installed launcher first. Confirm the control API descriptor exists at `%LOCALAPPDATA%\UEV\control.json` and the supervisor/control API logs under `%LOCALAPPDATA%\UEV\logs`. Merge `Saved\UEV\mcp-client.json` into your client; do not copy the placeholder template path.

## Control panel is online, but the AI client has no Unreal tools

The server is running; the client is not registered. Writing `Saved\UEV\mcp-client.json` does not add it to a client.

For Command Code, run the installer with `-RegisterCommandCode` (or merge the config into `%USERPROFILE%\.commandcode\mcp.json`), then verify with `cmdc mcp list` and reload Command Code with `/mcp` or a restart. A running session keeps its old tool list until it reconnects.

## Tool rejects parameters with "expected object, received string"

The `params` field must be a JSON object, not a JSON-encoded string. Send:

```json
{"action":"read_source","params":{"path":"Source/MyGame/MyGameCharacter.cpp"}}
```

not:

```json
{"action":"read_source","params":"{\"path\":\"Source/MyGame/MyGameCharacter.cpp\"}"}
```

Nested objects and arrays must also be real values, not strings. The server now accepts a valid JSON string as a compatibility fallback, but object form is the supported shape.

## A nested parameter only shows a JSON box

That is the fallback, not a failure. The form renders typed child rows whenever the catalog describes them: an object parameter expands into its properties (`background_color` gives `r`, `g`, `b`, `a`), an array parameter gives per-element rows under `conditions[0]`, and a record parameter gives a key editor plus one typed row per key. If a field still shows a "Nested <type>" message pointing at the JSON box, the server published no schema for it, so edit the JSON directly, or expand the parent parameter and use its child rows.

Record parameters are typed in 1.6.0: `scalars` on `manage_material.set_material_instance_parameters` shows "Record values are number." and the "New key name" editor creates a number row, while `textures` shows "Record values are string." A record whose value type is `any` still accepts free-form values.

## A static switch write is refused

`set_material_instance_parameter` with `parameter_type: static_switch` (or `switch`/`bool`) needs the `UEVMaterial` editor module, because UE 4.27 exposes no Blueprint writer for a `MaterialInstanceConstant` static switch. When the module is missing the call fails with "This engine exposes no static switch writer for material instances; the UEVMaterial native module is required." Rebuild the native plugins (`Build.bat <Project>Editor Win64 Development -Project=<project>.uproject`) and confirm `unreal.UEVMaterialLibrary` exists in Python. The switch name must exist on the instance or its parent material, and values are `true`/`false` (`1`/`0`, `yes`/`no`, `on`/`off`, `enabled`/`disabled` also work).

## A graph action reports a missing node

A `graph_name` that does not resolve is an error on every graph action: `Graph not found: <name>`. Call `inspect_graph` with the same `graph_name` to list the usable node ids. The aliases `event`/`eventgraph`, `construction`/`userconstructionscript` and `anim`/`animgraph` are accepted; anything else is matched case-insensitively against the blueprint graph names. Node ids are scoped to the named graph, so an id captured from another graph no longer matches.

## A tool returns `unsafe_operation_refused`

This is a crash guard, not a bug. Read `error.guard` to know which one:

- `protected-content`: the path is `/Game` itself or under `/Engine`, `/Script`, `/Config`, or `/Intermediate`. Target a real asset under `/Game/<folder>`; engine content is never deletable.
- `pie-editor-mutation`: Play In Editor is running. Stop PIE (`manage_pie.stop_pie`), then retry.
- `loaded-asset-delete`: a loaded asset's tab could not be closed or saved, so the delete was refused. Close the asset editor and retry.
- `unplaceable-blueprint`: the blueprint's class cannot be placed (controller, game mode, abstract). Spawn a placeable Actor blueprint instead.

`UEV_ALLOW_UNSAFE_OPERATIONS=1` disables the destructive guards for the session. Set it only when you have a backup and a reason.

## The editor disappeared and came back by itself

That is the supervisor watchdog. It logs `watchdog: crash detected (child exit=<code>)`, the newest `Saved/Crashes/UE4CC-*` report, and restarts the editor. Look at the crash report path in `%LOCALAPPDATA%\UEV\logs\supervisor-*.log` for the assertion. After `--max-restarts` (default 3) restarts inside `--restart-window-seconds` (default 600) the supervisor stops restarting and exits with the reason. Start the stack with `--no-restart` when you need a crash to stay dead for investigation.

## A handle no longer resolves

Query results carry a stable handle `uev:<kind>:<object path>` and the numeric `native_handle` `obj_<n>`. A `uev:` handle resolves by path, so it survives `release_handles`, PIE transitions, and editor restarts; it stops resolving only when the object was deleted or renamed (an actor rename, or a moved asset). `handle_stale` means exactly that. Re-run the query for a fresh handle. The numeric `obj_N` handle is a positional index into the native registry: once the registry is cleared (release, PIE start/stop, restart) the same number can name a different object, and 1.6.0 refuses it instead of retargeting. Store the `uev:` handle, not `obj_N`.

## The editor came back but every tool times out

Two things after a crash-restart look like this:

- **Restore Packages.** If the editor crashed, it can come back to the "Restore Packages" dialog before the project loads. The window title is literally `Restore Packages`, the Python remote-execution node never registers, and every call fails with `Timed out: Could not find a node within the given time.`. Click **Skip Restore** (or delete the stale `<Project>\Saved\Autosaves\*` files before starting). The control API and the supervisor are healthy; the editor is just waiting on a modal.
- **Windows Firewall.** A new install root is a new `node.exe` path, so Windows prompts once with "Do you want to allow public and private networks to access this app? Node.js JavaScript Runtime". Until it is allowed, the supervisor can start the server but the control plane stays unreachable. Allow it (private networks is enough), and note that an upgrade from 1.5.0 therefore shows the prompt again even though the product looks already installed.

## Guard or tool script changes have no effect

The editor preludes are read once at server start. After editing `server/editor/scripts/ue_*` (or mirroring a new `dist`), either restart the stack or call `manage_editor.reload_preludes`; it reports which files changed per domain. Changes to a tool's own script body are picked up on the next call.

## The first request after a restart is slow

The first ping after the control server starts pays the Node bootstrap and module graph (about 0.4 s with a warm file cache, about 1.1 s cold on this machine). The catalog is built before the descriptor is written, so a client that waits for the descriptor does not pay it, and `GET /api/health` returns a `startup` object with the per-phase timings (`preludes`, `imports`, `runtime`, `registry`, `catalog`, `prewarm`, `control-listen`, `editor-probe`). The same line is logged as `UEV startup: ...; elapsed=<ms>ms` in `%LOCALAPPDATA%\UEV\logs\control-api.log`. If a warm ping still exceeds the 60 ms budget, run `node tests/control-latency.mjs --enforce` and look at `startup.phases` before changing anything.

## A tool call reports `plugin.probe_failed`

Before running an action that needs an MCP editor plugin, the server asks the editor whether the plugin is loaded. That probe fails while the editor is still loading or while remote execution has not bound yet. 1.6.0 warms the probe in the background as soon as the API is online, and a successful probe is cached for 30 seconds; a failed one is retried on the next call. Wait for the editor to finish loading the project, then retry. If it never succeeds, check that `UEVNative` and `UEVControlPanel` compiled for this engine build (see "Native plugins do not load").

## Uninstall leaves files

Modified plugin source or changed config values are intentionally preserved. Use `-Force` only after checking the backup under `<Project>\Saved\UEV\backups`.
