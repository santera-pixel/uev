# Testing UEV

UEV ships a test suite instead of a pile of one-off probes. Everything lives in
`tests/` next to the installer and needs nothing beyond Node.js 18+ (the
same runtime the package bundles).

| Suite | File | Needs a live editor | Runtime |
| --- | --- | --- | --- |
| Declarative matrix | `tests/matrix.mjs` | yes | ~10 s read-only, ~20 s with writes |
| No-editor contract | `tests/contract-no-editor.mjs` | no | ~15 s |
| Performance | `tests/perf.mjs` | yes | ~15 s |
| Authoring perf (1.7) | `tests/perf/authoring.mjs` | yes | ~60-90 s |
| Unattended run | `tests/run-matrix.mjs` | yes | ~2 min |
| Tool reference generator | `tests/make-tool-reference.mjs` | yes | ~2 s |

Targeted regression suites from earlier 1.6 work are still in `tests/` and can be run
directly when a card touches that area: `identity-1.7.mjs`, `stable-handles.mjs`,
`catalog-schema.mjs`, `api-consistency.mjs`, `control-latency.mjs`, `crash-guards.mjs`.

## Run them

From the package root:

```powershell
cd tests
npm run test:contract        # no editor, safe in CI
npm run test:matrix          # read-only matrix against the running stack
npm run test:matrix:writes   # matrix including the write cases
npm run test:perf            # latency thresholds + artifact
npm run test:perf:authoring  # 1.7 BT / UMG / blueprint p50-p95 budgets
npm run test:unattended      # all matrix + perf steps, timestamped artifacts
npm test                     # contract + matrix writes + both perf suites
```

From the authoring repo the same suites are wired into `mcp-fork/package.json`:

```powershell
cd mcp-fork
npm run test:contract
npm run test:matrix
npm run test:perf
npm run test:perf:authoring
npm run test:unattended
```

Every suite resolves the control descriptor itself (`%LOCALAPPDATA%\UEV\control.json`). Override
with `--descriptor <path>`, `--port <n>` or `--token <token>`.

## Matrix suite

`tests/matrix.mjs` is a declarative list of cases: tool, action, params, expected
shape or expected refusal, with asserted outcomes, so a wrong answer fails the run
instead of being eyeballed. Groups: `identity`, `catalog`, `query`, `editor`, `refusals`, `writes`.

```powershell
node matrix.mjs --only refusals --out refusals.json
node matrix.mjs --case editor.project-info
node matrix.mjs --include-writes --out matrix-results.json
```

Write cases are skipped unless `--include-writes` (or `--only writes`) is passed. Before each
write the runner issues a read so a tripped supervised circuit breaker does not cascade
into unrelated failures.

The suite authors its own fixtures under `/Game/UEVTests` on first use:
`M_UEV_SwitchFixture` (a material with the `UEVSwitch` static switch), `MI_UEV_SwitchFixture`,
`BP_UEVMatrixProbe` (parent class `Actor`), `WBP_UEVApiWidget` with a `UEVButton`. Deleting those
assets only costs one fixture-setup call on the next run.

The 1.7 surfaces are covered by capability family, not by individual action:

- `identity.catalog-behavior-tree-surface`: exactly 13 `bt_*` actions, their read/write modes and
  required parameters. `identity.catalog-blueprint-depth-surface`: the 19 function/macro/local
  variable/Construction Script actions inside `manage_blueprint` (38 actions); the widget designer
  case now expects all 15 designer actions including the supervised `remove_widget` and
  `reparent_widget`.
- `writes.bt-graph-roundtrip`: creates a blackboard, adds a key and lists it, creates a tree with a
  root composite attached to that blackboard, adds a service, a Wait task, a property, a decorator
  and a second composite, moves the task between composites, repoints the blackboard with
  `bt_set_blackboard`, compiles and inspects, and asserts the documented refusals for removing/moving
  the root and for an unknown node id, then deletes the tree and blackboards.
- `writes.blueprint-depth-roundtrip`: creates a function, inspects and extends its signature, adds
  and removes a local variable, creates a macro library plus macro, inspects it, extends the macro
  signature, renames it, runs `verify_blueprint`, deletes the macro and the library.
- `writes.pie-blueprint-refusal`: starts PIE, asserts `manage_blueprint.create_function`,
  `set_function_signature` and `manage_ai.bt_create` are refused with
  `error.code = unsafe_operation_refused` and guard `pie-editor-mutation`, then stops PIE. This case
  needs a foreground editor and a working map; it is part of the write run, so `--only writes` covers it.
- `refusals.blueprint-construction-signature`, `refusals.blueprint-invalid-params`,
  `refusals.bt-create-outside-game`, `refusals.bt-missing-asset` and
  `refusals.clean-break-removed-surfaces` (the five removed 1.7 namespaces plus
  `manage_vite.screenshot` must answer HTTP 404 "Unknown tool") pin the failure modes.

## No-editor contract suite

`tests/contract-no-editor.mjs` needs no editor and no control API. It checks:

- the built server's `--version` matches `package.json` (catches a stale `dist`);
- package identity: name `uev` and the `uev` bin entry;
- the identity module: `UEV` product name, the `UEV_`-only env contract, the single
  `uev-supervisor` pipe and the `UEV_SUPERVISOR_PIPE` override;
- env isolation in child processes: only `UEV_*` is read, an unprefixed variable is ignored, defaults apply;
- safety config: `UEV_PROFILE` applies and `UEV_READ_ONLY=1` is honoured;
- the recorded catalog fixture: identity header, 45 tools (38 namespaces + 7 direct),
  393 actions and their params with a digest, action shape, the discriminated-union
  `pie_expect.conditions` schema, the `scalars` record and `static_switches` schema, the stable
  handle grammar, widget alias params and action modes;
- fixture version agreement with the build, so an old fixture cannot silently bless a
  new server;
- `mcp-fork/scripts/no-unreal-smoke.mjs` when it is present, which exercises the MCP stdio
  surface (tool count, namespace schemas, refusal envelopes).

This is the CI subset: it runs on a machine with no Unreal install at all.

## Performance suite

`tests/perf.mjs` times the paths that regressions show up in first and gates them:

| Metric | Gate | 1.5.0 baseline (median/p95) |
| --- | --- | --- |
| Warm ping (`manage_editor.is_pie_running`) | p95 <= 60 ms | 42 / 64 ms |
| Catalog (`GET /api/catalog`) | max <= 300 ms | not measured |
| Query (`manage_query.query` class=PointLight) | p95 <= 250 ms | 42 / 55 ms (`blueprint.read`) |
| Compile (`manage_blueprint.compile`) | max <= 2000 ms | 49 / 58 ms |

The 60 ms ping gate is deliberately tighter than the 1.5.0 p95 of 64 ms: 1.6 must at
least match 1.5.0 on a warm path, and the control-plane work in 1.6 is expected to
beat it. Raise a gate only with a recorded reason: the thresholds live in
`tests/perf-baseline.json` together with the 1.5.0 numbers.

```powershell
node perf.mjs --samples 60 --out perf-results.json
node perf.mjs --ping-threshold 80          # one-off relaxed run
```

The artifact records raw samples, p50/p95/max/mean, the environment (product and server
version, profile, descriptor path) and a comparison against the baseline p95 that warns
when a metric is more than 2x slower.

### Authoring perf (1.7 surfaces)

`tests/perf/authoring.mjs` covers the three authoring lanes added in 1.7 and fails the run
when a p95 exceeds its budget:

| Group | Metrics |
| --- | --- |
| `bt` | `bt_create` (new asset + root composite, then delete), `bt_add_node` (add + remove), `bt_inspect`, `bt_compile` |
| `umg` | `widget_insert`, `widget_reorder`, `widget_style`, `widget_screenshot` (640 px PNG under the project's `Saved/UEV/Screenshots`, deleted after the run) |
| `bp` | `blueprint_create_function`, `blueprint_add_node` (add + delete), `blueprint_compile`, `blueprint_verify` |

Budgets live in `tests/perf/perf-baseline-1.7.0.json` as `budgetMs` per metric (p95
milliseconds). They were recorded on an isolated 4.27.2 project and rounded up with a wide
margin over the BT lane numbers (create ~101 ms, add_node ~51-65 ms, inspect ~25-35 ms,
compile ~48-59 ms), because the same calls compile on first touch and CI machines are
noisier than a local editor. The recorded budget is `ceil(max(p95 * 2.5, floor) / 100) * 100`
with a 600 ms floor (1500 ms for asset creation, 3000 ms for preview screenshots), so
ordinary idle-editor noise cannot flake the gate while a real multi-x regression still
fails it. A metric above budget prints `OVER` and exits 1. A warm-ping
precondition (p50 > 150 ms) aborts the run instead of producing a false regression when
the editor is backgrounded. Re-record the baseline only with a reason:

```powershell
node perf/authoring.mjs --record-baseline
node perf/authoring.mjs --iterations 9 --only bt --out perf-authoring.json
```

## Unattended runs

`tests/run-matrix.mjs` is the CI-shaped entry point: it runs the read matrix, the write
matrix (fixtures, authoring round trips, PIE refusal), the control-plane perf gates and the
authoring perf harness, each with its own JSON artifact under
`tests/artifacts/<timestamp>/`, then writes `summary.md` and exits non-zero if any step
fails. It never treats a crash as a skip.

```powershell
node run-matrix.mjs                          # full run, live editor required
node run-matrix.mjs --skip-writes            # read-only host
node run-matrix.mjs --skip-perf --iterations 5
node run-matrix.mjs --descriptor path/to/control.json
```

## Artifacts

`--out <file>` writes JSON results; the default names are `matrix-results.json`,
`contract-results.json`, `perf-results.json` and `perf-authoring.json`. `run-matrix.mjs`
adds a timestamped directory plus `summary.md`. Each file carries the checks with their
group, id, pass/fail, detail and duration, plus a summary block, so a CI job can archive
one file per suite. Exit codes: `0` all green, `1` at least one failure or a crashed
run.

## Recording a new catalog fixture

The contract suite validates against `tests/fixtures/catalog-<productVersion>.json`, recorded
from a live stack. Re-record it whenever the catalog changes on purpose:

```powershell
node matrix.mjs --record-fixture --only identity
```

Commit the new fixture with the change that altered the catalog. If the fixture and the
build disagree, `contract-no-editor.mjs` fails with `fixture-matches-build`. That is the
signal to re-record rather than to relax the check.

## Installer DryRun check

`tests/installer-dryrun.mjs` (or `npm run test:installer` from this folder) runs the shipped
`install.ps1` with `-DryRun -Json` and asserts the installer contract that 1.7.0 keeps:

- exit code 0, and **stdout is pure JSON**: the human log goes to stderr, so a script can
  parse the result without filtering;
- `DryRun: true`, and `ProductVersion` equal to the `productVersion` in the `manifest.json`
  beside the installer (never a hardcoded constant; the module only owns a fallback for a
  package whose manifest is missing);
- the requested `InstallRoot`, `%LOCALAPPDATA%\UEV\stack.json` and the project's
  `mcp-client.json` are untouched, because a dry run writes nothing.

The installer refuses to run while UE4Editor is open, so close the editor and the supervisor
first; the script reports `SKIP` with that reason instead of a false failure.

## Releasing 1.7.x

`packaging/Release-UEV.ps1` is the one-command release path (it needs the live stack for the
catalog checks):

```powershell
& '<repo>/packaging/Release-UEV.ps1' -Version 1.7.0 `
    -OutputRoot 'D:/Pi-Project/uev-mcp-1.7.0-release' -ZipPath 'D:/Pi-Project/uev-1.7.0.zip'
```

It type-checks and builds the server, reads the identity from the built `dist/version.js`
(product, server, protocol), compares it with `package.json` and `-Version`, fetches
`/api/catalog` and regenerates `docs/TOOLS.md` from it, then asserts that the README surface
sentence, the README release summary, the README version banner, the FINDINGS header and the
FINDINGS counts all match the live catalog. It then runs the package build script, verifies
every checksum in the tree, rejects `.git`, logs, run artifacts, `Binaries`, `Intermediate`
and `__pycache__`, checks the manifest fields and that `builtAt` is from this run, and finally
writes the zip plus a `<zip>.sha256.txt` report and asserts the zip entry count equals the
tree file count. Any mismatch stops the release with the file that drifted.

Use `-SkipBuild` to package an existing `dist`, and `-SkipCatalog` only when no stack can be
started (the doc/catalog checks and the `docs/TOOLS.md` refresh are then skipped, not faked).

## Prerequisites and gotchas

- Matrix and perf suites need the control API (`UEV_CONTROL=1`) and a running editor. The
  package launcher (`Launch UEV.bat`) starts both; the editor needs 60-90 s before the first
  tool call answers.
- If the editor comes back on the `Restore Packages` modal, every call times out with
  `Could not find a node within the given time`. Click **Skip Restore** (or clear
  `Saved\Autosaves`) and re-run. It is not a server fault.
- Keep the editor in the foreground while measuring performance. Unreal throttles its tick
  when the window is not focused (Editor Preferences > Performance > *Use Less CPU when in
  Background*), and every latency jumps by roughly an order of magnitude; a background run
  measured p95 340 ms for the warm ping against 50 ms in the foreground. `perf.mjs` probes
  this first and stops with `editor-responsive` when a warm ping takes longer than 150 ms.
- After repeated mutating failures the supervised profile opens the circuit breaker
  (`safety.circuit_open`, HTTP 409). Any successful read resets it; the matrix harness does
  that automatically and retries the case once, so a breaker left open by an earlier run
  does not fail the suite.
- A first run after a reinstall to a new install root may need the Windows firewall prompt
  answered for the new `%LOCALAPPDATA%\UEV\node\node.exe` path.
