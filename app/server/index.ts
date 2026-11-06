import { createRegistrationRuntime, shutdownSafety } from "./registration-context.js"
import { markStartup } from "./startup-timing.js"
import { shutdownRemoteExecution } from "./remote-execution.js"
import { createUevServer } from "./server-factory.js"

export { shutdownRemoteExecution, shutdownSafety }
export { createRegistrationRuntime } from "./registration-context.js"
export { createUevServer, type RegistrationRuntime } from "./server-factory.js"

markStartup("imports")

export const sharedRuntime = createRegistrationRuntime()
markStartup("runtime")

export const { server, context: registrationContext } = createUevServer(sharedRuntime)
markStartup("registry")

server.resource("docs", "docs://unreal_python", async () => {
	return {
		contents: [
			{
				uri: "https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/?application_version=4.27",
				text: "Unreal Engine 4.27 Python API Documentation",
			},
		],
	}
})
