import { RegistrationContext } from "./registration-context.js"
import { registerContentAnimationNamespaces } from "./register-content-animation-namespaces.js"
import { registerContentAssetNamespaces } from "./register-content-asset-namespaces.js"
import { registerContentAuthoringNamespaces } from "./register-content-authoring-namespaces.js"
import { registerContentMediaNamespaces } from "./register-content-media-namespaces.js"

export function registerContentNamespaces(ctx: RegistrationContext) {
	registerContentAssetNamespaces(ctx)
	registerContentAnimationNamespaces(ctx)
	registerContentAuthoringNamespaces(ctx)
	registerContentMediaNamespaces(ctx)
}
