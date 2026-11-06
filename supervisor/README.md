# UEV Supervisor

A standalone Windows Job Object watchdog for the UEV MCP server and the Unreal Editor.

It launches the editor suspended, assigns it to a Job Object, resumes it, and watches MCP calls over a named pipe. If a call exceeds its timeout or the supervisor receives a panic, it terminates the whole job tree. `KILL_ON_JOB_CLOSE` is enabled, so closing or killing the supervisor also terminates the editor and its child processes.

## Build

```powershell
dotnet build -c Release
```

`global.json` pins the .NET 9 SDK. `NuGet.config` clears a missing Visual Studio NuGet fallback folder that breaks the .NET 10 SDK on this machine.

Output: `bin\Release\net9.0\UEVSupervisor.exe`

## Run

Use `run-supervisor.bat`, or run the executable directly:

```powershell
.\bin\Release\net9.0\UEVSupervisor.exe `
  --editor "D:\UE-ViteFork\Engine\Binaries\Win64\UE4Editor.exe" `
  --project "D:\Uprojects\ViteMCPTest\ViteMCPTest.uproject" `
  --pipe "uev-supervisor"
```

Defaults:

| Setting | Default |
|---|---|
| Per-process memory | 20,480 MB |
| Whole-job memory | 28,672 MB |
| Active processes | 128 |
| Call grace | 5,000 ms |
| Heartbeat timeout | 30,000 ms |
| Kill on close | enabled |

The supervisor refuses to launch if `UE4Editor` is already running. Close the editor first.

## MCP server environment

The MCP server connects to the supervisor automatically on the default pipe. Set these when launching the MCP client:

```text
UEV_SUPERVISOR_PIPE=\\.\pipe\uev-supervisor
UEV_BIND_ADDRESS=127.0.0.1
UEV_COMMAND_ADDRESS=127.0.0.1
UEV_MULTICAST_TTL=0
```

To disable the supervisor client entirely: `UEV_SUPERVISOR=0`.

## Protocol

Newline-delimited JSON over `\\.\pipe\uev-supervisor`, which is the only pipe 1.7.0 listens on.

```json
{"type":"call_start","id":"uuid","tool":"manage_editor","action":"run_python","timeoutMs":120000}
{"type":"call_end","id":"uuid"}
{"type":"heartbeat"}
{"type":"panic","reason":"manual"}
{"type":"status"}
```

The supervisor adds its grace period to the MCP timeout. If `call_end` does not arrive within `timeoutMs + graceMs`, or heartbeats stop while calls are active, it terminates the job tree.

## Panic

- Type `panic` in the supervisor console.
- Run `panic.bat`.

`panic.bat` tries the named pipe first. If the pipe is busy because the MCP client is connected, it terminates the supervisor process; `KILL_ON_JOB_CLOSE` then kills the editor and its workers.

## Validation performed

- **Dummy child timeout:** `ping` child, 2,000 ms call timeout, 1,000 ms grace. Supervisor killed the child at 2s + 1s and exited with code 2.
- **Live visual test:** supervised camera move, visible cube spawn, screenshot, actor-list verification, `manage_actor.delete`, final list verification, and supervised Python. All calls had matching `call_start`/`call_end`; no kill.
- **Live freeze test:** an infinite Python loop in the editor. Supervisor killed the editor at 2s + 5s grace; supervisor and editor both exited; the OS stayed responsive.

Screenshots from the visual test are in `../captures/visual-check-1.png` and `../captures/visual-check-2.png`.

## Limitations

- This is a console app, not yet a Windows service. Run it as a user that the agent cannot control, or install it as a service for unattended use.
- If the agent runs as an administrator, it can kill the supervisor. The OS boundary is still required.
- A GPU/driver or kernel hang is outside the watchdog's guarantee. A VM or second machine is the only hard boundary for that class of failure.
- The supervisor protects against process-level failures and runaway Python; it cannot save unsaved editor work.
