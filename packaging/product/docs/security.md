# Security

- The control API binds only to `127.0.0.1`, requires a per-process bearer token, rejects requests with an `Origin` header, and limits request bodies.
- The control descriptor lives in `%LOCALAPPDATA%\UEV\control.json` with user-only permissions where supported.
- The MCP server runs with the user's normal permissions; the installer does not install a service or request elevation.
- Python remote execution is configured for loopback and multicast TTL 0. Do not expose it to untrusted networks.
- The supervisor owns the editor process through a Windows Job Object so the editor and child processes can be terminated together.
- The default server profile is selectable. `unattended` is read-only; `supervised` permits writes subject to the MCP safety gateway.
- The installer backs up configuration and writes only managed files. Uninstall refuses to delete modified managed plugin sources without `-Force`.
- Crash guards refuse destructive operations before the engine is touched and report `error.code: "unsafe_operation_refused"`: deleting protected content (`/Game` root, `/Engine`, `/Script`, `/Config`, `/Intermediate`), and mutating the editor world while Play In Editor is running. `UEV_ALLOW_UNSAFE_OPERATIONS=1` disables the destructive guards for a deliberate, backed-up session.
- The supervisor restarts the editor and the control plane after an unexpected exit (default: 3 restarts per 10 minutes, 5 s delay) and records the newest `Saved/Crashes/UE4CC-*` report path plus its assertion text. `--no-restart` disables this; a normal editor exit is never restarted. Crash reports are not uploaded anywhere and stay under the project's `Saved/Crashes`.
- The package does not redistribute Unreal Engine or Epic Games plugin binaries.
