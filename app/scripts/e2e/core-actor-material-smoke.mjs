import { runCoreDirectActorScenarios } from "./core-direct-actor-smoke.mjs"
import { runCoreManagedActorMaterialScenarios } from "./core-managed-actor-material-smoke.mjs"

export async function runCoreActorMaterialScenarios(ctx) {
	await runCoreDirectActorScenarios(ctx)
	await runCoreManagedActorMaterialScenarios(ctx)
}
