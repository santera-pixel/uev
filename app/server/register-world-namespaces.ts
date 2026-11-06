import { RegistrationContext } from "./registration-context.js"
import { registerWorldBuildingNamespaces } from "./register-world-building-namespaces.js"
import { registerWorldUtilityNamespaces } from "./register-world-utility-namespaces.js"

export function registerWorldNamespaces(ctx: RegistrationContext) {
	registerWorldUtilityNamespaces(ctx)
	registerWorldBuildingNamespaces(ctx)
}
