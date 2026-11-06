import { RegistrationContext } from "./registration-context.js"
import { registerAiDebugNamespace } from "./register-ai-debug.js"
import { registerBuildNamespace } from "./register-build.js"
import { registerCodeNamespace } from "./register-code.js"
import { registerContentNamespaces } from "./register-content-namespaces.js"
import { registerCoreNamespaces } from "./register-core-namespaces.js"
import { registerDdgiProfileNamespaces } from "./register-ddgi-profile.js"
import { registerDebugHistoryNamespaces } from "./register-debug-history.js"
import { registerEditorToolNamespace } from "./register-editor-tool-namespace.js"
import { registerGameplayNamespaces } from "./register-gameplay-namespaces.js"
import { registerStackNamespaces } from "./register-stack-namespaces.js"
import { registerSubstrateNamespaces } from "./register-substrate.js"
import { registerViteAuditNamespaces } from "./register-vite-audit.js"
import { registerWorldNamespaces } from "./register-world-namespaces.js"

export function registerToolNamespaces(ctx: RegistrationContext) {
	registerSubstrateNamespaces(ctx)
	registerDebugHistoryNamespaces(ctx)
	registerViteAuditNamespaces(ctx)
	registerDdgiProfileNamespaces(ctx)
	registerBuildNamespace(ctx)
	registerCodeNamespace(ctx)
	registerAiDebugNamespace(ctx)
	registerCoreNamespaces(ctx)
	registerWorldNamespaces(ctx)
	registerContentNamespaces(ctx)
	registerGameplayNamespaces(ctx)
	registerEditorToolNamespace(ctx)
	registerStackNamespaces(ctx)
}
