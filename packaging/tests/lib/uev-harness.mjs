#!/usr/bin/env node
// Shared, zero-dependency harness for the UEV test matrix.
//
// Every suite in this folder talks to the UEV control API over HTTP using the
// descriptor the server writes at start-up (AppData/Local/UEV/control.json).
// Keeping the descriptor lookup, the request envelope and the reporting in one
// module means the matrix, contract and perf suites cannot drift apart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const DEFAULT_PORT = 8765;

/** Parse --flag value / --flag=value / --switch arguments. */
export function parseArgv(argv = process.argv.slice(2)) {
	const values = new Map();
	const switches = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) {
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq !== -1) {
			values.set(body.slice(0, eq), body.slice(eq + 1));
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			values.set(body, next);
			index += 1;
		} else {
			switches.add(body);
		}
	}
	return {
		values,
		switches,
		get(name, fallback) {
			return values.has(name) ? values.get(name) : fallback;
		},
		flag(name) {
			return switches.has(name) || values.get(name) === "true";
		},
	};
}

export function descriptorCandidates() {
	const candidates = [];
	const override = process.env.UEV_CONTROL_DESCRIPTOR;
	if (override) {
		candidates.push(override);
	}
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		candidates.push(path.join(localAppData, "UEV", "control.json"));
	}
	return [...new Set(candidates.filter(Boolean))];
}

/** Resolve the control descriptor, honouring --descriptor / --port / --token overrides. */
export function loadDescriptor(args = parseArgv()) {
	const explicit = args.get("descriptor");
	if (explicit) {
		const resolved = path.resolve(explicit);
		if (!fs.existsSync(resolved)) {
			throw new Error("Descriptor not found: " + resolved);
		}
		const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
		return { ...raw, descriptorPath: resolved, host: raw.host ?? "127.0.0.1", port: raw.port ?? DEFAULT_PORT };
	}
	for (const candidate of descriptorCandidates()) {
		if (!fs.existsSync(candidate)) {
			continue;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
			if (!raw.token) {
				continue;
			}
			const port = Number(args.get("port") ?? raw.port ?? DEFAULT_PORT);
			const token = args.get("token") ?? raw.token;
			return { ...raw, descriptorPath: candidate, host: raw.host ?? "127.0.0.1", port, token };
		} catch {
			// Try the next candidate: a half-written descriptor is not fatal.
		}
	}
	throw new Error(
		"No UEV control descriptor found. Start the stack (run-stack.ps1 -Profile supervised -ControlPort 8765) or pass --descriptor <path>.",
	);
}

export function baseUrl(descriptor) {
	return "http://" + (descriptor.host ?? "127.0.0.1") + ":" + (descriptor.port ?? DEFAULT_PORT);
}

/**
 * Control-API client. /api/call wraps the tool result as { text: "<json string>" },
 * so call() unwraps it and keeps the transport latency alongside the payload.
 */
export function createClient(descriptor) {
	const root = baseUrl(descriptor);
	const headers = {
		Authorization: "Bearer " + descriptor.token,
		"Content-Type": "application/json",
	};

	async function getJson(pathname, options = {}) {
		const timeoutMs = options.timeoutMs ?? 60000;
		const started = performance.now();
		const response = await fetch(root + pathname, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		const ms = performance.now() - started;
		let payload = null;
		let parseError = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch (error) {
			parseError = error instanceof Error ? error.message : String(error);
		}
		return { status: response.status, payload, ms, text, parseError };
	}

	async function postOnce(tool, action, params = {}, options = {}) {
		const timeoutMs = options.timeoutMs ?? 120000;
		const started = performance.now();
		const response = await fetch(root + "/api/call", {
			method: "POST",
			headers,
			body: JSON.stringify({ tool, action, params }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const envelopeText = await response.text();
		const ms = performance.now() - started;
		let envelope = null;
		try {
			envelope = envelopeText ? JSON.parse(envelopeText) : null;
		} catch {
			envelope = null;
		}
		let payload = null;
		let innerError = null;
		const inner = envelope && typeof envelope.text === "string" ? envelope.text : null;
		if (inner !== null) {
			try {
				payload = JSON.parse(inner);
			} catch (error) {
				innerError = error instanceof Error ? error.message : String(error);
				payload = inner;
			}
		} else {
			payload = envelope;
		}
		return {
			status: response.status,
			envelope,
			payload,
			ms,
			text: inner ?? envelopeText,
			innerError,
			succeeded:
				response.status === 200 && payload !== null && typeof payload === "object" && payload.success !== false,
		};
	}

	async function call(tool, action, params = {}, options = {}) {
		const first = await postOnce(tool, action, params, options);
		// The supervised profile pauses mutating actions after repeated failures and
		// answers HTTP 409 (safety.circuit_open). One successful read re-arms it, so
		// recover instead of failing the run on a breaker left open by an earlier
		// suite that was testing refusals on purpose.
		if (first.status === 409) {
			const breaker = await postOnce("manage_editor", "is_pie_running", {}, { timeoutMs: 30000 });
			if (breaker.status === 200) {
				const second = await postOnce(tool, action, params, options);
				return { ...second, recoveredFromBreaker: true };
			}
			return { ...first, breakerStillOpen: true };
		}
		return first;
	}

	return { root, call, getJson };
}

/** Read a dotted path (a.b.0.c) out of a parsed payload. */
export function readPath(value, dotted) {
	if (!dotted) {
		return value;
	}
	let cursor = value;
	for (const key of String(dotted).split(".")) {
		if (cursor === null || cursor === undefined) {
			return undefined;
		}
		if (Array.isArray(cursor)) {
			const index = Number(key);
			cursor = Number.isInteger(index) ? cursor[index] : undefined;
		} else if (typeof cursor === "object") {
			cursor = cursor[key];
		} else {
			return undefined;
		}
	}
	return cursor;
}

export function percentile(values, fraction) {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index];
}

/** Collects checks and prints a stable, greppable report. */
export class Checker {
	constructor(title) {
		this.title = title;
		this.checks = [];
		this.startedAt = new Date().toISOString();
	}

	add(group, id, ok, detail = "", ms = null) {
		const check = {
			group,
			id,
			ok: Boolean(ok),
			detail: String(detail ?? ""),
			ms: ms === null || ms === undefined ? null : Number(Number(ms).toFixed(1)),
		};
		this.checks.push(check);
		const tag = check.ok ? "PASS" : "FAIL";
		const timing = check.ms === null ? "" : " (" + check.ms + "ms)";
		console.log("[" + group + "] " + tag + " " + id + timing + (check.detail ? " - " + check.detail : ""));
		return check.ok;
	}

	fail(group, id, detail) {
		return this.add(group, id, false, detail);
	}

	get passed() {
		return this.checks.filter((check) => check.ok).length;
	}

	get failed() {
		return this.checks.length - this.passed;
	}

	summary() {
		return {
			title: this.title,
			startedAt: this.startedAt,
			finishedAt: new Date().toISOString(),
			total: this.checks.length,
			passed: this.passed,
			failed: this.failed,
			checks: this.checks,
		};
	}

	printSummary() {
		console.log("");
		console.log(this.title + ": " + this.passed + " passed, " + this.failed + " failed (" + this.checks.length + " checks)");
		if (this.failed > 0) {
			console.log("");
			for (const check of this.checks.filter((entry) => !entry.ok)) {
				console.log("  FAILED " + check.group + " / " + check.id + ": " + check.detail);
			}
		}
	}

	finish(outPath, extra = {}) {
		this.printSummary();
		const report = { ...this.summary(), ...extra };
		if (outPath) {
			writeArtifact(outPath, report);
			console.log("Results written to " + outPath);
		}
		process.exitCode = this.failed > 0 ? 1 : 0;
		return report;
	}
}

export function writeArtifact(outPath, data) {
	const resolved = path.resolve(outPath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, JSON.stringify(data, null, "\t") + "\n", "utf8");
	return resolved;
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function includesIgnoreCase(haystack, needle) {
	return String(haystack ?? "")
		.toLowerCase()
		.includes(String(needle ?? "").toLowerCase());
}
