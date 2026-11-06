import { runContentDataTextureScenarios } from "./content-data-texture-smoke.mjs"
import { runContentMediaGasScenarios } from "./content-media-gas-smoke.mjs"

export async function runContentAssetScenarios(state) {
	await runContentMediaGasScenarios(state)
	await runContentDataTextureScenarios(state)
}
