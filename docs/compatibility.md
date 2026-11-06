# Compatibility

- Unreal Engine: UE 4.27.x. Other versions require `-AllowUnsupportedEngine` and have not been tested with this Python action catalog or native editor code.
- Engine fork: the [Unreal Engine Vite fork](https://vitestudio-tech.github.io/UnrealEngineVite-Docs/default-topic.html) of 4.27.2 is the reference build. Its renderer (dynamic and static DDGI, ray-traced reflections, SSGI) and PhysX are what `manage_vite`, `manage_ddgi`, `manage_lighting` and `manage_physics` are written against; on stock 4.27 those actions report what they cannot find instead of failing.
- Platform: Windows. The supervisor and named-pipe/job-object lifecycle are Windows-specific.
- Project: C++-capable; the source native plugins need a project editor target and UBT.
- Node: bundled Windows runtime; no system Node install is required.
- .NET: not required for the self-contained supervisor; if a package was built framework-dependent, the installer preflights the .NET 9 runtime.
- Python: UE's `PythonScriptPlugin`, no system Python.
- Live Coding: available only when the engine has the LiveCoding module and console; header/class-layout changes still require a full build.
- BuildId: recorded for diagnostics. Native plugins are built from source; prebuilt plugin DLLs are intentionally not shipped.
