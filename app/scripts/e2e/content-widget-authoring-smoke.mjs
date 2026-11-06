import { runContentWidgetAdvancedScenarios } from "./content-widget-advanced-smoke.mjs"
import { runContentWidgetBasicScenarios } from "./content-widget-basic-smoke.mjs"

export async function runContentWidgetAuthoringScenarios(state) {
	const { options, widgetPath } = state

	const { widgetAuthoringUnsupportedReason } = await runContentWidgetBasicScenarios(state)
	if (widgetAuthoringUnsupportedReason) {
		return
	}

	await runContentWidgetAdvancedScenarios(state)

	if (options.keepAssets) {
		console.log(`[INFO] Kept Widget Blueprint asset: ${widgetPath}`)
	}
}
