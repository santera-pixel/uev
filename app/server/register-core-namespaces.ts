import { RegistrationContext } from "./registration-context.js"
import { registerCoreAssetActorNamespaces } from "./register-core-asset-actor-namespaces.js"
import { registerCoreEditorSystemNamespaces } from "./register-core-editor-system-namespaces.js"
import { registerCoreSourceControlNamespaces } from "./register-core-source-control-namespaces.js"

export function registerCoreNamespaces(ctx: RegistrationContext) {
	registerCoreAssetActorNamespaces(ctx)
	registerCoreEditorSystemNamespaces(ctx)
	registerCoreSourceControlNamespaces(ctx)
}
