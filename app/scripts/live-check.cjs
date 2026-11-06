const { RemoteExecution, RemoteExecutionConfig } = require("unreal-remote-execution")

const config = new RemoteExecutionConfig(
	0,
	["239.0.0.1", 6766],
	"127.0.0.1",
	["127.0.0.1", 6776],
)

const runtime = new RemoteExecution(config)

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	])

async function main() {
	await withTimeout(runtime.start(), 5000, "start")
	const node = await withTimeout(runtime.getFirstRemoteNode(2000, 5000), 10000, "discovery")
	await withTimeout(runtime.openCommandConnection(node), 5000, "command connection")

	const result = await withTimeout(
		runtime.runCommand(
			'import unreal\nprint(unreal.SystemLibrary.get_engine_version())\nprint(unreal.Paths.get_project_file_path())',
		),
		10000,
		"runCommand",
	)

	if (!result.success) {
		throw new Error(`Command failed: ${JSON.stringify(result.result)}`)
	}

	console.log(result.output.map((line) => line.output).join("\n"))
}

main()
	.then(() => {
		try {
			runtime.closeCommandConnection()
		} catch {}
		try {
			runtime.stop()
		} catch {}
		process.exit(0)
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		try {
			runtime.closeCommandConnection()
		} catch {}
		try {
			runtime.stop()
		} catch {}
		process.exit(1)
	})
