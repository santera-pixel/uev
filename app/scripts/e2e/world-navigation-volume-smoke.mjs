export async function runWorldNavigationVolumeScenarios(ctx, state) {
	const { runStep, callJsonTool, assert } = ctx
	const {
		navBoundsVolumeName,
		navModifierVolumeName,
		navLinkProxyName,
		triggerVolumeName,
		blockingVolumeName,
		physicsVolumeName,
		audioVolumeName,
	} = state

	await runStep("Spawn a nav-mesh bounds volume through manage_navigation", async () => {
		const navVolumeResult = await callJsonTool("manage_navigation", {
			action: "spawn_nav_mesh_bounds_volume",
			params: {
				name: navBoundsVolumeName,
				location: { x: 420, y: 320, z: 0 },
				scale: { x: 4, y: 4, z: 2 },
			},
		})
		assert(
			navVolumeResult.actor_label === navBoundsVolumeName,
			"manage_navigation spawn_nav_mesh_bounds_volume did not create the expected actor label",
		)
	})

	await runStep("Spawn a nav modifier volume through manage_navigation", async () => {
		const navModifierResult = await callJsonTool("manage_navigation", {
			action: "spawn_nav_modifier_volume",
			params: {
				name: navModifierVolumeName,
				location: { x: 470, y: 250, z: 0 },
				scale: { x: 2, y: 2, z: 2 },
			},
		})
		assert(
			navModifierResult.actor_label === navModifierVolumeName,
			"manage_navigation spawn_nav_modifier_volume did not create the expected actor label",
		)
	})

	await runStep("Spawn a nav link proxy through manage_navigation", async () => {
		const navLinkResult = await callJsonTool("manage_navigation", {
			action: "spawn_nav_link_proxy",
			params: {
				name: navLinkProxyName,
				location: { x: 520, y: 250, z: 0 },
			},
		})
		assert(
			navLinkResult.actor_label === navLinkProxyName,
			"manage_navigation spawn_nav_link_proxy did not create the expected actor label",
		)
	})

	await runStep("Inspect navigation through manage_navigation", async () => {
		const navigationInfo = await callJsonTool("manage_navigation", {
			action: "inspect_navigation",
			params: {},
		})
		assert(
			typeof navigationInfo.map_name === "string" && navigationInfo.map_name.length > 0,
			"manage_navigation inspect_navigation did not return map_name",
		)
		assert(
			Number.isFinite(navigationInfo.total_actors),
			"manage_navigation inspect_navigation did not return total_actors",
		)
	})

	await runStep("Delete the nav-mesh bounds volume", async () => {
		await callJsonTool("manage_actor", {
			action: "delete",
			params: { name: navBoundsVolumeName },
		})
	})

	await runStep("Delete the nav modifier volume", async () => {
		await callJsonTool("manage_actor", {
			action: "delete",
			params: { name: navModifierVolumeName },
		})
	})

	await runStep("Delete the nav link proxy", async () => {
		await callJsonTool("manage_actor", {
			action: "delete",
			params: { name: navLinkProxyName },
		})
	})

	await runStep("Spawn a trigger volume through manage_volumes", async () => {
		const triggerVolumeResult = await callJsonTool("manage_volumes", {
			action: "spawn_trigger_volume",
			params: {
				name: triggerVolumeName,
				location: { x: 520, y: 320, z: 0 },
				scale: { x: 2, y: 2, z: 2 },
			},
		})
		assert(
			triggerVolumeResult.actor_label === triggerVolumeName,
			"manage_volumes spawn_trigger_volume did not create the expected actor label",
		)
	})

	await runStep("Spawn a blocking volume through manage_volumes", async () => {
		const blockingVolumeResult = await callJsonTool("manage_volumes", {
			action: "spawn_blocking_volume",
			params: {
				name: blockingVolumeName,
				location: { x: 600, y: 260, z: 0 },
				scale: { x: 2, y: 2, z: 2 },
			},
		})
		assert(
			blockingVolumeResult.actor_label === blockingVolumeName,
			"manage_volumes spawn_blocking_volume did not create the expected actor label",
		)
	})

	await runStep("Spawn a physics volume through manage_volumes", async () => {
		const physicsVolumeResult = await callJsonTool("manage_volumes", {
			action: "spawn_physics_volume",
			params: {
				name: physicsVolumeName,
				location: { x: 650, y: 260, z: 0 },
				scale: { x: 2, y: 2, z: 2 },
			},
		})
		assert(
			physicsVolumeResult.actor_label === physicsVolumeName,
			"manage_volumes spawn_physics_volume did not create the expected actor label",
		)
	})

	await runStep("Spawn an audio volume through manage_volumes", async () => {
		const audioVolumeResult = await callJsonTool("manage_volumes", {
			action: "spawn_audio_volume",
			params: {
				name: audioVolumeName,
				location: { x: 700, y: 260, z: 0 },
				scale: { x: 2, y: 2, z: 2 },
			},
		})
		assert(
			audioVolumeResult.actor_label === audioVolumeName,
			"manage_volumes spawn_audio_volume did not create the expected actor label",
		)
	})

	await runStep("Transform the trigger volume through manage_volumes", async () => {
		const transformVolumeResult = await callJsonTool("manage_volumes", {
			action: "transform_volume",
			params: {
				name: triggerVolumeName,
				location: { x: 560, y: 320, z: 32 },
				scale: { x: 3, y: 2, z: 2 },
			},
		})
		assert(
			Math.abs(Number(transformVolumeResult.actor?.location?.x ?? 0) - 560) < 0.1,
			"manage_volumes transform_volume did not update the expected X location",
		)
	})

	await runStep("Delete the trigger volume through manage_volumes", async () => {
		await callJsonTool("manage_volumes", {
			action: "delete_volume",
			params: { name: triggerVolumeName },
		})
	})

	await runStep("Delete the blocking volume through manage_volumes", async () => {
		await callJsonTool("manage_volumes", {
			action: "delete_volume",
			params: { name: blockingVolumeName },
		})
	})

	await runStep("Delete the physics volume through manage_volumes", async () => {
		await callJsonTool("manage_volumes", {
			action: "delete_volume",
			params: { name: physicsVolumeName },
		})
	})

	await runStep("Delete the audio volume through manage_volumes", async () => {
		await callJsonTool("manage_volumes", {
			action: "delete_volume",
			params: { name: audioVolumeName },
		})
	})
}
