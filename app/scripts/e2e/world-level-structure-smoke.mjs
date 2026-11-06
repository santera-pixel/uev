import { runWorldLevelStructureLargeScenarios } from "./world-level-structure-large-smoke.mjs"
import { runWorldLevelStructureSmallScenarios } from "./world-level-structure-small-smoke.mjs"

export async function runWorldLevelStructureScenarios(ctx, state) {
	await runWorldLevelStructureSmallScenarios(ctx, state)
	await runWorldLevelStructureLargeScenarios(ctx, state)
}
