import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerDirectTools } from "./register-direct-tools.js"
import { registerToolNamespaces } from "./register-namespaces.js"
import {
	createRegistrationContext,
	createRegistrationRuntime,
	type RegistrationRuntime,
} from "./registration-context.js"
import { projectVersion } from "./version.js"
import { productName, productTitle } from "./identity.js"

export interface UevServerBundle {
	server: McpServer
	context: ReturnType<typeof createRegistrationContext>
}

export function createUevServer(runtime: RegistrationRuntime = createRegistrationRuntime()): UevServerBundle {
	const server = new McpServer({
		name: productName,
		description: productTitle + " for UE4.27.2 with UE4/UE5 editor scripting compatibility helpers",
		version: projectVersion,
	})
	const context = createRegistrationContext(server, runtime)

	registerDirectTools(context)
	registerToolNamespaces(context)

	return { server, context }
}

export { createRegistrationRuntime, type RegistrationRuntime }
