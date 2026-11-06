import { RegistrationContext } from "./registration-context.js"
import { registerWorldEffectsSplineNamespaces } from "./register-world-effects-splines-namespaces.js"
import { registerWorldLightingNamespaces } from "./register-world-lighting-namespaces.js"
import { registerWorldNavigationVolumeNamespaces } from "./register-world-navigation-volume-namespaces.js"

export function registerWorldUtilityNamespaces(ctx: RegistrationContext) {
	registerWorldLightingNamespaces(ctx)
	registerWorldNavigationVolumeNamespaces(ctx)
	registerWorldEffectsSplineNamespaces(ctx)
}
