export async function runWorldEffectsSplineScenarios(ctx, state) {
	const { options, path, runStep, callJsonTool, assert } = ctx
	const { debugShapeActorName, splineActorName, tintableMaterialPath, debugTintMaterialPath } = state

	await runStep("Spawn a debug shape through manage_effect", async () => {
		const effectResult = await callJsonTool("manage_effect", {
			action: "spawn_debug_shape",
			params: {
				shape: "cube",
				name: `${options.prefix}_DebugShape`,
				location: { x: 640, y: 320, z: 100 },
				scale: { x: 1.25, y: 1.25, z: 1.25 },
			},
		})
		assert(
			effectResult.actor_label === debugShapeActorName,
			"manage_effect spawn_debug_shape did not create the expected actor label",
		)
	})

	await runStep("Apply a material to the debug shape through manage_effect", async () => {
		const applyResult = await callJsonTool("manage_effect", {
			action: "apply_material",
			params: {
				name: debugShapeActorName,
				material_path: tintableMaterialPath,
			},
		})
		assert(applyResult.actor?.label === debugShapeActorName, "manage_effect apply_material returned the wrong actor")
		assert(
			applyResult.material?.path === tintableMaterialPath,
			"manage_effect apply_material returned the wrong material path",
		)
	})

	await runStep("Tint the debug shape through manage_effect", async () => {
		const tintResult = await callJsonTool("manage_effect", {
			action: "tint_debug_shape",
			params: {
				name: debugShapeActorName,
				color: { r: 0.9, g: 0.2, b: 0.2, a: 1.0 },
				material_path: tintableMaterialPath,
				parameter_name: "Color",
				instance_name: path.basename(debugTintMaterialPath),
				instance_path: path.dirname(debugTintMaterialPath).replace(/\\/g, "/"),
			},
		})
		assert(tintResult.actor?.label === debugShapeActorName, "manage_effect tint_debug_shape returned the wrong actor")
		assert(
			tintResult.material?.path === debugTintMaterialPath,
			`manage_effect tint_debug_shape returned an unexpected material path: ${tintResult.material?.path}`,
		)
		assert(
			typeof tintResult.parameter_name === "string" && tintResult.parameter_name.length > 0,
			"manage_effect tint_debug_shape did not report a parameter name",
		)
	})

	await runStep("Delete the debug shape through manage_effect", async () => {
		await callJsonTool("manage_effect", {
			action: "delete_debug_shape",
			params: { name: debugShapeActorName },
		})
	})

	await runStep("Spawn a spline host actor through manage_splines", async () => {
		const splineSpawnResult = await callJsonTool("manage_splines", {
			action: "spawn_actor",
			params: {
				object_class: "/Script/Engine.Actor",
				name: splineActorName,
				location: { x: 760, y: 320, z: 100 },
			},
		})
		assert(
			splineSpawnResult.actor_label === splineActorName,
			"manage_splines spawn_actor did not create the expected actor label",
		)
	})

	await runStep("Transform the spline host actor through manage_splines", async () => {
		const splineTransformResult = await callJsonTool("manage_splines", {
			action: "transform_actor",
			params: {
				name: splineActorName,
				location: { x: 800, y: 340, z: 120 },
			},
		})
		assert(
			Math.abs(Number(splineTransformResult.actor?.location?.x ?? 0) - 800) < 0.1,
			"manage_splines transform_actor did not update the expected X location",
		)
	})

	await runStep("Delete the spline host actor through manage_splines", async () => {
		await callJsonTool("manage_splines", {
			action: "delete_actor",
			params: { name: splineActorName },
		})
	})
}
