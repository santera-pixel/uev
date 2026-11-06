# Safety fork

This fork adds a default-deny safety layer around the stock MCP server. It is designed for read-only inspection by default and deliberate, supervised writes.

## What changed

- Every direct tool and every namespace action goes through a safety gateway.
- Actions are classified `read`, `write`, `supervised`, or `blocked`.
- Unknown tools and unknown actions are blocked.
- The default profile is `unattended`: only `read` actions run.
- `run_python` and raw `console_command` are `supervised`-only.
- Mutating actions are never retried automatically.
- Every call is written to an audit log.
- Per-call timeouts return a structured error and open a circuit breaker after repeated failures.
- Guarded calls send `call_start`, `call_end`, and heartbeats to the supervisor over a named pipe. The supervisor hard-kills the editor job if a call exceeds its timeout plus grace.

## Profiles

| Profile | Behavior |
|---|---|
| `unattended` (default) | Read-only actions. Writes and `run_python` are blocked. |
| `supervised` | All allowlisted reads and writes, including `run_python` and console commands. |

Set the profile with `UEV_PROFILE`. An unrecognized value falls back to `unattended`.

`UEV_READ_ONLY=1` blocks every non-read action even in the `supervised` profile.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `UEV_PROFILE` | `unattended` | `unattended` or `supervised` |
| `UEV_READ_ONLY` | off | `1`, `true`, or `yes` blocks all writes |
| `UEV_ALLOWLIST` | built-in | Absolute path to a JSON allowlist override |
| `UEV_AUDIT_LOG` | `~/.uev/audit.jsonl` | JSONL audit log path |
| `UEV_SUPERVISOR` | on | `0`, `false`, or `off` disables the supervisor client |
| `UEV_SUPERVISOR_PIPE` | `\\.\pipe\uev-supervisor` | Named pipe path |

## Supervisor

The safety gateway is soft protection: a Node timeout stops waiting, not the editor-side script. The separate `UEVSupervisor` is the hard boundary. It launches the editor inside a Windows Job Object, receives guarded-call events on a named pipe, and terminates the whole job tree if a call exceeds `timeout + grace` or a panic is requested. If the supervisor is not running, the gateway still applies its own timeout, validation, allowlist, and audit log.

## Allowlist

The built-in allowlist is in `server/safety/default-allowlist.ts`. It covers the stock tool surface and classifies each action. The default is:

- `read` for inspection, listing, searching, project/map info, screenshots, and console-variable reads.
- `write` for creates, deletes, transforms, imports, saves, and builds.
- `supervised` for `run_python` and raw console commands.
- `blocked` for anything not listed.

An override is merged over the default, so you only specify what you want to change. See `config/allowlist.example.json`.

```json
{
  "tools": {
    "manage_editor": {
      "actions": {
        "get_console_variable": { "mode": "read", "timeoutMs": 5000 }
      }
    }
  },
  "limits": {
    "defaultCallTimeoutMs": 45000
  }
}
```

Changing an action to `read` makes it available in `unattended` mode. Do that only for genuinely non-mutating actions.

## Audit log

Each call appends one JSON line:

```json
{
  "timestamp": "2026-10-20T05:50:00.000Z",
  "tool": "manage_editor",
  "action": "project_info",
  "profile": "unattended",
  "mode": "read",
  "status": "success",
  "durationMs": 42,
  "argsBytes": 2,
  "argsHash": "f1a2..."
}
```

Full arguments are not logged. Only a SHA-256 prefix and byte count are recorded.

## Timeouts and circuit breaker

- Each action has a timeout, defaulting to 30 seconds. Long operations such as PIE and validation get 120 seconds.
- A timeout returns `{"success": false, "code": "safety.timeout", "state": "degraded"}`.
- A timeout marks the session degraded and blocks mutating actions.
- Three consecutive failures also open the circuit.
- A successful read resets the circuit.

## Retry policy

The upstream server retried a failed command once. That can duplicate a destructive action. This fork retries only read actions, and only when the safety gateway marks the call as retryable. Writes and supervised actions never retry automatically.

## Important limitations

- **A timeout does not stop the editor-side Python call.** It stops waiting. A runaway script can still block the editor until the process is killed. This is a Python Remote Execution limitation.
- **The allowlist only governs the MCP server.** It does not govern the agent's file, shell, or editor process access. Use OS-level isolation for unattended agents.
- **`run_python` is arbitrary code execution.** Keep it in the supervised profile.
- **A bad Live Coding patch or native API call can still crash the editor.** The safety layer reduces input risk; it does not make Unreal crash-proof.

For unattended work, pair this with the isolation model in `../05-isolation-and-recovery.md`: a dedicated OS user, ACLs, a Job Object supervisor, and a disposable project. The allowlist is necessary, not sufficient.
