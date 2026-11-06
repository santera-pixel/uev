const net = require("node:net")

const { RemoteExecution, RemoteExecutionConfig } = require("unreal-remote-execution")

const pipePath = "\\\\.\\pipe\\uev-supervisor"
const callId = `freeze-test-${Date.now()}`

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	])

async function main() {
	const pipe = net.createConnection(pipePath)
	pipe.on("error", () => {})
	await withTimeout(
		new Promise((resolve) => pipe.once("connect", resolve)),
		2000,
		"supervisor pipe connect",
	)
	pipe.write(
		`${JSON.stringify({
			type: "call_start",
			id: callId,
			tool: "test",
			action: "freeze",
			timeoutMs: 2000,
		})}\n`,
	)
	console.log(`CALL_START ${callId} (no call_end will be sent)`)

	const config = new RemoteExecutionConfig(
		0,
		["239.0.0.1", 6766],
		"127.0.0.1",
		["127.0.0.1", 6776],
	)
	const runtime = new RemoteExecution(config)

	await withTimeout(runtime.start(), 5000, "runtime.start")
	const node = await withTimeout(runtime.getFirstRemoteNode(2000, 5000), 10000, "discovery")
	await withTimeout(runtime.openCommandConnection(node), 5000, "command connection")

	runtime
		.runCommand("import time\nwhile True:\n    time.sleep(1)")
		.catch(() => {})

	console.log("FREEZE_COMMAND_SENT")
	await new Promise((resolve) => setTimeout(resolve, 1500))
	process.exit(0)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
