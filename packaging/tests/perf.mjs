#!/usr/bin/env node
// UEV performance regression suite.
//
// Thresholds come from the 1.5.0 baseline measurements recorded in
// perf-baseline.json: a warm editor round trip (ping), the catalog document and
// a blueprint compile. Every run writes a JSON artifact with the raw samples so
// a slow run can be compared against a fast one.
//
// Usage:
//   node perf.mjs                       # thresholds + artifact
//   node perf.mjs --samples 60          # more ping samples
//   node perf.mjs --out perf-results.json --baseline perf-baseline.json
//   node perf.mjs --samples 5           # quick smoke run

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Checker, createClient, loadDescriptor, parseArgv, percentile, writeArtifact } from "./lib/uev-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgv();
const outPath = args.get("out", "perf-results.json");
const baselinePath = path.resolve(args.get("baseline", path.join(__dirname, "perf-baseline.json")));
const pingSamples = Number(args.get("samples", 40));
const catalogSamples = Number(args.get("catalog-samples", 10));
const compileSamples = Number(args.get("compile-samples", 5));
const querySamples = Number(args.get("query-samples", 10));
const blueprintFixture = args.get("blueprint", "/Game/UEVTests/BP_UEVMatrixProbe");

const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : null;
const thresholds = {
	warmPingP95Ms: Number(args.get("ping-threshold", baseline?.thresholds?.warmPingP95Ms ?? 60)),
	catalogMs: Number(args.get("catalog-threshold", baseline?.thresholds?.catalogMs ?? 300)),
	compileMs: Number(args.get("compile-threshold", baseline?.thresholds?.compileMs ?? 2000)),
};

const checker = new Checker("UEV performance suite");
const descriptor = loadDescriptor(args);
const client = createClient(descriptor);

function stats(samples) {
	const values = samples.slice().sort((left, right) => left - right);
	const mean = values.reduce((total, value) => total + value, 0) / (values.length || 1);
	return {
		count: values.length,
		p50: round(percentile(values, 0.5)),
		p95: round(percentile(values, 0.95)),
		max: round(values[values.length - 1] ?? 0),
		mean: round(mean),
	};
}

function round(value) {
	return Number(Number(value).toFixed(2));
}

async function measure(label, iterations, operation) {
	const samples = [];
	for (let index = 0; index < iterations; index += 1) {
		const started = performance.now();
		const result = await operation(index);
		const elapsed = performance.now() - started;
		samples.push(round(elapsed));
		if (result && result.succeeded === false) {
			throw new Error(label + " sample " + index + " failed: " + String(result.text ?? "").replace(/\s+/g, " ").slice(0, 200));
		}
	}
	const summary = stats(samples);
	console.log(
		"  " + label + ": p50 " + summary.p50 + "ms, p95 " + summary.p95 + "ms, max " + summary.max + "ms (" + summary.count + " samples)",
	);
	return { samples, ...summary };
}

async function main() {
	console.log("UEV performance suite against " + client.root);
	console.log("Thresholds: warm ping p95 <= " + thresholds.warmPingP95Ms + "ms, catalog <= " + thresholds.catalogMs + "ms, compile <= " + thresholds.compileMs + "ms");
	console.log("");

	const health = await client.getJson("/api/health");
	if (!health.payload || health.payload.ok !== true) {
		checker.fail("environment", "stack-healthy", "GET /api/health returned " + health.status);
		checker.finish(outPath);
		return;
	}
	const environment = {
		productName: health.payload.productName,
		productVersion: health.payload.productVersion,
		serverVersion: health.payload.serverVersion,
		protocolVersion: health.payload.protocolVersion,
		profile: health.payload.profile,
		readOnly: health.payload.readOnly,
		controlApi: client.root,
		descriptor: descriptor.descriptorPath,
		platform: process.platform,
		node: process.version,
		baseline: baseline?.label ?? "none",
	};

	// One warm-up of each path so the first call cannot skew the percentiles.
	await client.call("manage_editor", "is_pie_running");
	await client.getJson("/api/catalog");

	// ------------------------------------------------------------ precondition
	// Unreal throttles its tick when the editor window is not in the foreground
	// ("Use Less CPU when in Background"), which inflates every measurement by an
	// order of magnitude. Probe before measuring so the run reports the real cause
	// instead of four mysterious threshold failures.
	const preconditionSamples = [];
	for (let index = 0; index < 5; index += 1) {
		const started = performance.now();
		await client.call("manage_editor", "is_pie_running");
		preconditionSamples.push(performance.now() - started);
	}
	const preconditionP50 = round(percentile(preconditionSamples.slice().sort((left, right) => left - right), 0.5));
	if (preconditionP50 > 150) {
		checker.fail(
			"environment",
			"editor-responsive",
			"warm ping p50 is " + preconditionP50 + "ms before measuring. The editor is most likely in the background, where Unreal throttles the tick (Editor Preferences > Performance > 'Use Less CPU when in Background'). Focus the editor window and rerun; thresholds are not meaningful in this state.",
		);
		checker.finish(outPath, { environment, thresholds, precondition: { p50: preconditionP50, samples: preconditionSamples.map(round) } });
		return;
	}

	// ------------------------------------------------------------- warm ping
	const ping = await measure("warm ping (manage_editor.is_pie_running)", pingSamples, () =>
		client.call("manage_editor", "is_pie_running"),
	);
	checker.add(
		"latency",
		"warm-ping-p95",
		ping.p95 <= thresholds.warmPingP95Ms,
		"p95 " + ping.p95 + "ms <= " + thresholds.warmPingP95Ms + "ms",
		ping.p95,
	);

	// ----------------------------------------------------------------- catalog
	const catalog = await measure("catalog (GET /api/catalog)", catalogSamples, () => client.getJson("/api/catalog"));
	checker.add(
		"latency",
		"catalog",
		catalog.max <= thresholds.catalogMs,
		"max " + catalog.max + "ms <= " + thresholds.catalogMs + "ms",
		catalog.max,
	);

	// ------------------------------------------------------------------- query
	const query = await measure("query (manage_query.query class=PointLight)", querySamples, () =>
		client.call("manage_query", "query", { class: "PointLight", limit: 5 }),
	);
	checker.add("latency", "query-p95", query.p95 <= 250, "p95 " + query.p95 + "ms <= 250ms", query.p95);

	// ----------------------------------------------------------------- compile
	const metrics = { ping, catalog, query };
	// The compile fixture is a plain blueprint the matrix run authors; compiling it is
	// the cheapest main-thread write we can time, so it doubles as a "is the editor
	// still answering writes" check.
	const warmCompile = await client.call("manage_blueprint", "compile", { asset_path: blueprintFixture, save: false });
	if (!warmCompile.succeeded) {
		const detail = String(warmCompile.text ?? "")
			.replace(/\s+/g, " ")
			.slice(0, 160);
		checker.add("latency", "compile", false, "compile of " + blueprintFixture + " failed (fixture missing? run matrix.mjs first): " + detail);
	} else {
		const compile = await measure("compile (manage_blueprint.compile)", compileSamples, () =>
			client.call("manage_blueprint", "compile", { asset_path: blueprintFixture, save: false }),
		);
		metrics.compile = compile;
		checker.add(
			"latency",
			"compile",
			compile.max <= thresholds.compileMs,
			"max " + compile.max + "ms <= " + thresholds.compileMs + "ms",
			compile.max,
		);
	}

	checker.finish(outPath, { environment, thresholds, metrics });
	await reportRegression(metrics);
}

async function reportRegression(metrics) {
	const baselineMetrics = baseline?.metrics;
	if (!baselineMetrics) {
		return;
	}
	const comparisons = [];
	const measured = {
		warmPing: metrics.ping,
		catalog: metrics.catalog,
		query: metrics.query,
		compile: metrics.compile,
	};
	for (const [name, current] of Object.entries(measured)) {
		const reference = baselineMetrics[name]?.p95;
		if (!current || typeof reference !== "number" || reference <= 0) {
			continue;
		}
		const ratio = Number((current.p95 / reference).toFixed(2));
		comparisons.push({ metric: name, baselineP95: reference, currentP95: current.p95, ratio });
		console.log("  " + name + ": p95 " + current.p95 + "ms vs baseline " + reference + "ms (" + ratio + "x)");
	}
	if (comparisons.length) {
		const reportPath = path.resolve(outPath);
		if (fs.existsSync(reportPath)) {
			const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
			report.regression = comparisons;
			writeArtifact(reportPath, report);
		}
	}
	const worst = comparisons.reduce((worstEntry, entry) => (entry.ratio > (worstEntry?.ratio ?? 0) ? entry : worstEntry), null);
	if (worst && worst.ratio > 2) {
		console.log("  WARNING " + worst.metric + " is " + worst.ratio + "x slower than the baseline p95");
	}
}

main().catch((error) => {
	console.error("UEV performance suite crashed: " + (error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});
