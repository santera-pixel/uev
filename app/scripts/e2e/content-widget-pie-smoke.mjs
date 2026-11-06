import { runContentPieRuntimeScenarios } from "./content-pie-runtime-smoke.mjs"
import { runContentWidgetAuthoringScenarios } from "./content-widget-authoring-smoke.mjs"

export async function runContentWidgetPieScenarios(state) {
	await runContentWidgetAuthoringScenarios(state)
	await runContentPieRuntimeScenarios(state)
}
