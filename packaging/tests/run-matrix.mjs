#!/usr/bin/env node
// Unattended runner for the whole UEV verification layer.
//
// Runs the read matrix, the write matrix, the legacy perf gates and the 1.7
// authoring perf harness in sequence, keeps a timestamped artifact directory,
// writes summary.md and exits non-zero as soon as any step reports defects.
//
// Usage:
//   node run-matrix.mjs                       # full run against the live stack
//   node run-matrix.mjs --skip-writes         # read-only hosts
//   node run-matrix.mjs --skip-perf --iterations 5
//   node run-matrix.mjs --descriptor path/to/control.json
//
// The stack itself is launched by the caller (supervisor + editor); see
// packaging/product/docs/testing.md. Every step still decides pass/fail from
// its own JSON report, so this file never masks a defect.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgv } from "./lib/uev-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgv();
const iterations = args.get("iterations", "7");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(args.get("out-dir", path.join(__dirname, "artifacts", stamp)));
fs.mkdirSync(outDir, { recursive: true });

const descriptor = args.get("descriptor", "");
const env = { ...process.env };
if (descriptor) {
	env.UEV_CONTROL_DESCRIPTOR = descriptor;
}

const steps = [
	{
		id: "matrix-read",
		label: "read matrix (identity, catalog, query, editor, refusals)",
		script: path.join(__dirname, "matrix.mjs"),
		handles: ["--out", path.join(outDir, "matrix-read.json")],
	},
];
if (!args.flag("skip-writes")) {
	steps.push({
		id: "matrix-writes",
		label: "write matrix (fixtures + authoring round trips + PIE refusal)",
		script: path.join(__dirname, "matrix.mjs"),
		handles: ["--only", "writes", "--include-writes", "--out", path.join(outDir, "matrix-writes.json")],
	});
}
if (!args.flag("skip-perf")) {
	steps.push(
		{
			id: "perf-control",
			label: "control-plane perf gates (ping, catalog, query, compile)",
			script: path.join(__dirname, "perf.mjs"),
			handles: ["--out", path.join(outDir, "perf-control.json")],
		},
		{
			id: "perf-authoring",
			label: "1.7 authoring perf (BT / UMG / blueprint p50-p95 budgets)",
			script: path.join(__dirname, "perf", "authoring.mjs"),
			handles: ["--iterations", iterations, "--out", path.join(outDir, "perf-authoring.json")],
		},
	);
}

const results = [];
for (const step of steps) {
	console.log("");
	console.log("=== " + step.id + " :: " + step.label);
	const started = Date.now();
	const run = spawnSync(process.execPath, [step.script, ...step.handles], {
		cwd: __dirname,
		env,
		stdio: "inherit",
		windowsHide: true,
	});
	const ms = Date.now() - started;
	const status = run.status === 0 ? "pass" : "fail";
	const artifact = step.handles[step.handles.indexOf("--out") + 1];
	results.push({
		id: step.id,
		label: step.label,
		status,
		exitCode: run.status,
		ms,
		artifact: path.relative(outDir, artifact) || artifact,
		signal: run.signal ?? undefined,
	});
	console.log("=== " + step.id + " " + status.toUpperCase() + " in " + ms + " ms");
}

const lines = [
	"# UEV verification run " + stamp,
	"",
	"- Control API: " + (descriptor || process.env.UEV_CONTROL_DESCRIPTOR || "auto-detected"),
	"- Artifacts: " + outDir,
	"",
	"| step | status | duration | artifact |",
	"| --- | --- | --- | --- |",
	...results.map((entry) => `| ${entry.id} | ${entry.status} | ${entry.ms} ms | ${entry.artifact} |`),
	"",
];
const failed = results.filter((entry) => entry.status !== "pass");
if (failed.length) {
	lines.push("Failed steps: " + failed.map((entry) => entry.id + " (exit " + entry.exitCode + ")").join(", "));
} else {
	lines.push("All steps passed.");
}
fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n") + "\n");
console.log("");
console.log(lines.join("\n"));
console.log("Artifacts: " + outDir);
process.exitCode = failed.length ? 1 : 0;
