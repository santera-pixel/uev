#!/usr/bin/env node
// Named-pipe listener probe for the UEV supervisor.
//
// 1.7.0 serves exactly one pipe, \\.\pipe\uev-supervisor. This probe proves that at runtime:
// it lists the live pipe namespace (authoritative: a listener object exists) and also tries a
// real client connection. Any other supervisor listener therefore fails a verification run
// instead of being assumed.
//
// Usage:
//   node pipe-probe.mjs                                   # report the supervisor pipe
//   node pipe-probe.mjs --expect uev-supervisor:present
//
// Exit code is 0 when every --expect matches (or no expectation was given), 1 otherwise.

import fs from "node:fs/promises";
import net from "node:net";
import process from "node:process";

const PIPE_NAMESPACE = "\\\\.\\pipe\\";

function parseArgv(argv) {
	const args = new Map();
	const expects = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		if (key === "expect") {
			expects.push(argv[index + 1]);
			index += 1;
			continue;
		}
		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			args.set(key, next);
			index += 1;
		} else {
			args.set(key, true);
		}
	}
	return { args, expects };
}

async function listPipes() {
	try {
		const entries = await fs.readdir(PIPE_NAMESPACE);
		return { names: entries.map((entry) => entry.replace(/^.*\\\\/, "")), error: undefined };
	} catch (error) {
		return { names: [], error: (error?.code ?? "error") + ": " + (error?.message ?? String(error)) };
	}
}

function tryConnect(name, timeoutMs = 800) {
	const path = "\\\\.\\pipe\\" + name;
	return new Promise((resolve) => {
		const socket = net.connect({ path });
		let settled = false;
		const timer = setTimeout(() => finish("timeout", "connect did not answer within " + timeoutMs + " ms"), timeoutMs);
		function finish(state, detail) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ state, detail });
		}
		socket.once("connect", () => finish("connected", "client connection accepted"));
		socket.once("error", (error) => {
			const code = error?.code ?? "error";
			finish(code === "ENOENT" || code === "ECONNREFUSED" ? "absent" : "error", code + ": " + (error?.message ?? String(error)));
		});
	});
}

const { args, expects } = parseArgv(process.argv.slice(2));
const target = typeof args.get("pipe") === "string" ? [args.get("pipe")] : ["uev-supervisor"];
const registry = await listPipes();
const results = [];
for (const name of target) {
	const listed = registry.names.includes(name);
	const attempt = await tryConnect(name);
	results.push({
		pipe: name,
		path: PIPE_NAMESPACE + name,
		state: listed ? "present" : "absent",
		detail: listed ? "listed in the live pipe namespace" : "not listed in the live pipe namespace",
		connect: attempt.state,
		connectDetail: attempt.detail,
	});
}

const report = {
	ok: true,
	namespace: PIPE_NAMESPACE,
	namespaceError: registry.error,
	namespacePipes: registry.names.filter((name) => name.includes("supervisor")),
	probes: results,
	expectations: expects.map((entry) => {
		const [pipe, wanted] = String(entry ?? "").split(":");
		const result = results.find((candidate) => candidate.pipe === pipe);
		const matched = result ? result.state === wanted : false;
		return { pipe, wanted, matched, state: result?.state ?? "not-probed" };
	}),
};
report.ok = report.expectations.every((entry) => entry.matched);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
	for (const entry of report.expectations.filter((candidate) => !candidate.matched)) {
		console.error("[FAIL] " + entry.pipe + " is " + entry.state + ", expected " + entry.wanted);
	}
}
process.exitCode = report.ok ? 0 : 1;
