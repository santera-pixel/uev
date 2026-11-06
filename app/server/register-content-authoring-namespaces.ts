import { RegistrationContext } from "./registration-context.js"
import { registerContentBlueprintWidgetNamespaces } from "./register-content-blueprint-widget-namespaces.js"

export function registerContentAuthoringNamespaces(ctx: RegistrationContext) {
	registerContentBlueprintWidgetNamespaces(ctx)
}
