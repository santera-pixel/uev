import { runWorldEffectsSplineScenarios } from "./world-effects-splines-smoke.mjs"
import { runWorldLightingScenarios } from "./world-lighting-smoke.mjs"
import { runWorldNavigationVolumeScenarios } from "./world-navigation-volume-smoke.mjs"

export async function runWorldActorScenarios(ctx) {
	const {
		options,
		addCleanup,
		safeDeleteActor,
		paths: { tintableMaterialPath, debugTintMaterialPath },
	} = ctx

	const state = {
		lightActorName: `${options.prefix}_PointLight`,
		directionalLightActorName: `${options.prefix}_DirectionalLight`,
		spotLightActorName: `${options.prefix}_SpotLight`,
		navBoundsVolumeName: `${options.prefix}_NavBounds`,
		navModifierVolumeName: `${options.prefix}_NavModifier`,
		navLinkProxyName: `${options.prefix}_NavLinkProxy`,
		triggerVolumeName: `${options.prefix}_TriggerVolume`,
		blockingVolumeName: `${options.prefix}_BlockingVolume`,
		physicsVolumeName: `${options.prefix}_PhysicsVolume`,
		audioVolumeName: `${options.prefix}_AudioVolume`,
		debugShapeActorName: `cube_${options.prefix}_DebugShape`,
		splineActorName: `${options.prefix}_SplineHost`,
		tintableMaterialPath,
		debugTintMaterialPath,
	}

	for (const actorName of [
		state.lightActorName,
		state.directionalLightActorName,
		state.spotLightActorName,
		state.navBoundsVolumeName,
		state.navModifierVolumeName,
		state.navLinkProxyName,
		state.triggerVolumeName,
		state.blockingVolumeName,
		state.physicsVolumeName,
		state.audioVolumeName,
		state.debugShapeActorName,
		state.splineActorName,
	]) {
		addCleanup(`Delete actor ${actorName}`, () => safeDeleteActor(actorName))
	}

	await runWorldLightingScenarios(ctx, state)
	await runWorldNavigationVolumeScenarios(ctx, state)
	await runWorldEffectsSplineScenarios(ctx, state)
}
