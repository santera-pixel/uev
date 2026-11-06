export async function runContentAnimationPhysicsScenarios(state) {
	const {
		runStep,
		callJsonTool,
		assert,
		basicShapeMaterialPath,
		blueprintPath,
		blueprintActorName,
		physicsBlueprintActorName,
	} = state

	await runStep("Set Blueprint physics properties through manage_physics", async () => {
		const animationPhysicsResult = await callJsonTool("manage_physics", {
			action: "set_physics_properties",
			params: {
				blueprint_name: blueprintPath,
				component_name: "SmokeMesh",
				simulate_physics: true,
				gravity_enabled: true,
				mass: 3.0,
				linear_damping: 0.15,
				angular_damping: 0.05,
			},
		})
		assert(
			animationPhysicsResult.blueprint === blueprintPath,
			"manage_physics set_physics_properties returned the wrong blueprint path",
		)
		assert(
			animationPhysicsResult.component?.name === "SmokeMesh",
			"manage_physics set_physics_properties returned the wrong component summary",
		)
	})

	await runStep("Compile the Blueprint through manage_physics", async () => {
		const animationCompileResult = await callJsonTool("manage_physics", {
			action: "compile_blueprint",
			params: {
				blueprint_name: blueprintPath,
			},
		})
		assert(
			animationCompileResult.blueprint === blueprintPath,
			"manage_physics compile_blueprint returned the wrong blueprint path",
		)
		assert(
			animationCompileResult.compiled === true || animationCompileResult.saved === true,
			"manage_physics compile_blueprint did not compile or save the Blueprint",
		)
	})

	await runStep("Spawn the Blueprint through manage_actor", async () => {
		const blueprintSpawnResult = await callJsonTool("manage_actor", {
			action: "spawn_blueprint",
			params: {
				blueprint_name: blueprintPath,
				name: blueprintActorName,
				location: { x: 180, y: -180, z: 150 },
			},
		})
		assert(
			blueprintSpawnResult.blueprint === blueprintPath,
			"manage_actor spawn_blueprint returned the wrong blueprint path",
		)
		assert(
			blueprintSpawnResult.actor?.label === blueprintActorName,
			"manage_actor spawn_blueprint did not create the expected actor label",
		)
	})

	await runStep("Spawn a physics-enabled Blueprint actor through manage_physics", async () => {
		const physicsSpawnResult = await callJsonTool("manage_physics", {
			action: "spawn_physics_blueprint_actor",
			params: {
				blueprint_name: blueprintPath,
				name: physicsBlueprintActorName,
				location: { x: 320, y: -220, z: 220 },
				material_path: state.resolvedBlueprintMaterialPath ?? basicShapeMaterialPath,
				simulate_physics: true,
				gravity_enabled: true,
				mass: 3.0,
				linear_damping: 0.15,
				angular_damping: 0.05,
			},
		})
		assert(
			physicsSpawnResult.blueprint === blueprintPath,
			"manage_physics spawn_physics_blueprint_actor returned the wrong blueprint path",
		)
		assert(
			physicsSpawnResult.actor?.label === physicsBlueprintActorName,
			"manage_physics spawn_physics_blueprint_actor did not create the expected actor label",
		)
		assert(
			physicsSpawnResult.physics?.simulate_physics === true,
			"manage_physics spawn_physics_blueprint_actor did not enable physics",
		)
		assert(
			Array.isArray(physicsSpawnResult.materials),
			"manage_physics spawn_physics_blueprint_actor did not return component material info",
		)
	})
}
