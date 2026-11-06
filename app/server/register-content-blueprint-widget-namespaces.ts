import { RegistrationContext } from "./registration-context.js"
import { registerContentBlueprintNamespaces } from "./register-content-blueprint-namespaces.js"
import { registerContentWidgetNamespaces } from "./register-content-widget-namespaces.js"

export function registerContentBlueprintWidgetNamespaces(ctx: RegistrationContext) {
	registerContentBlueprintNamespaces(ctx)
	registerContentWidgetNamespaces(ctx)
}
