#!/usr/bin/env node
// UEV no-editor contract suite.
//
// Everything here runs without Unreal Editor, without a live control API and
// without network access: it inspects the built server, the identity constants,
// the 1.7.0 env-var contract, the safety configuration and the recorded catalog
// fixture. That makes it the CI subset - run it before every commit.
//
// Usage:
//   node contract-no-editor.mjs
//   node contract-no-editor.mjs --dist <path-to-mcp-fork>/dist
//   node contract-no-editor.mjs --fixture fixtures/catalog-1.7.0.json --out contract-results.json

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Checker, parseArgv, readPath, writeArtifact } from "./lib/uev-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgv();
const checker = new Checker("UEV no-editor contract suite");
const outPath = args.get("out", "");

const EXPECTED = {
	protocolVersion: 2,
	toolCount: 45,
	directTools: 7,
	namespaceTools: 38,
	handleGrammarAction: "manage_object.describe",
};

function resolveServerRoot() {
	const explicit = args.get("dist");
	const candidates = [];
	if (explicit) {
		candidates.push(path.resolve(explicit));
	}
	candidates.push(path.resolve(__dirname, "..", "..", "mcp-fork", "dist"));
	candidates.push(path.resolve(__dirname, "..", "payload", "app", "dist"));
	candidates.push(path.resolve(__dirname, "..", "app", "dist"));
	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, "bin.js"))) {
			return candidate;
		}
	}
	return null;
}

function runNode(nodeArgs, options = {}) {
	const result = spawnSync(process.execPath, nodeArgs, {
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120000,
		env: options.env ?? process.env,
		cwd: options.cwd ?? process.cwd(),
	});
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
		error: result.error ? String(result.error.message ?? result.error) : null,
	};
}

const distRoot = resolveServerRoot();
if (!distRoot) {
	checker.fail("dist", "server.build-present", "no built server found; run 'npm run build' in mcp-fork or pass --dist <dir>");
	checker.finish(outPath);
} else {
	checker.add("dist", "server.build-present", true, distRoot);
	runContract(distRoot);
}

function runContract(distRoot) {
	const packageJsonPath = path.join(distRoot, "..", "package.json");
	const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) : null;

	// ---------------------------------------------------------------- CLI contract
	const versionRun = runNode([path.join(distRoot, "bin.js"), "--version"], { timeoutMs: 20000 });
	if (packageJson) {
		checker.add(
			"cli",
			"version-matches-package",
			versionRun.status === 0 && versionRun.stdout.trim() === packageJson.version,
			versionRun.stdout.trim() + " vs package.json " + packageJson.version,
		);
	} else {
		checker.add("cli", "version-matches-package", versionRun.status === 0, "package.json not found next to dist", null);
	}
	checker.add(
		"cli",
		"package-identity",
		Boolean(packageJson && packageJson.name === "uev" && packageJson.bin && packageJson.bin.uev),
		packageJson ? packageJson.name + " / bins " + Object.keys(packageJson.bin ?? {}).join(", ") : "package.json not found",
	);

	// ---------------------------------------------------------------- identity + env
	const identityProbe = runNode(
		[
			"--input-type=module",
			"-e",
			[
				"import * as identity from " + JSON.stringify(pathToUrl(path.join(distRoot, "identity.js"))) + ";",
				"console.log(JSON.stringify({",
				"productName: identity.productName,",
				"productLongName: identity.productLongName,",
				"productSlug: identity.productSlug,",
				"envPrefix: identity.envPrefix,",
				"retiredExports: [\"legacyProductName\", \"legacyProductSlug\", \"legacyEnvPrefix\", \"envAliases\", \"legacySupervisorPipe\", \"supervisorPipeCandidates\", \"legacyInstallRootFolder\", \"legacySupervisorExeName\", \"legacyStateDirName\"].filter((key) => key in identity),",
				"defaultSupervisorPipe: identity.defaultSupervisorPipe,",
				"installRootFolder: identity.installRootFolder,",
				"stateDirName: identity.stateDirName,",
				"pipePath: identity.supervisorPipePath({}),",
				"customPipe: identity.supervisorPipePath({ UEV_SUPERVISOR_PIPE: \"probe-pipe\" }),",
				"}));",
			].join("\n"),
		],
		{ timeoutMs: 30000 },
	);
	let identity = null;
	try {
		identity = JSON.parse(identityProbe.stdout.trim());
	} catch {
		identity = null;
	}
	checker.add("identity", "identity-module-loads", identity !== null, identity ? "product " + identity.productName : identityProbe.stderr.slice(0, 200));
	if (identity) {
		const problems = [];
		if (identity.productName !== "UEV") problems.push("productName=" + identity.productName);
		if (identity.productSlug !== "uev") problems.push("productSlug=" + identity.productSlug);
		if (identity.envPrefix !== "UEV_") problems.push("envPrefix=" + identity.envPrefix);
		if (identity.defaultSupervisorPipe !== "uev-supervisor") problems.push("defaultSupervisorPipe=" + identity.defaultSupervisorPipe);
		if (identity.installRootFolder !== "UEV") problems.push("installRootFolder=" + identity.installRootFolder);
		// 1.7.0 clean break: the 1.5.x alias table and the retired identifiers are
		// removed from the module surface, not just left unused.
		const retired = Array.isArray(identity.retiredExports) ? identity.retiredExports : [];
		if (retired.length) problems.push("retired identity exports are still exported: " + retired.join(", "));
		const pipeTail = String(identity.pipePath ?? "").split("\\").pop();
		if (pipeTail !== "uev-supervisor") {
			problems.push("default supervisor pipe is " + JSON.stringify(identity.pipePath));
		}
		const customTail = String(identity.customPipe ?? "").split("\\").pop();
		if (customTail !== "probe-pipe") {
			problems.push("UEV_SUPERVISOR_PIPE override produced " + JSON.stringify(identity.customPipe));
		}
		checker.add("identity", "identity-constants", problems.length === 0, problems.join("; ") || "1.7.0 clean-break identity");
	}

	const aliasChecks = [
		{ name: "uev-read", env: { UEV_PROBE_VALUE: "uev" }, expected: "uev" },
		{ name: "unprefixed-ignored", env: { PROBE_VALUE: "loose" }, expected: "fallback" },
		{ name: "default-fallback", env: {}, expected: "fallback" },
	];
	const aliasScript = [
		"import { envValue, envFlag } from " + JSON.stringify(pathToUrl(path.join(distRoot, "identity.js"))) + ";",
		"console.log(JSON.stringify({ value: envValue(\"PROBE_VALUE\", process.env, \"fallback\"), flag: envFlag(\"PROBE_FLAG\", process.env) }));",
	].join("\n");
	for (const entry of aliasChecks) {
		const env = { ...process.env, UEV_PROBE_VALUE: "", PROBE_VALUE: "", ...entry.env };
		if (!entry.env.UEV_PROBE_VALUE) delete env.UEV_PROBE_VALUE;
		if (!entry.env.PROBE_VALUE) delete env.PROBE_VALUE;
		const probe = runNode(["--input-type=module", "-e", aliasScript], { env, timeoutMs: 20000 });
		let parsed = null;
		try {
			parsed = JSON.parse(probe.stdout.trim());
		} catch {
			parsed = null;
		}
		checker.add("identity", "env-alias." + entry.name, parsed?.value === entry.expected, probe.stdout.trim() || probe.stderr.slice(0, 200));
	}
	const flagProbe = runNode(["--input-type=module", "-e", aliasScript], {
		env: { ...process.env, UEV_PROBE_FLAG: "1" },
		timeoutMs: 20000,
	});
	let flagParsed = null;
	try {
		flagParsed = JSON.parse(flagProbe.stdout.trim());
	} catch {
		flagParsed = null;
	}
	checker.add("identity", "env-flag", flagParsed?.flag === true, "UEV_PROBE_FLAG=1 -> " + JSON.stringify(flagParsed?.flag));

	// ------------------------------------------------------------ safety config
	const safetyScript = [
		"import { loadSafetyConfig } from " + JSON.stringify(pathToUrl(path.join(distRoot, "safety", "config.js"))) + ";",
		"const config = loadSafetyConfig();",
		"console.log(JSON.stringify({ profile: config.profile, readOnly: config.readOnly, supervisorPipe: config.supervisorPipe, auditLogPath: config.auditLogPath, historyLogPath: config.historyLogPath }));",
	].join("\n");
	const safetyProbe = runNode(["--input-type=module", "-e", safetyScript], {
		env: {
			...process.env,
			UEV_PROFILE: "supervised",
			UEV_READ_ONLY: "0",
			UEV_AUDIT_LOG: path.join(process.env.TEMP ?? "/tmp", "uev-contract-audit.jsonl"),
			UEV_HISTORY_LOG: path.join(process.env.TEMP ?? "/tmp", "uev-contract-history.jsonl"),
		},
		timeoutMs: 30000,
	});
	let safety = null;
	try {
		safety = JSON.parse(safetyProbe.stdout.trim());
	} catch {
		safety = null;
	}
	if (!safety) {
		checker.fail("safety", "config-loads", safetyProbe.stderr.slice(0, 300) || safetyProbe.stdout.slice(0, 300));
	} else {
		checker.add(
			"safety",
			"profile-env",
			safety.profile === "supervised",
			"UEV_PROFILE=supervised -> profile=" + safety.profile,
		);
		checker.add("safety", "read-only-flag", safety.readOnly === false, "readOnly=" + safety.readOnly);
		// loadSafetyConfig reuses the identity pipe path, so the string is a device
		// path (\\.\pipe\uev-supervisor) rather than a bare name.
		const safetyPipeTail = String(safety.supervisorPipe ?? "").split("\\").pop();
		checker.add(
			"safety",
			"single-supervisor-pipe",
			safetyPipeTail === "uev-supervisor",
			JSON.stringify(safety.supervisorPipe),
		);
	}
	const readOnlyProbe = runNode(["--input-type=module", "-e", safetyScript], {
		env: { ...process.env, UEV_PROFILE: "supervised", UEV_READ_ONLY: "1" },
		timeoutMs: 30000,
	});
	let readOnly = null;
	try {
		readOnly = JSON.parse(readOnlyProbe.stdout.trim());
	} catch {
		readOnly = null;
	}
	checker.add("safety", "read-only-env", readOnly?.readOnly === true, "UEV_READ_ONLY=1 -> readOnly=" + JSON.stringify(readOnly?.readOnly));

	// ------------------------------------------------------- recorded catalog fixture
	const fixturePath = resolveFixture();
	if (!fixturePath) {
		checker.fail("catalog", "fixture-present", "no catalog fixture found in fixtures/; run matrix.mjs --record-fixture against a live stack");
		return;
	}
	const catalog = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
	const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
	const namespaceTools = tools.filter((tool) => tool.kind === "namespace");
	const directTools = tools.filter((tool) => tool.kind === "direct");
	const actions = tools.flatMap((tool) => tool.actions ?? []);
	const params = actions.flatMap((action) => action.params ?? []);
	const digest = crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

	checker.add(
		"catalog",
		"fixture-identity",
		catalog.ok === true && catalog.productName === "UEV" && catalog.productSlug === "uev" && catalog.protocolVersion === EXPECTED.protocolVersion,
		[catalog.productName, catalog.productVersion, catalog.serverVersion, "protocol " + catalog.protocolVersion].join(" "),
	);
	checker.add(
		"catalog",
		"tool-counts",
		tools.length === EXPECTED.toolCount && namespaceTools.length === EXPECTED.namespaceTools && directTools.length === EXPECTED.directTools,
		tools.length + " tools = " + namespaceTools.length + " namespaces + " + directTools.length + " direct",
	);
	checker.add(
		"catalog",
		"action-counts",
		actions.length >= 340 && params.length >= 1800,
		actions.length + " actions / " + params.length + " params (sha256 " + digest.slice(0, 16) + ")",
	);

	const shapeProblems = [];
	const modes = new Set();
	for (const tool of tools) {
		const seen = new Set();
		for (const action of tool.actions ?? []) {
			if (!action.name) shapeProblems.push(tool.name + ": action without name");
			if (seen.has(action.name)) shapeProblems.push(tool.name + "." + action.name + ": duplicate");
			seen.add(action.name);
			modes.add(action.mode);
			if (!["read", "write", "supervised"].includes(action.mode)) shapeProblems.push(tool.name + "." + action.name + ": mode " + action.mode);
			if (typeof action.allowed !== "boolean") shapeProblems.push(tool.name + "." + action.name + ": allowed not boolean");
			if (!Array.isArray(action.params)) shapeProblems.push(tool.name + "." + action.name + ": params missing");
			for (const param of action.params ?? []) {
				if (!param.name || !param.type) shapeProblems.push(tool.name + "." + action.name + ": param without name/type");
			}
		}
	}
	checker.add("catalog", "action-shape", shapeProblems.length === 0, shapeProblems.slice(0, 6).join("; ") || "all actions well formed");

	// The 1.6 schema-fidelity contract: nested structured params must stay typed.
	const editor = tools.find((tool) => tool.name === "manage_editor");
	const pieExpect = (editor?.actions ?? []).find((action) => action.name === "pie_expect");
	const conditions = (pieExpect?.params ?? []).find((param) => param.name === "conditions");
	const conditionProperties = conditions?.items?.properties ?? {};
	checker.add(
		"catalog",
		"discriminated-union-schema",
		conditions?.items?.type === "object" && Boolean(conditionProperties.actor_name) && Boolean(conditionProperties.kind),
		"pie_expect.conditions items: " + Object.keys(conditionProperties).join(", ").slice(0, 160),
	);
	const material = tools.find((tool) => tool.name === "manage_material");
	const batchParams = (material?.actions ?? []).find((action) => action.name === "set_material_instance_parameters");
	const scalars = (batchParams?.params ?? []).find((param) => param.name === "scalars");
	const staticSwitches = (batchParams?.params ?? []).find((param) => param.name === "static_switches");
	checker.add(
		"catalog",
		"record-and-union-schema",
		Boolean(scalars?.additionalProperties) && Boolean(staticSwitches),
		"scalars record<" + (scalars?.additionalProperties?.type ?? "?") + ">, static_switches " + (staticSwitches?.type ?? "missing"),
	);
	const objectTool = tools.find((tool) => tool.name === "manage_object");
	const describeHandle = ((objectTool?.actions ?? []).find((action) => action.name === "describe")?.params ?? []).find((param) => param.name === "handle");
	checker.add(
		"catalog",
		"handle-grammar-documented",
		String(describeHandle?.description ?? "").includes("uev:"),
		"manage_object.describe.handle documents uev:<kind>:<path>",
	);
	const widget = tools.find((tool) => tool.name === "manage_widget");
	const bindEventParams = new Set(((widget?.actions ?? []).find((action) => action.name === "bind_event")?.params ?? []).map((param) => param.name));
	checker.add(
		"catalog",
		"widget-alias-schema",
		bindEventParams.has("widget_member_name") && bindEventParams.has("widget_name"),
		"bind_event accepts widget_member_name + widget_name",
	);
	checker.add("catalog", "action-modes", modes.has("read") && modes.has("write") && modes.has("supervised"), [...modes].sort().join(", "));

	// Fixture must describe the same version the built server reports.
	const versionProbe = runNode(
		[
			"--input-type=module",
			"-e",
			"import { productVersion, serverVersion, protocolVersion } from " + JSON.stringify(pathToUrl(path.join(distRoot, "version.js"))) + "; console.log(JSON.stringify({ productVersion, serverVersion, protocolVersion }));",
		],
		{ timeoutMs: 20000 },
	);
	let serverVersion = null;
	try {
		serverVersion = JSON.parse(versionProbe.stdout.trim());
	} catch {
		serverVersion = null;
	}
	checker.add(
		"catalog",
		"fixture-matches-build",
		Boolean(serverVersion) && serverVersion.productVersion === catalog.productVersion && serverVersion.protocolVersion === catalog.protocolVersion,
		"build " + JSON.stringify(serverVersion) + " vs fixture " + catalog.productVersion + "/protocol " + catalog.protocolVersion,
	);

	// --------------------------------------------------------- no-editor smoke script
	const smokePath = path.resolve(distRoot, "..", "scripts", "no-unreal-smoke.mjs");
	if (fs.existsSync(smokePath)) {
		const smoke = runNode([smokePath, path.join(distRoot, "bin.js")], { timeoutMs: 180000, cwd: path.resolve(distRoot, "..") });
		const passCount = (smoke.stdout.match(/\[PASS\]/g) ?? []).length;
		checker.add(
			"smoke",
			"no-unreal-smoke",
			smoke.status === 0 && passCount >= 10,
			"exit " + smoke.status + ", " + passCount + " PASS lines",
		);
		if (smoke.status !== 0) {
			console.log(smoke.stdout.slice(-1500));
			console.log(smoke.stderr.slice(-1500));
		}
	} else {
		checker.add("smoke", "no-unreal-smoke", true, "skipped: scripts/no-unreal-smoke.mjs not present next to dist");
	}

	checker.finish(outPath, {
		distRoot,
		fixture: fixturePath,
		catalogDigest: digest,
		productVersion: catalog.productVersion,
		serverVersion: catalog.serverVersion,
		protocolVersion: catalog.protocolVersion,
		toolCount: tools.length,
		actionCount: actions.length,
		paramCount: params.length,
	});
}

function resolveFixture() {
	const explicit = args.get("fixture");
	if (explicit) {
		const resolved = path.resolve(explicit);
		return fs.existsSync(resolved) ? resolved : null;
	}
	const fixturesDir = path.join(__dirname, "fixtures");
	if (!fs.existsSync(fixturesDir)) {
		return null;
	}
	const candidates = fs
		.readdirSync(fixturesDir)
		.filter((name) => /^catalog-.*\.json$/.test(name))
		.sort();
	if (!candidates.length) {
		return null;
	}
	return path.join(fixturesDir, candidates[candidates.length - 1]);
}

function pathToUrl(filePath) {
	return pathToFileURL(filePath).href;
}
