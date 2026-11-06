import { runCoreActorMaterialScenarios } from "./core-actor-material-smoke.mjs"
import { runCoreNamespaceScenarios } from "./core-namespace-smoke.mjs"
import { runCoreProjectEditorScenarios } from "./core-project-editor-smoke.mjs"

export async function runCoreScenarios(ctx) {
	await runCoreProjectEditorScenarios(ctx)
	await runCoreActorMaterialScenarios(ctx)
	await runCoreNamespaceScenarios(ctx)
}
