import { runWorldEnvironmentScenarios } from "./world-environment-smoke.mjs"
import { runWorldGeometryScenarios } from "./world-geometry-smoke.mjs"

export async function runWorldEnvironmentGeometryScenarios(ctx, state) {
	await runWorldEnvironmentScenarios(ctx, state)
	await runWorldGeometryScenarios(ctx, state)
}
