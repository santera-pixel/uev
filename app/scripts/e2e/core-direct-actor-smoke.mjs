export async function runCoreDirectActorScenarios(ctx) {
	const { options, addCleanup, runStep, callJsonTool, assert, safeDeleteActor } = ctx

	const directActorName = `${options.prefix}_DirectActor`
	addCleanup(`Delete actor ${directActorName}`, () => safeDeleteActor(directActorName))

	await runStep("Spawn a direct-tool smoke-test actor", async () => {
		const directCreateResult = await callJsonTool("editor_create_object", {
			object_class: "StaticMeshActor",
			object_name: directActorName,
			location: { x: 0, y: -300, z: 150 },
		})
		assert(
			directCreateResult.actor_label === directActorName,
			"editor_create_object did not create the expected actor label",
		)
	})

	await runStep("Update the direct-tool smoke-test actor", async () => {
		const directUpdateResult = await callJsonTool("editor_update_object", {
			actor_name: directActorName,
			location: { x: 300, y: -300, z: 150 },
		})
		assert(
			Math.abs(Number(directUpdateResult.location?.x ?? 0) - 300) < 0.1,
			"editor_update_object did not update the expected X location",
		)
	})

	await runStep("Delete the direct-tool smoke-test actor", async () => {
		const directDeleteResult = await callJsonTool("editor_delete_object", {
			actor_names: directActorName,
		})
		assert(
			directDeleteResult.deleted_actor?.actor_label === directActorName,
			"editor_delete_object did not delete the expected actor",
		)
	})
}
