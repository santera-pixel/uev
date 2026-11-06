#!/usr/bin/env node
// Authoring perf harness for the 1.7 surfaces (behavior trees, UMG designer,
// blueprint depth). Measures end-to-end control-API latency, gates each metric
// against the versioned baseline, and writes a machine-readable result file.
//
// Usage:
//   node perf/authoring.mjs                         # gate against the baseline
//   node perf/authoring.mjs --record-baseline       # rewrite the baseline
//   node perf/authoring.mjs --iterations 9 --only bt,umg --out result.json
//
// Budgets live in perf-baseline-1.7.0.json. A measured p95 above budgetMs fails
// the run, so CI drift on a loaded editor is visible instead of silent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Checker, createClient, loadDescriptor, parseArgv, percentile, writeArtifact } from "../lib/uev-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgv();
const descriptor = loadDescriptor(args);
const client = createClient(descriptor);

const iterations = Math.max(3, Number(args.get("iterations", "7")) || 7);
const recordBaseline = args.flag("record-baseline");
const only = String(args.get("only", ""))
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const baselinePath = args.get("baseline", path.join(__dirname, "perf-baseline-1.7.0.json"));
const outPath = args.get("out", "");

const checker = new Checker("UEV 1.7 authoring perf");
const metrics = {};

function wants(group) {
	return only.length === 0 || only.includes(group);
}

function round(value) {
	return Math.round(value * 100) / 100;
}

async function measure(label, count, op) {
	const samples = [];
	for (let index = 0; index < count; index += 1) {
		const started = performance.now();
		const detail = await op(index);
		const ms = performance.now() - started;
		if (detail && detail.ok === false) {
			throw new Error(label + " sample " + index + " failed: " + detail.detail);
		}
		samples.push(ms);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const stats = {
		samples: samples.length,
		p50: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		max: round(sorted[sorted.length - 1]),
		mean: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
	};
	metrics[label] = stats;
	return stats;
}

function expectSuccess(response, what) {
	if (response.payload?.success === false) {
		return { ok: false, detail: what + ": " + String(response.text ?? "").slice(0, 200) };
	}
	return { ok: true };
}

async function setupBehaviorTree() {
	const asset = "/Game/UEVTests/BT_UEVPerfTree";
	const exists = await client.call("manage_asset", "exists", { asset_path: asset });
	if (exists.payload?.exists === true) {
		await client.call("manage_asset", "delete", { asset_path: asset });
	}
	const created = await client.call("manage_ai", "bt_create", {
		name: "BT_UEVPerfTree",
		path: "/Game/UEVTests",
		root_class: "/Script/AIModule.BTComposite_Sequence",
	});
	if (created.payload?.success !== true) {
		throw new Error("BT setup failed: " + String(created.text ?? "").slice(0, 200));
	}
	return String(created.payload.behavior_tree_path);
}

async function measureBehaviorTree() {
	const createSamples = [];
	for (let index = 0; index < Math.min(iterations, 5); index += 1) {
		const name = "BT_UEVPerfCreate" + index;
		const asset = "/Game/UEVTests/" + name;
		const exists = await client.call("manage_asset", "exists", { asset_path: asset });
		if (exists.payload?.exists === true) {
			await client.call("manage_asset", "delete", { asset_path: asset });
		}
		const started = performance.now();
		const created = await client.call("manage_ai", "bt_create", {
			name,
			path: "/Game/UEVTests",
			root_class: "/Script/AIModule.BTComposite_Sequence",
		});
		const ms = performance.now() - started;
		if (created.payload?.success !== true) {
			throw new Error("bt_create sample failed: " + String(created.text ?? "").slice(0, 200));
		}
		createSamples.push(ms);
		await client.call("manage_asset", "delete", { asset_path: asset });
	}
	const sortedCreate = [...createSamples].sort((a, b) => a - b);
	metrics.bt_create = {
		samples: createSamples.length,
		p50: round(percentile(sortedCreate, 0.5)),
		p95: round(percentile(sortedCreate, 0.95)),
		max: round(sortedCreate[sortedCreate.length - 1]),
		mean: round(createSamples.reduce((sum, value) => sum + value, 0) / createSamples.length),
	};

	const tree = await setupBehaviorTree();
	let waitId = "";
	const wait = await client.call("manage_ai", "bt_add_node", {
		behavior_tree_path: tree,
		parent_id: "ei:0",
		kind: "task",
		node_class: "/Script/AIModule.BTTask_Wait",
	});
	if (wait.payload?.success === true) {
		waitId = String(wait.payload.node_id ?? "");
	}

	await measure("bt_add_node", iterations, async () => {
		const added = await client.call("manage_ai", "bt_add_node", {
			behavior_tree_path: tree,
			parent_id: "ei:0",
			kind: "task",
			node_class: "/Script/AIModule.BTTask_Wait",
		});
		const nodeId = added.payload?.node_id;
		if (added.payload?.success !== true || !nodeId) {
			return { ok: false, detail: "bt_add_node failed: " + String(added.text ?? "").slice(0, 120) };
		}
		const removed = await client.call("manage_ai", "bt_remove_node", { behavior_tree_path: tree, node_id: nodeId });
		if (removed.payload?.success !== true) {
			return { ok: false, detail: "bt_remove_node cleanup failed: " + String(removed.text ?? "").slice(0, 120) };
		}
		return { ok: true };
	});
	await measure("bt_inspect", iterations, async () => expectSuccess(await client.call("manage_ai", "bt_inspect", { behavior_tree_path: tree, include_graph: true }), "bt_inspect"));
	await measure("bt_compile", iterations, async () => expectSuccess(await client.call("manage_ai", "bt_compile", { behavior_tree_path: tree }), "bt_compile"));

	if (waitId) {
		await client.call("manage_ai", "bt_remove_node", { behavior_tree_path: tree, node_id: waitId });
	}
	await client.call("manage_asset", "delete", { asset_path: "/Game/UEVTests/BT_UEVPerfTree" });
}

async function measureWidgets() {
	const asset = "/Game/UEVTests/WBP_UEVPerf";
	const exists = await client.call("manage_asset", "exists", { asset_path: asset });
	if (exists.payload?.exists === true) {
		await client.call("manage_asset", "delete", { asset_path: asset });
	}
	const created = await client.call("manage_widget", "create_widget_blueprint", { widget_name: asset });
	if (created.payload?.success === false) {
		throw new Error("widget setup failed: " + String(created.text ?? "").slice(0, 200));
	}
	await client.call("manage_widget", "ensure_canvas_root", { asset_path: asset });
	const box = await client.call("manage_widget", "insert_widget", {
		asset_path: asset,
		widget_class: "VerticalBox",
		widget_name: "PerfBox",
		parent_widget_name: "CanvasPanel_0",
	});
	if (box.payload?.success === false) {
		throw new Error("widget panel setup failed: " + String(box.text ?? "").slice(0, 200));
	}
	const screenshots = [];
	await measure("widget_insert", iterations, async (index) => {
		const inserted = await client.call("manage_widget", "insert_widget", {
			asset_path: asset,
			widget_class: "TextBlock",
			widget_name: "PerfText" + index,
			parent_widget_name: "PerfBox",
		});
		return inserted.payload?.success === false
			? { ok: false, detail: "insert failed: " + String(inserted.text ?? "").slice(0, 120) }
			: { ok: true };
	});
	await measure("widget_reorder", iterations, async (index) => {
		const reordered = await client.call("manage_widget", "reorder_child", {
			asset_path: asset,
			widget_name: "PerfText" + index,
			index: 0,
		});
		return reordered.payload?.success === false
			? { ok: false, detail: "reorder failed: " + String(reordered.text ?? "").slice(0, 120) }
			: { ok: true };
	});
	await measure("widget_style", iterations, async (index) => {
		const styled = await client.call("manage_widget", "set_style", {
			asset_path: asset,
			widget_name: "PerfText" + index,
			font: { size: 18 + index },
		});
		return styled.payload?.success === false
			? { ok: false, detail: "set_style failed: " + String(styled.text ?? "").slice(0, 120) }
			: { ok: true };
	});
	// The action requires output_path to stay inside the project; the default
	// location (Saved/UEV/Screenshots) is also the one the editor documents.
	await measure("widget_screenshot", Math.min(iterations, 5), async () => {
		const shot = await client.call(
			"manage_widget",
			"designer_screenshot",
			{ asset_path: asset, width: 640 },
			{ timeoutMs: 120000 },
		);
		if (shot.payload?.success === false) {
			return { ok: false, detail: "designer_screenshot failed: " + String(shot.text ?? "").slice(0, 160) };
		}
		if (shot.payload?.png_path) {
			screenshots.push(shot.payload.png_path);
		}
		return { ok: true };
	});
	for (const shot of screenshots) {
		try {
			await fs.promises.unlink(shot);
		} catch {
			// best effort
		}
	}
	await client.call("manage_asset", "delete", { asset_path: asset });
}

async function measureBlueprints() {
	const asset = "/Game/UEVTests/BP_UEVPerf";
	const exists = await client.call("manage_asset", "exists", { asset_path: asset });
	if (exists.payload?.exists === true) {
		await client.call("manage_asset", "delete", { asset_path: asset });
	}
	const created = await client.call("manage_blueprint", "create_blueprint", {
		name: "BP_UEVPerf",
		path: "/Game/UEVTests",
		parent_class: "Actor",
	});
	if (created.payload?.success === false) {
		throw new Error("blueprint setup failed: " + String(created.text ?? "").slice(0, 200));
	}
	await measure("blueprint_create_function", Math.min(iterations, 5), async (index) => {
		const response = await client.call("manage_blueprint", "create_function", {
			blueprint_name: asset,
			name: "PerfFn" + index,
			inputs: [],
			outputs: [],
			compile: true,
		});
		return response.payload?.success === false
			? { ok: false, detail: "create_function failed: " + String(response.text ?? "").slice(0, 120) }
			: { ok: true };
	});
	await measure("blueprint_add_node", iterations, async () => {
		const added = await client.call("manage_blueprint", "add_node", {
			blueprint_name: asset,
			graph_name: "UserConstructionScript",
			node_type: "comment",
			comment: "UEV perf probe",
		});
		const nodeId = added.payload?.node_id ?? added.payload?.node?.node_id ?? added.payload?.node?.id;
		if (added.payload?.success === false || !nodeId) {
			return { ok: false, detail: "add_node failed: " + String(added.text ?? "").slice(0, 120) };
		}
		const removed = await client.call("manage_blueprint", "delete_node", {
			blueprint_name: asset,
			graph_name: "UserConstructionScript",
			node_id: nodeId,
		});
		return removed.payload?.success === false
			? { ok: false, detail: "delete_node cleanup failed: " + String(removed.text ?? "").slice(0, 120) }
			: { ok: true };
	});
	await measure("blueprint_compile", iterations, async () => expectSuccess(await client.call("manage_blueprint", "compile", { blueprint_name: asset }, { timeoutMs: 120000 }), "compile"));
	await measure("blueprint_verify", Math.min(iterations, 5), async () => {
		const verified = await client.call(
			"manage_blueprint",
			"verify_blueprint",
			{ blueprint_name: asset, expected: { functions: [{ name: "PerfFn0" }] }, compile: true },
			{ timeoutMs: 120000 },
		);
		if (verified.payload?.success !== true || verified.payload?.match !== true) {
			return { ok: false, detail: "verify_blueprint mismatch: " + String(verified.text ?? "").slice(0, 160) };
		}
		return { ok: true };
	});
	await client.call("manage_asset", "delete", { asset_path: asset });
}

function loadBaseline() {
	try {
		return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	} catch {
		return null;
	}
}

function baselineDocument(stats) {
	const document = {
		version: "1.7.0",
		harness: "packaging/tests/perf/authoring.mjs",
		recordedAt: new Date().toISOString(),
		iterations,
		notes:
			"Budgets are p95 milliseconds with a wide CI margin over the 1.7 authoring lane measurements. " +
			"bt_create 101 / add_node 51-65 / inspect 25-35 / compile 48-59 came from the BT lane; UMG and blueprint " +
			"are the same order of magnitude. Budgets round up and allow for a backgrounded editor and first-compile spikes.",
		metrics: {},
	};
	for (const [label, value] of Object.entries(stats)) {
		const floor = label.includes("screenshot") ? 3000 : label.includes("create") || label.includes("macro") ? 1500 : 600;
		const budget = Math.ceil(Math.max(value.p95 * 2.5, floor) / 100) * 100;
		document.metrics[label] = { ...value, budgetMs: budget };
	}
	return document;
}

async function main() {
	console.log("UEV 1.7 authoring perf against " + client.root + " (descriptor " + descriptor.descriptorPath + ")");
	const health = await client.getJson("/api/health");
	if (health.status !== 200) {
		checker.fail("stack", "reachable", "control API returned " + health.status);
		checker.finish(outPath, { metrics });
		return;
	}
	const warm = [];
	for (let index = 0; index < 10; index += 1) {
		const started = performance.now();
		const state = await client.call("manage_editor", "is_pie_running", {});
		warm.push(performance.now() - started);
		if (state.payload?.is_pie_running === true) {
			checker.fail("stack", "editor-idle", "editor is in PIE; stop PIE before measuring");
			checker.finish(outPath, { metrics });
			return;
		}
	}
	const warmSorted = [...warm].sort((a, b) => a - b);
	const warmP50 = round(percentile(warmSorted, 0.5));
	checker.add("stack", "warm-ping-p50", warmP50 <= 150, warmP50 + " ms (editor must be foregrounded; background throttling invalidates budgets)", warmP50);
	if (warmP50 > 150) {
		console.log("Refusing to measure: warm ping p50 " + warmP50 + " ms suggests a backgrounded editor.");
		checker.finish(outPath, { metrics: { warmPing: { p50: warmP50 } } });
		return;
	}

	if (wants("bt")) {
		await measureBehaviorTree();
	}
	if (wants("umg")) {
		await measureWidgets();
	}
	if (wants("bp")) {
		await measureBlueprints();
	}

	const baseline = loadBaseline();
	const document = baseline ?? baselineDocument(metrics);
	const isNew = !baseline || recordBaseline;
	if (isNew) {
		const fresh = baselineDocument(metrics);
		writeArtifact(baselinePath, fresh);
		console.log("Recorded perf baseline: " + baselinePath);
	}
	for (const [label, value] of Object.entries(metrics)) {
		const budget = document.metrics[label]?.budgetMs;
		if (typeof budget !== "number") {
			checker.add("budget", label, false, "no budget in " + path.basename(baselinePath), value.p95);
			continue;
		}
		checker.add(
			"budget",
			label,
			value.p95 <= budget,
			"p50 " + value.p50 + " / p95 " + value.p95 + " / max " + value.max + " ms, budget " + budget + " ms",
			value.p95,
		);
	}
	console.log("");
	console.log("metric".padEnd(28) + "p50".padStart(9) + "p95".padStart(9) + "max".padStart(9) + "budget".padStart(9) + "  verdict");
	for (const [label, value] of Object.entries(metrics)) {
		const budget = document.metrics[label]?.budgetMs;
		const verdict = typeof budget === "number" && value.p95 <= budget ? "ok" : "OVER";
		console.log(
			label.padEnd(28) +
				String(value.p50).padStart(9) +
				String(value.p95).padStart(9) +
				String(value.max).padStart(9) +
				String(budget ?? "-").padStart(9) +
				"  " +
				verdict,
		);
	}
	checker.printSummary();
	checker.finish(outPath, { environment: { descriptor: descriptor.descriptorPath, iterations, baseline: path.basename(baselinePath) }, metrics, baseline: document });
}

main().catch((error) => {
	console.error("authoring perf harness crashed: " + (error?.stack ?? error));
	process.exitCode = 1;
});
