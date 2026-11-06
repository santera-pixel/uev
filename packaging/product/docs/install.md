# Install details

## Engine

The installer accepts Unreal Engine 4.27.x. UEV is built and tested against the
[Vite fork](https://vitestudio-tech.github.io/UnrealEngineVite-Docs/default-topic.html) of 4.27.2. The
renderer and PhysX paths behind `manage_vite`, `manage_ddgi`, `manage_lighting` and `manage_physics`
expect it. Any other engine version needs
`-AllowUnsupportedEngine` and sits outside the tested surface.

## Interactive contract

`install.bat` calls `install.ps1`. When required paths are missing it prompts for them, then shows the component menu. Components are toggled by number; `Enter` reviews and installs; `Q` cancels at the menu. Recommendations are selected by default. The bundled Node runtime is copied to `%LOCALAPPDATA%\UEV\node` and is used by the generated launchers and client config; no system Node install is required.

The menu reports:

- Python status: missing, disabled, enabled without remote execution, or ready.
- Live Coding status: unavailable, available but disabled, or enabled.
- `EditorScriptingUtilities` source availability.
- Optional engine integrations.
- The current security profile.

## Flags

`-Project`, `-Engine`, `-InstallRoot`, `-Profile`, `-Components`, `-EnablePython`, `-NoPython`, `-ContinueWithoutPython`, `-EnableLiveCoding`, `-NoLiveCoding`, `-WithPanel`, `-NoPanel`, `-WithSupervisor`, `-NoSupervisor`, `-NoBuild`, `-NoClientConfig`, `-RegisterCommandCode`, `-DryRun`, `-Force`, `-Update`, `-Uninstall`, `-Verify`, `-ClientConfig`, `-NonInteractive`, `-Yes`, `-Json`, `-LogPath`, `-AllowUnsupportedEngine`, `-Extras`, `-NoExtras`, `-DebloatRoot`.

## What the installer does

1. Resolves the project and engine.
2. Refuses to continue while `UE4Editor` is running.
3. Checks for a C++ project target and Node.js 18+.
4. Backs up `.uproject`, `DefaultEngine.ini`, `DefaultEditorPerProjectUserSettings.ini`, and any existing install manifest.
5. Installs the server and supervisor under `%LOCALAPPDATA%\UEV`.
6. Copies source-only native plugins into `<Project>\Plugins`.
7. Merges plugin entries and loopback Python remote-execution settings.
8. Optionally writes the Live Coding project setting.
9. Builds the project editor target and verifies the plugin binaries.
10. Writes a per-project launcher, MCP client config recipe, and install manifest.
11. With `-RegisterCommandCode`, merges the server entry into `%USERPROFILE%\.commandcode\mcp.json` with a backup. `-Client <id>` does the same for any harness in the built-in table (see below).

## Client registration is a separate step

`mcp-client.json` is not registration. It is a JSON recipe that must be loaded by the AI client. The installer cannot make an arbitrary AI client discover it automatically.

For Command Code:

```powershell
.\install.ps1 -Project "C:\Projects\MyGame\MyGame.uproject" -RegisterCommandCode -Update -Yes
cmdc mcp list
```

Then restart Command Code or open `/mcp`. The entry is `uev`; tools are named `mcp__uev__<tool>`. Without this step, the control panel can report online while the AI client sees no Unreal tools.

For every other harness the installer carries a table of 20 targets. `-ListClients` prints it; `-Client <id> -ClientScope user|project` writes or merges the JSON config (backup first, other servers preserved, malformed JSON refused); `install.bat` with no arguments asks interactively. Targets whose config is TOML, YAML or app-managed print the exact snippet instead. `-Client deepseek-harness` explains the dsh-mcp-manager plugin path.

## Python

UE's Python Editor Script Plugin is an engine plugin with `EnabledByDefault=false`. The installer does not install Python. It adds a project plugin entry and writes:

```ini
[/Script/PythonScriptPlugin.PythonScriptPluginSettings]
bRemoteExecution=True
RemoteExecutionMulticastBindAddress=127.0.0.1
RemoteExecutionMulticastTtl=0
```

If the plugin is missing from the engine, restore the engine plugin or point `-Engine` at the correct engine. `pip install` is not a solution.

## Live Coding

Live Coding is an engine module, not a marketplace plugin. The installer checks `Engine\Binaries\Win64\UE4Editor-LiveCoding.dll` and `Engine\Binaries\Win64\LiveCodingConsole.exe`.

When selected, it writes:

```ini
[/Script/LiveCoding.LiveCodingSettings]
bEnabled=True
Startup=Manual
```

to `Config\DefaultEditorPerProjectUserSettings.ini`. Restart the editor. Live Coding is limited to compatible function-body changes; new UCLASSes, headers, and class layouts need a full project build.

## Uninstall

`uninstall.bat` reads the manifest, removes only managed plugin directories whose source hash is unchanged, restores only plugin entries and ini values that still match the installer's values, and removes the generated launcher/config. Backups stay under `<Project>\Saved\UEV\backups` for manual recovery. The shared `%LOCALAPPDATA%\UEV` runtime and the per-user `~/.uev` journals are kept by default because another install may still use them; add `-PurgeUserState` to remove them too.
