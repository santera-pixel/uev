import { runCoreAssetSystemEditorScenarios } from "./core-asset-system-editor-smoke.mjs"
import { runCoreProjectMapScenarios } from "./core-project-map-smoke.mjs"

export async function runCoreProjectEditorScenarios(ctx) {
	await runCoreProjectMapScenarios(ctx)
	await runCoreAssetSystemEditorScenarios(ctx)
}
