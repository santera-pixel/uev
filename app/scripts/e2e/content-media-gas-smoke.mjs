import { runContentAudioGasScenarios } from "./content-audio-gas-smoke.mjs"
import { runContentSequenceBehaviorScenarios } from "./content-sequence-behavior-smoke.mjs"

export async function runContentMediaGasScenarios(state) {
	await runContentSequenceBehaviorScenarios(state)
	await runContentAudioGasScenarios(state)
}
