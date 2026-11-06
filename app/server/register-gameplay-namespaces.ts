import { z } from "zod"

import {
	blueprintNameShape,
	assetLookupSchema,
	requireAtLeastOneValue,
	searchAssetsShape,
	vector3TransformShape,
} from "./namespace-action-schema-fragments.js"
import { RegistrationContext } from "./registration-context.js"
import { tryRunCommand } from "./remote-execution.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const parseToolJson = (text: string): Record<string, any> | undefined => {
	try {
		return JSON.parse(text) as Record<string, any>
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1)) as Record<string, any>
			} catch {
				return undefined
			}
		}
		return undefined
	}
}

export function registerGameplayNamespaces(ctx: RegistrationContext) {
	const {
		blueprintNameParam,
		directDispatch,
		editorTools,
		optionalStringParam,
		pythonDispatch,
		registerToolNamespace,
		requiredStringParam,
		searchAssetsCommand,
		toRotatorArray,
		toVector3Array,
		vector3InputSchema,
		toolDescription,
	} = ctx

	const blueprintTargetNoNameShape = {
		blueprint_name: z.string().optional(),
		asset_path: z.string().optional(),
	}

	const physicsActions = {
		spawn_physics_blueprint_actor: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintTargetNoNameShape,
						name: z.string().optional(),
						actor_name: z.string().optional(),
						...vector3TransformShape,
						component_name: z.string().optional(),
						material_path: z.string().optional(),
						slot_index: z.number().optional(),
						simulate_physics: z.boolean().optional(),
						gravity_enabled: z.boolean().optional(),
						mass: z.number().optional(),
						linear_damping: z.number().optional(),
						angular_damping: z.number().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path"],
				"Provide blueprint_name or asset_path for the Blueprint.",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEMaterialTool("spawn_physics_blueprint_actor", {
						blueprint_name: requiredStringParam(params, ["blueprint_name", "asset_path"]),
						name: optionalStringParam(params, ["name", "actor_name"]),
						location: toVector3Array(params.location),
						rotation: toRotatorArray(params.rotation),
						scale: toVector3Array(params.scale),
						component_name: optionalStringParam(params, ["component_name"]),
						material_path: optionalStringParam(params, ["material_path"]),
						slot_index: params.slot_index,
						simulate_physics: params.simulate_physics,
						gravity_enabled: params.gravity_enabled,
						mass: params.mass,
						linear_damping: params.linear_damping,
						angular_damping: params.angular_damping,
					}),
				),
		},
		set_physics_properties: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintNameShape,
						component_name: z.string(),
						simulate_physics: z.boolean().optional(),
						gravity_enabled: z.boolean().optional(),
						mass: z.number().optional(),
						linear_damping: z.number().optional(),
						angular_damping: z.number().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name"],
				"Provide blueprint_name, asset_path, or name.",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEBlueprintTool("set_physics_properties", {
						blueprint_name: blueprintNameParam(params),
						component_name: requiredStringParam(params, ["component_name"]),
						simulate_physics: params.simulate_physics,
						gravity_enabled: params.gravity_enabled,
						mass: params.mass,
						linear_damping: params.linear_damping,
						angular_damping: params.angular_damping,
					}),
				),
		},
		add_force: {
			description:
				"Apply a force to a PIE actor primitive component (root or named bone). PIE only; outside play it returns requires_pie.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						target: z.string().optional(),
						actor_name: z.string().optional(),
						component_name: z.string().optional(),
						force: vector3InputSchema,
						bone_name: z.string().optional(),
						accel_change: z.boolean().optional(),
					})
					.strict(),
				["target", "actor_name"],
				"Provide target (a PIE actor name or label).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("add_force", {
						target: optionalStringParam(params, ["target", "actor_name"]),
						component_name: optionalStringParam(params, ["component_name"]),
						force: toVector3Array(params.force),
						bone_name: optionalStringParam(params, ["bone_name"]),
						accel_change: params.accel_change,
					}),
				),
		},
		add_impulse: {
			description:
				"Apply an impulse to a PIE actor primitive component (root or named bone). PIE only; outside play it returns requires_pie.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						target: z.string().optional(),
						actor_name: z.string().optional(),
						component_name: z.string().optional(),
						impulse: vector3InputSchema,
						bone_name: z.string().optional(),
						vel_change: z.boolean().optional(),
					})
					.strict(),
				["target", "actor_name"],
				"Provide target (a PIE actor name or label).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("add_impulse", {
						target: optionalStringParam(params, ["target", "actor_name"]),
						component_name: optionalStringParam(params, ["component_name"]),
						impulse: toVector3Array(params.impulse),
						bone_name: optionalStringParam(params, ["bone_name"]),
						vel_change: params.vel_change,
					}),
				),
		},
		add_torque: {
			description:
				"Apply a torque in radians to a PIE actor primitive component (root or named bone). PIE only; outside play it returns requires_pie.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						target: z.string().optional(),
						actor_name: z.string().optional(),
						component_name: z.string().optional(),
						torque: vector3InputSchema,
						bone_name: z.string().optional(),
						accel_change: z.boolean().optional(),
					})
					.strict(),
				["target", "actor_name"],
				"Provide target (a PIE actor name or label).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("add_torque", {
						target: optionalStringParam(params, ["target", "actor_name"]),
						component_name: optionalStringParam(params, ["component_name"]),
						torque: toVector3Array(params.torque),
						bone_name: optionalStringParam(params, ["bone_name"]),
						accel_change: params.accel_change,
					}),
				),
		},
		set_collision_profile: {
			description:
				"Set the collision profile on a Blueprint component template or a placed actor primitive component, verify it, then save.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintTargetNoNameShape,
						name: z.string().optional(),
						target: z.string().optional(),
						actor_name: z.string().optional(),
						component_name: z.string().optional(),
						profile_name: z.string(),
						save: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name", "target", "actor_name"],
				"Provide a Blueprint (blueprint_name/asset_path/name) or a placed actor (target/actor_name).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("set_collision_profile", {
						blueprint_name: optionalStringParam(params, ["blueprint_name", "asset_path", "name"]),
						target: optionalStringParam(params, ["target", "actor_name"]),
						component_name: optionalStringParam(params, ["component_name"]),
						profile_name: requiredStringParam(params, ["profile_name"]),
						save: params.save,
					}),
				),
		},
		set_collision_response: {
			description:
				"Set one collision channel response (ignore/overlap/block) on a Blueprint component template or a placed actor primitive component; the component is switched to the Custom profile first.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						...blueprintTargetNoNameShape,
						name: z.string().optional(),
						target: z.string().optional(),
						actor_name: z.string().optional(),
						component_name: z.string().optional(),
						channel: z.enum([
							"Visibility",
							"Camera",
							"WorldStatic",
							"WorldDynamic",
							"Pawn",
							"PhysicsBody",
							"Vehicle",
							"Destructible",
						]),
						response: z.enum(["ignore", "overlap", "block"]),
						save: z.boolean().optional(),
					})
					.strict(),
				["blueprint_name", "asset_path", "name", "target", "actor_name"],
				"Provide a Blueprint (blueprint_name/asset_path/name) or a placed actor (target/actor_name).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("set_collision_response", {
						blueprint_name: optionalStringParam(params, ["blueprint_name", "asset_path", "name"]),
						target: optionalStringParam(params, ["target", "actor_name"]),
						component_name: optionalStringParam(params, ["component_name"]),
						channel: requiredStringParam(params, ["channel"]),
						response: requiredStringParam(params, ["response"]),
						save: params.save,
					}),
				),
		},
		set_character_movement: {
			description:
				"Set CharacterMovementComponent values (walk speed, jump velocity, gravity scale, air control, braking, friction, step height, floor angle) on a Character Blueprint CDO or a placed character. Blueprint edits skip the Blueprint compile.",
			paramsSchema: requireAtLeastOneValue(
				requireAtLeastOneValue(
					z
						.object({
							...blueprintTargetNoNameShape,
							name: z.string().optional(),
							target: z.string().optional(),
							actor_name: z.string().optional(),
							component_name: z.string().optional(),
							max_walk_speed: z.number().optional(),
							jump_z_velocity: z.number().optional(),
							gravity_scale: z.number().optional(),
							air_control: z.number().optional(),
							braking_deceleration: z.number().optional(),
							ground_friction: z.number().optional(),
							max_step_height: z.number().optional(),
							walkable_floor_angle: z.number().optional(),
							save: z.boolean().optional(),
						})
						.strict(),
					[
						"max_walk_speed",
						"jump_z_velocity",
						"gravity_scale",
						"air_control",
						"braking_deceleration",
						"ground_friction",
						"max_step_height",
						"walkable_floor_angle",
					],
					"Provide at least one movement property to change.",
				),
				["blueprint_name", "asset_path", "name", "target", "actor_name"],
				"Provide a Character Blueprint (blueprint_name/asset_path/name) or a placed character (target/actor_name).",
			),
			handler: (params: Record<string, any>) =>
				pythonDispatch(
					editorTools.UEPhysicsTool("set_character_movement", {
						blueprint_name: optionalStringParam(params, ["blueprint_name", "asset_path", "name"]),
						target: optionalStringParam(params, ["target", "actor_name"]),
						max_walk_speed: params.max_walk_speed,
						jump_z_velocity: params.jump_z_velocity,
						gravity_scale: params.gravity_scale,
						air_control: params.air_control,
						braking_deceleration: params.braking_deceleration,
						ground_friction: params.ground_friction,
						max_step_height: params.max_step_height,
						walkable_floor_angle: params.walkable_floor_angle,
						save: params.save,
					}),
				),
		},
		pie_drop_test: {
			description:
				"Spawn (actor_class) or reuse (target) a PIE actor above the ground, sample the fall for a bounded number of frames and seconds, and report start/end Z, resting state, fell_through and timed_out. PIE only.",
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						actor_class: z.string().optional(),
						class_name: z.string().optional(),
						target: z.string().optional(),
						actor_name: z.string().optional(),
						location: vector3InputSchema,
						height: z.number().optional(),
						settle_seconds: z.number().optional(),
						frames: z.number().int().optional(),
						expected_ground_z: z.number().optional(),
						simulate_physics: z.boolean().optional(),
						gravity: z.boolean().optional(),
						component_name: z.string().optional(),
						label: z.string().optional(),
					})
					.strict(),
				["actor_class", "class_name", "target", "actor_name"],
				"Provide actor_class (spawn a new actor) or target (an existing PIE actor).",
			),
			handler: async (params: Record<string, any>) => {
				const setupText = await tryRunCommand(
					editorTools.UEPhysicsTool("pie_drop_test", {
						actor_class: optionalStringParam(params, ["actor_class", "class_name"]),
						target: optionalStringParam(params, ["target", "actor_name"]),
						location: toVector3Array(params.location),
						height: params.height,
						settle_seconds: params.settle_seconds,
						frames: params.frames,
						expected_ground_z: params.expected_ground_z,
						simulate_physics: params.simulate_physics,
						gravity: params.gravity,
						component_name: optionalStringParam(params, ["component_name"]),
						label: optionalStringParam(params, ["label"]),
						spawn_only: true,
					}),
				)
				const setup = parseToolJson(setupText)
				if (!setup || setup.success === false) {
					return directDispatch(setup ?? { success: false, message: setupText.slice(-800) })
				}

				const actorName =
					(setup.actor && (setup.actor.name || setup.actor.label)) ||
					(setup.spawn && setup.spawn.label) ||
					""
				if (!actorName) {
					return directDispatch({ success: false, message: "Drop setup did not report an actor name." })
				}

				const settleSeconds = Math.min(5, Math.max(0.1, Number(params.settle_seconds ?? 2)))
				const maxFrames = Math.min(240, Math.max(1, Math.round(Number(params.frames ?? 120))))
				const componentName =
					(setup.component && (setup.component.name || setup.component.class)) || ""
				const intervalMs = 150
				const zSamples: number[] = []
				const startZ = typeof setup.initial_z === "number" ? setup.initial_z : undefined
				const groundZ = typeof setup.ground_z === "number" ? setup.ground_z : undefined
				const deadline = Date.now() + Math.max(settleSeconds * 1000, 1500)
				let stableCount = 0
				let stopReason = "timeout"
				let actorLost = false

				while (Date.now() < deadline && zSamples.length < maxFrames) {
					let probe: Record<string, any> | undefined
					try {
						const probeText = await tryRunCommand(
							editorTools.UEPhysicsTool("pie_component_probe", {
								actor_name: actorName,
								component_name: componentName,
							}),
						)
						probe = parseToolJson(probeText)
					} catch {
						probe = undefined
					}
					const location =
						probe && probe.success !== false && Array.isArray(probe.location) ? probe.location : undefined
					if (!location || location.length < 3) {
						actorLost = true
						stopReason = "actor_unavailable"
						break
					}
					const z = Number(location[2])
					if (!Number.isFinite(z)) {
						actorLost = true
						stopReason = "actor_unavailable"
						break
					}
					const previous = zSamples.length > 0 ? zSamples[zSamples.length - 1] : undefined
					zSamples.push(z)
					if (previous !== undefined && Math.abs(z - previous) < 0.5) {
						stableCount += 1
					} else {
						stableCount = 0
					}
					if (stableCount >= 3) {
						stopReason = "resting"
						break
					}
					await sleep(intervalMs)
				}

				const endZ = zSamples.length > 0 ? zSamples[zSamples.length - 1] : undefined
				const effectiveStart = startZ ?? (zSamples.length > 0 ? zSamples[0] : undefined)
				const deltaZ =
					effectiveStart !== undefined && endZ !== undefined
						? Math.round((endZ - effectiveStart) * 1000) / 1000
						: undefined
				const fell = deltaZ !== undefined && deltaZ <= -1
				const resting = stopReason === "resting"
				const fellThrough =
					groundZ !== undefined && endZ !== undefined ? endZ < groundZ - 5 : undefined
				const reachedGround =
					groundZ !== undefined && endZ !== undefined
						? endZ <= groundZ + 25 && endZ >= groundZ - 5
						: undefined

				const result: Record<string, any> = {
					...setup,
					success: zSamples.length >= 3 && Boolean(fell) && (resting || Boolean(reachedGround)),
					operation: "pie_drop_test",
					sampling: {
						performed: true,
						method: "server_polled",
						interval_ms: intervalMs,
						frames_sampled: zSamples.length,
						start_z: effectiveStart,
						end_z: endZ,
						delta_z: deltaZ,
						z_samples: zSamples,
						stop_reason: stopReason,
						settle_seconds: settleSeconds,
					},
					fell_through: fellThrough,
					resting,
				}
				if (result.success) {
					result.message = "The actor fell and came to rest within the settle window."
				} else if (actorLost) {
					result.reason = "actor_unavailable"
					result.message = "The actor disappeared while sampling the drop."
				} else if (!fell) {
					result.reason = "not_fell"
					result.message =
						"The actor Z coordinate did not decrease over the sample window; physics may be disabled or the component is asleep or blocked."
				} else if (!resting) {
					result.reason = "not_settled"
					result.message = "The actor fell but had not come to rest within the settle window."
				}
				return directDispatch(result)
			},
		},
	}

	registerToolNamespace("manage_physics", toolDescription("manage_physics"), physicsActions)

	registerToolNamespace("manage_input", toolDescription("manage_input"), {
		create_input_mapping: {
			paramsSchema: requireAtLeastOneValue(
				z
					.object({
						mapping_name: z.string().optional(),
						action_name: z.string().optional(),
						name: z.string().optional(),
						key: z.string(),
						input_type: z.string().optional(),
						scale: z.number().optional(),
					})
					.strict(),
				["mapping_name", "action_name", "name"],
				"Provide mapping_name, action_name, or name.",
			),
			handler: (params) =>
				pythonDispatch(
					editorTools.UEProjectTool("create_input_mapping", {
						mapping_name: requiredStringParam(params, ["mapping_name", "action_name", "name"]),
						key: requiredStringParam(params, ["key"]),
						input_type: optionalStringParam(params, ["input_type"]) ?? "Action",
						scale: params.scale,
					}),
				),
		},
	})

	registerToolNamespace("manage_gas", toolDescription("manage_gas"), {
		search_gas_assets: {
			paramsSchema: z.object(searchAssetsShape).strict(),
			handler: (params) => pythonDispatch(searchAssetsCommand(params)),
		},
		asset_info: {
			paramsSchema: assetLookupSchema,
			handler: (params) =>
				pythonDispatch(
					editorTools.UEGetAssetInfo(requiredStringParam(params, ["asset_path", "path", "name"])),
				),
		},
	})
}
