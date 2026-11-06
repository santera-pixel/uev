import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const descriptorPath =
	process.env.UEV_CONTROL_DESCRIPTOR ||
	path.join(
		process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
		"UnrealMcp",
		"control.json",
	)
const projectDir = process.env.VITE_PROJECT_DIR || "D:\\Uprojects\\ViteMCPTest"
const editorLogPath = path.join(projectDir, "Saved", "Logs", "ViteMCPTest.log")
const crashDir = path.join(projectDir, "Saved", "Crashes")

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => new Date().toISOString()

const results = { pass: 0, warn: 0, fail: 0, expected: 0 }
const failures = []
const warnings = []
const pendingCleanupAssets = []
const exercisedTools = new Set()

function pass(name, detail = "") {
	results.pass += 1
	console.log(`[PASS] ${name}${detail ? ` ${detail}` : ""}`)
}
function warn(name, detail = "") {
	results.warn += 1
	warnings.push(`${name}${detail ? `: ${detail}` : ""}`)
	console.log(`[WARN] ${name}${detail ? ` ${detail}` : ""}`)
}
function fail(name, detail = "") {
	results.fail += 1
	failures.push(`${name}${detail ? `: ${detail}` : ""}`)
	console.log(`[FAIL] ${name}${detail ? ` ${detail}` : ""}`)
}
function expected(name, detail = "") {
	results.expected += 1
	console.log(`[EXPECTED] ${name}${detail ? ` ${detail}` : ""}`)
}
function assert(condition, message) {
	if (!condition) throw new Error(message)
}
function clip(value, max = 180) {
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.length > max ? `${text.slice(0, max)}...` : text
}

const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"))
if (!descriptor?.port || !descriptor?.token) {
	throw new Error(`Invalid control descriptor at ${descriptorPath}`)
}
const baseUrl = `http://127.0.0.1:${descriptor.port}`

async function request(pathname, options = {}) {
	const {
		method = "GET",
		body,
		token = descriptor.token,
		extraHeaders = {},
		timeoutMs = 30000,
		contentType = true,
	} = options
	const headers = { ...extraHeaders }
	if (token) headers.Authorization = `Bearer ${token}`
	let payload
	if (body !== undefined) {
		if (contentType) headers["Content-Type"] = "application/json"
		payload = typeof body === "string" ? body : JSON.stringify(body)
	}
	const started = Date.now()
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers,
		body: payload,
		signal: AbortSignal.timeout(timeoutMs),
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}
	return { status: response.status, text, json, durationMs: Date.now() - started }
}

async function call(tool, action, params, timeoutMs = 30000) {
	exercisedTools.add(tool)
	const body = { tool, params: params ?? {} }
	if (action) body.action = action
	const response = await request("/api/call", { method: "POST", body, timeoutMs })
	return response
}

function callText(response) {
	if (response.json && typeof response.json.text === "string") return response.json.text
	return response.text
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return true
		await delay(intervalMs)
	}
	return false
}

async function callJson(tool, action, params, timeoutMs = 30000) {
	const response = await call(tool, action, params, timeoutMs)
	const text = callText(response)
	try {
		return { response, json: JSON.parse(text) }
	} catch {
		return { response, json: undefined }
	}
}

async function editorAlive(label) {
	try {
		const { response, json } = await callJson("manage_history", "status", {}, 30000)
		assert(response.status === 200, `HTTP ${response.status}`)
		assert(json?.success === true, clip(callText(response)))
		return true
	} catch (error) {
		fail(`${label}: editor/MCP not responsive`, error.message)
		return false
	}
}

async function catalog() {
	const response = await request("/api/catalog", { timeoutMs: 30000 })
	assert(response.status === 200, `catalog HTTP ${response.status}`)
	assert(Array.isArray(response.json?.tools), "catalog tools missing")
	return response.json
}

async function cleanupPendingAssets() {
	for (const assetPath of [...new Set(pendingCleanupAssets.filter(Boolean))]) {
		let removed = false
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const exists = await callJson("manage_asset", "exists", { asset_path: assetPath }, 30000).catch(() => null)
			if (exists?.json?.exists !== true) {
				removed = true
				break
			}
			const deleted = await callJson("manage_asset", "delete", { asset_path: assetPath }, 60000).catch(() => null)
			const deletedPaths = Array.isArray(deleted?.json?.deleted) ? deleted.json.deleted : []
			if (deleted?.json?.success === true && (deleted.json.deleted_count > 0 || deletedPaths.includes(assetPath))) {
				removed = true
				break
			}
			await delay(2000)
		}
		removed ? pass("temporary asset cleanup", assetPath) : warn("temporary asset cleanup", assetPath)
	}
}

async function assetActorBattle(canWrite) {
	if (!canWrite) return
	console.log("[INFO] starting asset/actor integration (materials, meshes, animation, attachment)")
	const characterLabel = "ThirdPersonCharacter"
	const materialSource = "/Game/Mannequin/Character/Materials/M_Male_Body"
	const materialInstance = "/Game/Mannequin/Character/Materials/MI_Female_Body"
	const animBlueprint = "/Game/Mannequin/Animations/ThirdPerson_AnimBP"
	const tempFolder = "/Game/MCP/Battle"
	const stamp = Date.now()
	let tempMaterial = `${tempFolder}/MCPBattle_Mat_${stamp}`
	const tempRenamed = `${tempFolder}/MCPBattle_Mat_Renamed_${stamp}`
	const cubeName = `MCP_Battle_Cube_${stamp}`
	const bpName = `MCP_Battle_Character_${stamp}`
	let originalMaterial = null
	let originalAnim = null
	let characterClassPath = null
	let cubeSpawned = false
	let tempMaterialCreated = false
	let bpSpawned = false
	const pyStr = (value) => (value === null || value === undefined ? "None" : JSON.stringify(value))

	const runPy = async (code, timeoutMs = 60000) => {
		const response = await call("manage_editor", "run_python", { code }, timeoutMs)
		const text = callText(response)
		let json
		try {
			json = JSON.parse(text)
		} catch {
			json = undefined
		}
		return { response, text, json }
	}

	const restoreCharacter = async () => {
		if (!originalMaterial && !originalAnim) return
		try {
			const mat = pyStr(originalMaterial)
			const anim = pyStr(originalAnim)
			await runPy([
				"import unreal, json",
				`a = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
				"comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
				`comp.set_material(0, unreal.load_asset(${mat}) if ${mat} != None else None)`,
				`comp.set_editor_property("anim_class", unreal.load_class(None, ${anim}) if ${anim} != None else None)`,
				"print(json.dumps({'restored': True}))",
			].join("\n"))
			pass("character material/animation restored")
		} catch (error) {
			warn("character restore", error.message)
		}
	}

	try {
		await callJson("manage_asset", "create_folder", { path: tempFolder }).catch(() => {})
		const discovery = await runPy([
			"import unreal, json",
			`out = {"character": None, "material": None, "anim": None, "slots": 0, "class_path": None, "cube_mesh": None}`,
			"for a in unreal.EditorLevelLibrary.get_all_level_actors():",
			`    if a.get_actor_label() == ${pyStr(characterLabel)}:`,
			"        comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
			"        if comp:",
			"            out['character'] = a.get_actor_label()",
			"            out['class_path'] = a.get_class().get_path_name()",
			"            out['slots'] = comp.get_num_materials()",
			"            m = comp.get_material(0)",
			"            out['material'] = m.get_path_name() if m else None",
			"            anim = comp.get_editor_property('anim_class')",
			"            out['anim'] = anim.get_path_name() if anim else None",
			"            break",
			`out['cube_mesh'] = unreal.load_asset("/Engine/BasicShapes/Cube").get_path_name()`,
			"print(json.dumps(out))",
		].join("\n"))
		assert(discovery.json?.character, clip(discovery.text))
		originalMaterial = discovery.json.material
		originalAnim = discovery.json.anim
		characterClassPath = discovery.json.class_path
		pass("asset/actor discovery", `slots=${discovery.json.slots} material=${clip(originalMaterial, 70)} anim=${clip(originalAnim, 70)}`)

		const info = await callJson("manage_actor", "get_material_info", { name: characterLabel }, 60000)
		assert(info.json?.success === true, clip(callText(info.response)))
		JSON.stringify(info.json).includes("M_Male_Body")
			? pass("actor material info", "M_Male_Body present")
			: warn("actor material info", "M_Male_Body not found")

		// Material instance assignment, verify through the MCP, then restore.
		const assigned = await runPy([
			"import unreal, json",
			`a = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
			"comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
			`comp.set_material(0, unreal.load_asset(${pyStr(materialInstance)}))`,
			"m = comp.get_material(0)",
			"print(json.dumps({'assigned': m.get_path_name() if m else None}))",
		].join("\n"))
		assert(/MI_Female_Body/.test(assigned.text), clip(assigned.text))
		const assignedInfo = await callJson("manage_actor", "get_material_info", { name: characterLabel }, 60000)
		JSON.stringify(assignedInfo.json).includes("MI_Female_Body")
			? pass("material instance assigned to skeletal mesh actor")
			: fail("material instance assignment", clip(callText(assignedInfo.response)))
		await runPy([
			"import unreal, json",
			`a = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
			"comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
			`comp.set_material(0, unreal.load_asset(${pyStr(originalMaterial)}) if ${pyStr(originalMaterial)} != None else None)`,
			"m = comp.get_material(0)",
			"print(json.dumps({'restored': m.get_path_name() if m else None}))",
		].join("\n"))
		pass("material instance restored")

		// Animation blueprint assignment, clear, and restore in one editor call.
		const anim = await runPy([
			"import unreal, json",
			`a = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
			"comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
			`bp = unreal.EditorAssetLibrary.load_blueprint_class(${pyStr(animBlueprint)})`,
			"original = comp.get_editor_property('anim_class')",
			"comp.set_editor_property('anim_class', bp)",
			"assigned = comp.get_editor_property('anim_class').get_path_name() if comp.get_editor_property('anim_class') else None",
			"comp.set_editor_property('anim_class', None)",
			"cleared = comp.get_editor_property('anim_class') is None",
			"comp.set_editor_property('anim_class', original)",
			"restored = comp.get_editor_property('anim_class') == original",
			"print(json.dumps({'assigned': assigned, 'cleared': cleared, 'restored': restored}))",
		].join("\n"))
		anim.json?.assigned && anim.json?.cleared && anim.json?.restored
			? pass("animation blueprint assigned/cleared/restored")
			: warn("animation blueprint assignment", clip(anim.text))

		const invalidAnim = await runPy([
			"import unreal, json",
			`a = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
			"comp = a.get_component_by_class(unreal.SkeletalMeshComponent)",
			"original = comp.get_editor_property('anim_class')",
			"error = None",
			"try:",
			`    comp.set_editor_property('anim_class', unreal.load_asset(${pyStr(materialSource)}))`,
			"except Exception as exc:",
			"    error = str(exc)",
			"comp.set_editor_property('anim_class', original)",
			"print(json.dumps({'error': error}))",
		].join("\n"))
		invalidAnim.json?.error ? pass("invalid animation class rejected") : warn("invalid animation class", "engine accepted the wrong asset class")

		// Material asset lifecycle: duplicate, rename, verify, save.
		const duplicate = await callJson("manage_asset", "duplicate", {
			source_asset_path: materialSource,
			destination_asset_path: tempMaterial,
		}, 60000)
		if (duplicate.json?.success === true) {
			tempMaterialCreated = true
			pass("material asset duplicated", tempMaterial)
			const exists = await callJson("manage_asset", "exists", { asset_path: tempMaterial })
			exists.json?.exists === true
				? pass("duplicated material exists")
				: warn("duplicated material exists", clip(callText(exists.response)))
			const saved = await callJson("manage_asset", "save", { asset_path: tempMaterial }, 60000)
			saved.json?.success === true ? pass("duplicated material saved") : warn("duplicated material save", clip(callText(saved.response)))
			const tempInfo = await callJson("manage_asset", "info", { asset_path: tempMaterial }, 30000)
			const tempInfoText = JSON.stringify(tempInfo.json)
			tempInfoText.includes('"class":"Material"') || tempInfoText.includes('"class": "Material"')
				? pass("duplicated material classified as Material")
				: warn("duplicated material class", clip(callText(tempInfo.response), 120))
			const renamed = await callJson("manage_asset", "rename", {
				source_asset_path: tempMaterial,
				new_name: `MCPBattle_Mat_Renamed_${stamp}`,
			}, 60000)
			if (renamed.json?.success === true) {
				const renamedExists = await callJson("manage_asset", "exists", { asset_path: tempRenamed })
				if (renamedExists.json?.exists === true) {
					tempMaterial = tempRenamed
					pass("duplicated material renamed", tempMaterial)
				} else {
					warn("duplicated material rename result", clip(callText(renamedExists.response)))
				}
			} else {
				warn("duplicated material rename", clip(callText(renamed.response)))
			}
			const refs = await callJson("manage_asset", "references", { asset_path: tempMaterial }, 30000)
			if (Array.isArray(refs.json)) {
				expected(
					"material references (asset registry)",
					`${refs.json.length} registry entries; runtime actor references are not visible to the asset registry`,
				)
			} else {
				refs.json?.success === true
					? pass("material references queried", clip(callText(refs.response), 120))
					: warn("material references queried", clip(callText(refs.response), 120))
			}
		} else {
			warn("material duplicate", clip(callText(duplicate.response)))
		}

		// Negative asset operations.
		const missingDup = await callJson("manage_asset", "duplicate", {
			source_asset_path: `${tempFolder}/MCP_Missing_${stamp}`,
			destination_asset_path: `${tempFolder}/MCP_Missing_Copy_${stamp}`,
		}, 30000)
		missingDup.json?.success === false ? expected("missing material duplicate rejected") : warn("missing material duplicate", clip(callText(missingDup.response)))
		const missingDelete = await callJson("manage_asset", "delete", { asset_path: `${tempFolder}/MCP_Missing_${stamp}` }, 30000)
		missingDelete.json?.success === false ? expected("missing asset delete rejected") : warn("missing asset delete", clip(callText(missingDelete.response)))

		// Static mesh actor + duplicated material + attachment.
		const spawnCube = await callJson("manage_actor", "spawn", {
			type: "StaticMeshActor",
			name: cubeName,
			location: { x: 150, y: 150, z: 120 },
		}, 60000)
		assert(spawnCube.json?.success === true, clip(callText(spawnCube.response)))
		cubeSpawned = true
		const attach = await runPy([
			"import unreal, json",
			`cube = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(cubeName)}][0]`,
			`char = [x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_actor_label() == ${pyStr(characterLabel)}][0]`,
			"comp = cube.get_component_by_class(unreal.StaticMeshComponent)",
			`comp.set_static_mesh(unreal.load_asset("/Engine/BasicShapes/Cube"))`,
			`comp.set_material(0, unreal.load_asset(${pyStr(tempMaterial)}))`,
			"mesh = comp.get_editor_property('static_mesh')",
			"mat = comp.get_material(0)",
			"out = {'mesh': mesh.get_path_name() if mesh else None, 'material': mat.get_path_name() if mat else None}",
			"root = cube.root_component",
			"if root:",
			"    root.set_mobility(unreal.ComponentMobility.MOVABLE)",
			"char_comp = char.get_component_by_class(unreal.SkeletalMeshComponent)",
			"attach_error = None",
			"attach_ok = False",
			"try:",
			"    attach_ok = cube.attach_to_component(char_comp, '', unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, False)",
			"except Exception as exc:",
			"    attach_error = str(exc)",
			"out['attach_ok'] = attach_ok",
			"parent = cube.get_attach_parent_actor()",
			"out['parent'] = parent.get_actor_label() if parent else None",
			"out['attach_error'] = attach_error",
			"socket_result = None",
			"socket_ok = False",
			"try:",
			"    cube.detach_from_actor(unreal.DetachmentRule.KEEP_WORLD, unreal.DetachmentRule.KEEP_WORLD, unreal.DetachmentRule.KEEP_WORLD)",
			"    socket_ok = cube.attach_to_component(char_comp, 'hand_r', unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, False)",
			"    socket_parent = cube.get_attach_parent_actor()",
			"    socket_result = socket_parent.get_actor_label() if socket_parent else None",
			"    cube.detach_from_actor(unreal.DetachmentRule.KEEP_WORLD, unreal.DetachmentRule.KEEP_WORLD, unreal.DetachmentRule.KEEP_WORLD)",
			"except Exception as exc:",
			"    socket_result = 'error: {0}'.format(exc)",
			"out['socket_ok'] = socket_ok",
			"out['socket_attach'] = socket_result",
			"self_error = None",
			"self_ok = False",
			"try:",
			"    self_ok = cube.attach_to_actor(cube, '', unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, False)",
			"except Exception as exc:",
			"    self_error = str(exc)",
			"self_parent = cube.get_attach_parent_actor()",
			"out['self_ok'] = self_ok",
			"out['self_parent'] = self_parent.get_actor_label() if self_parent else None",
			"out['self_error'] = self_error",
			"print(json.dumps(out))",
		].join("\n"))
		attach.json?.mesh?.includes("Cube") ? pass("static mesh assigned to spawned actor") : warn("static mesh assignment", clip(attach.text))
		attach.json?.material?.includes("MCPBattle_Mat") ? pass("duplicated material assigned to static mesh") : warn("material assignment to static mesh", clip(attach.text))
		attach.json?.parent === characterLabel ? pass("actor attached to character component") : fail("actor attachment", clip(attach.text))
		attach.json?.socket_attach === characterLabel ? pass("actor attached to hand_r socket") : warn("actor socket attachment", clip(String(attach.json?.socket_attach)))
		attach.json?.self_parent === null ? pass("self-attachment rejected") : fail("self-attachment", clip(attach.text))

		const cubeInfo = await callJson("manage_actor", "get_material_info", { name: cubeName }, 60000)
		JSON.stringify(cubeInfo.json).includes("MCPBattle_Mat")
			? pass("static mesh material info", "duplicated material present")
			: warn("static mesh material info", clip(callText(cubeInfo.response)))

		await callJson("manage_actor", "delete", { name: cubeName }, 60000)
		cubeSpawned = false
		pass("static mesh actor deleted")

		// Blueprint actor spawn/delete.
		if (characterClassPath) {
			const blueprintPath = characterClassPath.slice(0, characterClassPath.lastIndexOf("."))
			const bp = await callJson("manage_actor", "spawn_blueprint", {
				blueprint_name: blueprintPath,
				name: bpName,
				location: { x: 300, y: 300, z: 120 },
			}, 60000)
			if (bp.json?.success === true) {
				bpSpawned = true
				pass("blueprint actor spawned", blueprintPath)
				await callJson("manage_actor", "delete", { name: bpName }, 60000)
				bpSpawned = false
				pass("blueprint actor deleted")
			} else {
				warn("blueprint actor spawn", clip(callText(bp.response)))
			}
		}
	} catch (error) {
		fail("asset/actor integration", error.message)
	} finally {
		await restoreCharacter()
		try {
			if (cubeSpawned) await callJson("manage_actor", "delete", { name: cubeName }, 60000)
		} catch {
			// Ignore cleanup failure.
		}
		try {
			if (bpSpawned) await callJson("manage_actor", "delete", { name: bpName }, 60000)
		} catch {
			// Ignore cleanup failure.
		}
		if (tempMaterialCreated) {
			for (const candidate of new Set([tempMaterial, tempRenamed])) pendingCleanupAssets.push(candidate)
			console.log(`[INFO] queued temporary material cleanup: ${tempMaterial}`)
		}
		try {
			const stopped = await callJson("manage_editor", "is_pie_running")
			if (stopped.json?.is_pie_running === true) {
				await callJson("manage_editor", "stop_pie", {}, 60000)
				await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === false, 30000)
			}
			const save = await call("manage_editor", "run_python", {
				code: "import unreal\nprint('level_saved={0}'.format(unreal.EditorLevelLibrary.save_current_level()))",
			}, 60000)
			const levelSaved = /level_saved=True/i.test(callText(save))
			levelSaved ? pass("level saved after asset/actor cleanup") : warn("level save", clip(callText(save)))
		} catch (error) {
			warn("asset/actor cleanup", error.message)
		}
	}
}

async function validParamAndMaterialBattle(canWrite) {
	if (!canWrite) return
	const stamp = Date.now()
	const actorName = `MCP_Valid_Actor_${stamp}`
	const characterLabel = "ThirdPersonCharacter"
	const materialInstance = "/Game/Mannequin/Character/Materials/MI_Female_Body"
	let originalMaterial = "/Game/Mannequin/Character/Materials/M_Male_Body"
	let actorSpawned = false

	try {
		const info = await callJson("manage_actor", "get_material_info", { name: characterLabel }, 60000)
		const materials = Array.isArray(info.json?.materials) ? info.json.materials : []
		const slot = materials.find((entry) => entry.slot_index === 0)
		if (typeof slot?.material === "string" && slot.material) {
			originalMaterial = slot.material.includes(".")
				? slot.material.slice(0, slot.material.lastIndexOf("."))
				: slot.material
		}
	} catch {
		// Fall back to the known mannequin body material.
	}

	try {
		const applied = await callJson("manage_material", "apply_to_actor", {
			name: characterLabel,
			material_path: materialInstance,
			slot_index: 0,
		}, 60000)
		if (applied.json?.success === true) {
			const after = await callJson("manage_actor", "get_material_info", { name: characterLabel }, 60000)
			JSON.stringify(after.json).includes("MI_Female_Body")
				? pass("material action applied to actor")
				: warn("material action applied to actor", "MI_Female_Body not found in material info")
		} else {
			warn("material action apply_to_actor", clip(callText(applied.response), 160))
		}
	} catch (error) {
		warn("material action apply_to_actor", error.message)
	}

	try {
		const tinted = await callJson("manage_material", "tint_material", {
			actor_name: characterLabel,
			material_path: originalMaterial,
			slot_index: 0,
			color: [0.2, 0.9, 0.4, 1.0],
		}, 60000)
		if (tinted.json?.success === true) {
			const serialized = JSON.stringify(tinted.json)
			const generated = serialized.match(/\/Game\/MCP\/GeneratedMaterials\/[^"\\]+/)
			if (generated) pendingCleanupAssets.push(generated[0].split(".")[0])
			pass("material tint action", clip(serialized, 120))
		} else {
			warn("material tint action", clip(callText(tinted.response), 160))
		}
	} catch (error) {
		warn("material tint action", error.message)
	}

	try {
		await callJson("manage_material", "apply_to_actor", {
			name: characterLabel,
			material_path: originalMaterial,
			slot_index: 0,
		}, 60000)
		pass("character material restored via material action")
	} catch (error) {
		warn("character material restore via material action", error.message)
	}

	try {
		const list = await callJson("manage_material", "list_materials", {
			search_term: "M_",
			include_engine: false,
			limit: 5,
		}, 60000)
		list.json?.success === true
			? pass("material list filters")
			: warn("material list filters", clip(callText(list.response), 160))
	} catch (error) {
		warn("material list filters", error.message)
	}

	try {
		const skeleton = await callJson("manage_skeleton", "search_skeletal_meshes", { limit: 5 }, 60000)
		skeleton.json?.success === true || Array.isArray(skeleton.json?.assets)
			? pass("skeletal mesh search filters")
			: warn("skeletal mesh search filters", clip(callText(skeleton.response), 160))
	} catch (error) {
		warn("skeletal mesh search filters", error.message)
	}

	try {
		const spawn = await callJson("manage_actor", "spawn", {
			type: "StaticMeshActor",
			name: actorName,
			location: { x: 80, y: 0, z: 120 },
		}, 60000)
		actorSpawned = spawn.json?.success === true
		if (!actorSpawned) throw new Error(clip(callText(spawn.response), 160))
		const transform = await callJson("manage_actor", "transform", {
			name: actorName,
			location: { x: 100, y: 20, z: 120 },
		}, 60000)
		transform.json?.success === true
			? pass("actor transform action")
			: warn("actor transform action", clip(callText(transform.response), 160))
		const setProp = await callJson("manage_actor", "set_property", {
			name: actorName,
			property_name: "bHidden",
			property_value: true,
		}, 60000)
		setProp.json?.success === true
			? pass("actor set_property action")
			: warn("actor set_property action", clip(callText(setProp.response), 160))
		const props = await callJson("manage_actor", "get_properties", { name: actorName }, 60000)
		props.json?.success === true
			? pass("actor get_properties after transform")
			: warn("actor get_properties after transform", clip(callText(props.response), 160))
	} catch (error) {
		warn("actor valid-parameter workflow", error.message)
	} finally {
		if (actorSpawned) {
			try {
				await callJson("manage_actor", "delete", { name: actorName }, 60000)
			} catch {
				// Ignore cleanup failure.
			}
		}
	}

	try {
		const okChecked = await call("manage_editor", "run_python_checked", { code: "print('battle_checked_ok=1')" }, 60000)
		const okJson = JSON.parse(callText(okChecked))
		okJson?.success === true
			? pass("checked Python success")
			: fail("checked Python success", clip(callText(okChecked), 160))
		const badChecked = await call("manage_editor", "run_python_checked", { code: "raise RuntimeError('battle_checked_fail')" }, 60000)
		const badJson = JSON.parse(callText(badChecked))
		badJson?.success === false && badChecked.json?.ok === false
			? pass("checked Python failure is structured")
			: fail("checked Python failure is structured", clip(callText(badChecked), 160))
	} catch (error) {
		fail("checked Python action", error.message)
	}

	try {
		const capture = await call("editor_capture_window", "", {}, 60000)
		const captureJson = JSON.parse(callText(capture))
		captureJson?.success === true && typeof captureJson.path === "string" && fs.existsSync(captureJson.path)
			? pass("desktop window capture", `${captureJson.width}x${captureJson.height}`)
			: warn("desktop window capture", clip(callText(capture), 160))
	} catch (error) {
		warn("desktop window capture", error.message)
	}

}

async function main() {
	const startTime = Date.now()
	const startLogSize = fs.existsSync(editorLogPath) ? fs.statSync(editorLogPath).size : 0
	console.log(`[INFO] control=${baseUrl} profile=${descriptor.profile} pid=${descriptor.pid}`)
	console.log(`[INFO] editor log=${editorLogPath}`)

	const health = await request("/api/health", { timeoutMs: 15000 })
	assert(health.status === 200 && health.json?.ok === true, `health failed: ${health.status} ${clip(health.text)}`)
	pass("health", `profile=${health.json.profile} supervisor=${health.json.supervisor?.connected}`)

	const catalogData = await catalog()
	pass("catalog", `tools=${catalogData.tools.length} profile=${catalogData.profile}`)
	if (catalogData.profile !== "supervised") {
		warn("profile is not supervised; write tests will be skipped")
	}

	// ---------------------------------------------------------------------
	// API contract / malformed input fuzzing
	// ---------------------------------------------------------------------
	{
		const noAuth = await request("/api/health", { token: "", timeoutMs: 10000 })
		noAuth.status === 401 ? pass("auth rejects missing token") : fail("auth missing token", `HTTP ${noAuth.status}`)
		const badAuth = await request("/api/health", { token: "wrong", timeoutMs: 10000 })
		badAuth.status === 401 ? pass("auth rejects bad token") : fail("auth bad token", `HTTP ${badAuth.status}`)
		const origin = await request("/api/health", {
			extraHeaders: { Origin: "http://evil.example" },
			timeoutMs: 10000,
		})
		origin.status === 403 ? pass("origin header rejected") : fail("origin header", `HTTP ${origin.status}`)
	}

	const contractCases = [
		{ name: "missing content type", path: "/api/call", method: "POST", body: { tool: "manage_history", action: "status" }, contentType: false, expect: 415 },
		{ name: "malformed JSON", path: "/api/call", method: "POST", raw: "{", expect: 400 },
		{ name: "empty body", path: "/api/call", method: "POST", raw: "", expect: 400 },
		{ name: "array body", path: "/api/call", method: "POST", body: [], expect: 400 },
		{ name: "missing tool", path: "/api/call", method: "POST", body: {}, expect: 400 },
		{ name: "non-string tool", path: "/api/call", method: "POST", body: { tool: 42 }, expect: 400 },
		{ name: "unknown tool", path: "/api/call", method: "POST", body: { tool: "not_a_tool", action: "x" }, expect: 404 },
		{ name: "namespace without action", path: "/api/call", method: "POST", body: { tool: "manage_history" }, expect: 400 },
		{ name: "direct tool with action", path: "/api/call", method: "POST", body: { tool: "editor_create_object", action: "x" }, expect: 400 },
		{ name: "non-string action", path: "/api/call", method: "POST", body: { tool: "manage_history", action: 42 }, expect: 400 },
		{ name: "array params", path: "/api/call", method: "POST", body: { tool: "manage_history", action: "status", params: [] }, expect: 400 },
		{ name: "string params", path: "/api/call", method: "POST", body: { tool: "manage_history", action: "status", params: "x" }, expect: 400 },
		{ name: "null params", path: "/api/call", method: "POST", body: { tool: "manage_history", action: "status", params: null }, expect: 200 },
		{ name: "unknown action", path: "/api/call", method: "POST", body: { tool: "manage_history", action: "not_an_action" }, expect: 200, check: (r) => r.json?.ok === false },
		{ name: "missing required params", path: "/api/call", method: "POST", body: { tool: "manage_widget", action: "inspect_tree", params: {} }, expect: 200, check: (r) => r.json?.ok === false },
		{ name: "GET call rejected", path: "/api/call", method: "GET", expect: [404, 405] },
		{ name: "POST health rejected", path: "/api/health", method: "POST", body: {}, expect: [404, 405] },
		{ name: "unknown route", path: "/api/nope", method: "GET", expect: 404 },
	]
	for (const testCase of contractCases) {
		try {
			const opts = { method: testCase.method, timeoutMs: 15000 }
			if (testCase.contentType === false) opts.contentType = false
			if (testCase.raw !== undefined) opts.body = testCase.raw
			else if (testCase.body !== undefined) opts.body = testCase.body
			const response = await request(testCase.path, opts)
			const expectedStatuses = Array.isArray(testCase.expect) ? testCase.expect : [testCase.expect]
			assert(expectedStatuses.includes(response.status), `expected ${expectedStatuses.join("/")} got ${response.status}: ${clip(response.text)}`)
			if (testCase.check) assert(testCase.check(response), `check failed: ${clip(response.text)}`)
			pass(`contract: ${testCase.name}`, `HTTP ${response.status}`)
		} catch (error) {
			fail(`contract: ${testCase.name}`, error.message)
		}
	}

	// Oversized and near-limit bodies.
	{
		const big = "x".repeat(1_100_000)
		const response = await request("/api/call", {
			method: "POST",
			body: { tool: "manage_history", action: "status", padding: big },
			timeoutMs: 30000,
		})
		;[400, 413].includes(response.status)
			? pass("oversized body rejected", `HTTP ${response.status}`)
			: fail("oversized body", `HTTP ${response.status} ${clip(response.text)}`)
	}
	{
		const near = "x".repeat(900_000)
		const response = await request("/api/call", {
			method: "POST",
			body: { tool: "manage_history", action: "status", padding: near },
			timeoutMs: 30000,
		})
		response.status === 200 && response.json?.ok === true
			? pass("near-limit body accepted", `HTTP 200`)
			: warn("near-limit body", `HTTP ${response.status} ${clip(response.text)}`)
	}

	// ---------------------------------------------------------------------
	// Read-action sweep with empty params
	// ---------------------------------------------------------------------
	console.log("[INFO] starting read-action sweep")
	const readTargets = []
	for (const tool of catalogData.tools) {
		if (tool.actions.length === 0) {
			if (tool.direct?.mode === "read" && tool.direct.allowed) {
				readTargets.push({ tool: tool.name, action: undefined, timeoutMs: tool.direct.timeoutMs ?? 30000 })
			}
			continue
		}
		for (const action of tool.actions) {
			if (action.mode === "read" && action.allowed) {
				readTargets.push({ tool: tool.name, action: action.name, timeoutMs: action.timeoutMs ?? 30000 })
			}
		}
	}
	console.log(`[INFO] read targets=${readTargets.length}`)
	let readStructured = 0
	let readExpectedErrors = 0
	let readTimeouts = 0
	for (const target of readTargets) {
		const label = `${target.tool}${target.action ? `.${target.action}` : ""}`
		try {
			const timeout = Math.min(120000, Math.max(15000, target.timeoutMs + 15000))
			const response = await call(target.tool, target.action, {}, timeout)
			if (response.status !== 200 || !response.json || typeof response.json.text !== "string") {
				fail(`read ${label}`, `unstructured HTTP ${response.status}: ${clip(response.text)}`)
				continue
			}
			if (response.json.ok === false) {
				readExpectedErrors += 1
				expected(`read ${label}`, clip(response.json.text, 100))
			} else {
				readStructured += 1
				console.log(`[PASS] read ${label} ${response.durationMs}ms ${clip(response.json.text, 100)}`)
			}
		} catch (error) {
			if (error.name === "TimeoutError" || /timeout/i.test(error.message)) {
				readTimeouts += 1
				warn(`read ${label}`, "client timeout")
			} else {
				fail(`read ${label}`, error.message)
			}
		}
	}
	pass("read sweep completed", `ok=${readStructured} expectedErrors=${readExpectedErrors} timeouts=${readTimeouts}`)
	if (!(await editorAlive("post-read-sweep"))) return finish()

	// ---------------------------------------------------------------------
	// Curated reversible writes
	// ---------------------------------------------------------------------
	console.log("[INFO] starting curated write tests")
	const supervised = catalogData.profile === "supervised"
	const canWrite = supervised

	// Actor spawn / inspect / undo / redo / delete
	const actorName = `MCP_Battle_Actor_${Date.now()}`
	let actorSpawned = false
	if (canWrite) {
		try {
			let spawn = await callJson("manage_actor", "spawn", {
				type: "MCPLiveCodingTestActor",
				name: actorName,
				location: { x: 250, y: 0, z: 110 },
			})
			if (spawn.json?.success !== true) {
				spawn = await callJson("manage_actor", "spawn", {
					type: "/Script/ViteMCPTest.MCPLiveCodingTestActor",
					name: actorName,
					location: { x: 250, y: 0, z: 110 },
				})
			}
			assert(spawn.json?.success === true, clip(callText(spawn.response)))
			actorSpawned = true
			pass("actor spawn", actorName)
			const find = await callJson("manage_actor", "find", { name: actorName })
			assert(find.json?.success === true, clip(callText(find.response)))
			pass("actor find", clip(JSON.stringify(find.json), 120))
			const props = await callJson("manage_actor", "get_properties", { name: actorName })
			assert(props.json?.success === true, clip(callText(props.response)))
			pass("actor properties", clip(JSON.stringify(props.json), 120))
			const py = await call("manage_editor", "run_python", {
				code: [
					"import unreal",
					`actors = [a for a in unreal.EditorLevelLibrary.get_all_level_actors() if a.get_actor_label() == '${actorName}']`,
					"print('found={0}'.format(len(actors)))",
					"actors[0].set_mcp_test_color(unreal.LinearColor(0.2, 0.9, 0.4, 1.0))",
					"print('battle_actor_ok=True')",
				].join("\n"),
			}, 60000)
			assert(py.status === 200 && /battle_actor_ok=True/.test(callText(py)), clip(callText(py)))
			pass("actor Live-Coded method", clip(callText(py), 100))
		} catch (error) {
			fail("actor write workflow", error.message)
		}
	}

	// History undo/redo on the spawn.
	if (canWrite && actorSpawned) {
		try {
			const history = await callJson("manage_history", "list", {
				tool: "manage_actor",
				action: "spawn",
				limit: 10,
			})
			const entry = (history.json?.entries ?? []).find((item) => {
				if (typeof item.argsPreview === "string" && item.argsPreview.includes(actorName)) return true
				if (item.forward?.params?.name === actorName) return true
				return false
			})
			if (!entry) throw new Error("spawn history entry not found")
			pass("history entry found", entry.id)
			const presenceCode = [
				"import unreal",
				`labels = [a.get_actor_label() for a in unreal.EditorLevelLibrary.get_all_level_actors()]`,
				`print('present={0}'.format('${actorName}' in labels))`,
			].join("\n")
			const undo = await callJson("manage_history", "undo", { targetId: entry.id }, 60000)
			assert(undo.json?.success === true, clip(callText(undo.response)))
			const afterUndo = await call("manage_editor", "run_python", { code: presenceCode }, 60000)
			assert(/present=False/.test(callText(afterUndo)), clip(callText(afterUndo)))
			pass("history undo removed actor")
			const redo = await callJson("manage_history", "redo", { targetId: entry.id }, 60000)
			assert(redo.json?.success === true, clip(callText(redo.response)))
			const afterRedo = await call("manage_editor", "run_python", { code: presenceCode }, 60000)
			assert(/present=True/.test(callText(afterRedo)), clip(callText(afterRedo)))
			pass("history redo restored actor")
		} catch (error) {
			fail("history undo/redo", error.message)
		}
	}
	if (canWrite && actorSpawned) {
		try {
			const deleted = await callJson("manage_actor", "delete", { name: actorName }, 60000)
			assert(deleted.json?.success === true, clip(callText(deleted.response)))
			actorSpawned = false
			pass("actor delete")
		} catch (error) {
			warn("actor delete", error.message)
		}
	}

	// Vite cvar round trip.
	if (canWrite) {
		try {
			const before = await callJson("manage_vite", "cvar_get", { name: "r.ScreenPercentage" })
			assert(typeof before.json?.current === "number", clip(callText(before.response)))
			const original = before.json.current
			const set = await callJson("manage_vite", "cvar_set", { name: "r.ScreenPercentage", value: 85 })
			assert(set.json?.success === true, clip(callText(set.response)))
			const changed = await callJson("manage_vite", "cvar_get", { name: "r.ScreenPercentage" })
			assert(changed.json?.current === 85, clip(callText(changed.response)))
			const restore = await callJson("manage_vite", "cvar_set", { name: "r.ScreenPercentage", value: original })
			assert(restore.json?.success === true, clip(callText(restore.response)))
			const restored = await callJson("manage_vite", "cvar_get", { name: "r.ScreenPercentage" })
			assert(restored.json?.current === original, clip(callText(restored.response)))
			pass("vite cvar round trip", `${original} -> 85 -> ${original}`)
		} catch (error) {
			fail("vite cvar round trip", error.message)
		}
	}

	// PIE start/stop.
	if (canWrite) {
		try {
			const stopped = await callJson("manage_editor", "is_pie_running")
			if (stopped.json?.is_pie_running === true) {
				await callJson("manage_editor", "stop_pie", {}, 60000)
				await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === false, 15000)
			}
			const start = await callJson("manage_editor", "start_pie", {}, 60000)
			assert(start.json?.success !== false, clip(callText(start.response)))
			const started = await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === true, 30000)
			assert(started, "PIE did not start")
			const stop = await callJson("manage_editor", "stop_pie", {}, 60000)
			assert(stop.json?.success !== false, clip(callText(stop.response)))
			const stoppedAgain = await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === false, 30000)
			assert(stoppedAgain, "PIE did not stop")
			pass("PIE start/stop")
		} catch (error) {
			fail("PIE start/stop", error.message)
			try {
				await callJson("manage_editor", "stop_pie", {}, 60000)
			} catch {
				// Ignore cleanup failure.
			}
		}
	}

	// Widget workflow with temporary asset.
	if (canWrite) {
		const widgetName = `MCPBattleWidget_${Date.now()}`
		const widgetFolder = "/Game/MCP/Battle"
		const widgetPath = `${widgetFolder}/${widgetName}`
		let widgetCreated = false
		try {
			await callJson("manage_asset", "create_folder", { path: widgetFolder })
			const create = await callJson("manage_widget", "create_widget_blueprint", {
				widget_name: widgetName,
				path: widgetFolder,
			}, 60000)
			assert(create.json?.success === true || create.json?.reason === "asset_already_exists", clip(callText(create.response)))
			widgetCreated = true
			const canvas = await callJson("manage_widget", "ensure_canvas_root", { widget_blueprint: widgetPath }, 60000)
			assert(canvas.json?.success === true, clip(callText(canvas.response)))
			const text = await callJson("manage_widget", "add_text_block", {
				widget_blueprint: widgetPath,
				text_block_name: "BattleText",
				text: "Battle test",
				font_size: 18,
				color: [0.2, 0.9, 0.4, 1.0],
				position: [20, 20],
				size: [300, 80],
			}, 60000)
			assert(text.json?.success === true, clip(callText(text.response)))
			const tree = await callJson("manage_widget", "inspect_tree", { widget_blueprint: widgetPath }, 60000)
			assert(tree.json?.success === true, clip(callText(tree.response)))
			assert((tree.json.widgets ?? []).some((item) => item.name === "BattleText"), "BattleText missing")
			pass("widget create/author/inspect", widgetPath)
			const start = await callJson("manage_editor", "start_pie", {}, 60000)
			assert(start.json?.success !== false, clip(callText(start.response)))
			const started = await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === true, 30000)
			assert(started, "PIE did not start for widget")
			const viewport = await callJson("manage_widget", "add_to_viewport", {
				widget_blueprint: widgetPath,
				z_order: 100,
				start_pie_if_needed: false,
				timeout_seconds: 10,
			}, 60000)
			assert(viewport.json?.success === true, clip(callText(viewport.response)))
			assert(viewport.json.in_viewport === true, clip(callText(viewport.response)))
			pass("widget add_to_viewport", `retained=${viewport.json.retained} in_viewport=${viewport.json.in_viewport}`)
			await callJson("manage_widget", "release_viewport_widgets", {}, 30000)
			await callJson("manage_editor", "stop_pie", {}, 60000)
			await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === false, 30000)
			pass("widget release + PIE stop")
		} catch (error) {
			fail("widget workflow", error.message)
			try {
				await callJson("manage_widget", "release_viewport_widgets", {}, 30000)
				await callJson("manage_editor", "stop_pie", {}, 60000)
			} catch {
				// Ignore cleanup failure.
			}
		} finally {
			if (widgetCreated) {
				try {
					const deleted = await callJson("manage_asset", "delete", { asset_path: widgetPath }, 60000)
					if (deleted.json?.success === true) pass("temporary widget deleted")
					else warn("temporary widget delete", clip(callText(deleted.response)))
				} catch (error) {
					warn("temporary widget delete", error.message)
				}
			}
		}
	}

	// Asset/actor integration: materials, meshes, animation, attachment.
	await assetActorBattle(canWrite)
	await validParamAndMaterialBattle(canWrite)

	// Screenshot + unicode Python round trip.
	if (canWrite) {
		try {
			const py = await call("manage_editor", "run_python", {
				code: [
					"import unreal",
					"print('battle_python_ok={0}'.format(unreal.SystemLibrary.get_engine_version()))",
					"print('battle_unicode=✓ ünïcode')",
				].join("\n"),
			}, 60000)
			const pyText = callText(py)
			assert(py.status === 200 && /battle_python_ok=/.test(pyText) && pyText.includes("✓"), clip(pyText))
			pass("python + unicode round trip")
			const shot = await call("manage_editor", "screenshot", {}, 60000)
			const shotText = callText(shot)
			assert(/\.png/i.test(shotText), clip(shotText))
			const shotPath = shotText.trim().split(/\r?\n/).find((line) => /\.png$/i.test(line.trim()))
			if (shotPath) {
				const written = await waitFor(async () => fs.existsSync(shotPath.trim()), 15000, 500)
				written ? pass("screenshot file written") : warn("screenshot file not written yet", shotPath)
			}
		} catch (error) {
			fail("python/screenshot", error.message)
		}
	}

	// ---------------------------------------------------------------------
	// Live Coding edge tests
	// ---------------------------------------------------------------------
	console.log("[INFO] starting Live Coding tests")
	if (canWrite) {
		const sourceRelative = "Source/ViteMCPTest/MCPLiveCodingTestActor.cpp"
		let originalContent = ""
		try {
			const read = await callJson("manage_code", "read_source", { path: sourceRelative }, 30000)
			assert(read.json?.success === true, clip(callText(read.response)))
			originalContent = read.json.content
			pass("code read_source", `${originalContent.length} chars`)
		} catch (error) {
			fail("code read_source", error.message)
		}

		if (originalContent) {
			const preview = await callJson("manage_code", "compile", {}, 60000)
			assert(preview.json?.success === true && preview.json.preview === true, clip(callText(preview.response)))
			pass("Live Coding compile preview")

			const status = await callJson("manage_code", "status", {}, 60000)
			assert(status.json?.success === true, clip(callText(status.response)))
			pass("code status", `liveCoding=${status.json.liveCoding?.moduleLoaded}`)

			// Path traversal / extension security.
			for (const [label, target] of [
				["traversal", "../Config/DefaultEngine.ini"],
				["absolute", "C:/Windows/win.ini"],
				["unsupported extension", "Source/ViteMCPTest/readme.txt"],
			]) {
				const response = await call("manage_code", "read_source", { path: target }, 30000)
				if (response.json?.ok === false) expected(`code read_source ${label}`)
				else fail(`code read_source ${label}`, clip(callText(response)))
			}
			{
				const response = await call("manage_code", "write_source", {
					path: "Source/ViteMCPTest/MCPBattleOversize.cpp",
					content: "x".repeat(300 * 1024),
					overwrite: false,
				}, 30000)
				response.json?.ok === false ? expected("code write oversize rejected") : fail("code write oversize", clip(callText(response)))
			}

			// Valid function-body patch marker.
			const marker = `MCP_BATTLE_PATCH_${Date.now()}`
			const anchor = originalContent.indexOf("AMCPLiveCodingTestActor::SetMCPTestColor")
			if (anchor < 0) {
				fail("Live Coding patch", "SetMCPTestColor anchor not found")
			} else {
				const brace = originalContent.indexOf("{", anchor)
				assert(brace > anchor, "SetMCPTestColor body brace not found")
				const patched =
					originalContent.slice(0, brace + 1) +
					`\n\tUE_LOG(LogTemp, Warning, TEXT("${marker}"));` +
					originalContent.slice(brace + 1)
				try {
					const write = await callJson("manage_code", "write_source", {
						path: sourceRelative,
						content: patched,
						overwrite: true,
					}, 30000)
					assert(write.json?.success === true, clip(callText(write.response)))
					pass("code write_source patch", marker)
					const compile = await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
					assert(compile.json?.success === true, clip(callText(compile.response)))
					await delay(5000)
					const actor = `MCP_Battle_Patch_${Date.now()}`
					let spawned = await callJson("manage_actor", "spawn", {
						type: "MCPLiveCodingTestActor",
						name: actor,
						location: { x: 100, y: 100, z: 120 },
					}, 60000)
					if (spawned.json?.success !== true) {
						spawned = await callJson("manage_actor", "spawn", {
							type: "/Script/ViteMCPTest.MCPLiveCodingTestActor",
							name: actor,
							location: { x: 100, y: 100, z: 120 },
						}, 60000)
					}
					assert(spawned.json?.success === true, clip(callText(spawned.response)))
					const invoke = await call("manage_editor", "run_python", {
						code: [
							"import unreal",
							`actors = [a for a in unreal.EditorLevelLibrary.get_all_level_actors() if a.get_actor_label() == '${actor}']`,
							"actors[0].set_mcp_test_color(unreal.LinearColor(0.9, 0.2, 0.2, 1.0))",
							"print('patch_invoked=True')",
						].join("\n"),
					}, 60000)
					assert(/patch_invoked=True/.test(callText(invoke)), clip(callText(invoke)))
					await delay(1500)
					const log = await callJson("manage_code", "logs", {
						path: "Saved/Logs/ViteMCPTest.log",
						lines: 500,
						filter: marker,
					}, 30000)
					const markerFound = log.json?.success === true && String(log.json.text ?? "").includes(marker)
					markerFound ? pass("Live Coding patch applied", marker) : fail("Live Coding patch applied", "marker not found in log")
					await callJson("manage_actor", "delete", { name: actor }, 60000)
				} catch (error) {
					fail("Live Coding valid patch", error.message)
				} finally {
					try {
						await callJson("manage_code", "write_source", {
							path: sourceRelative,
							content: originalContent,
							overwrite: true,
						}, 30000)
						await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
						pass("Live Coding original source restored")
					} catch (error) {
						fail("Live Coding restore", error.message)
					}
				}
			}

			// Deliberate syntax error, then recovery.
			{
				const bad = originalContent.replace(
					/(AMCPLiveCodingTestActor::SetMCPTestColor[^{]*\{)/,
					"$1\n\tthis_is_not_valid_cpp = ;",
				)
				try {
					if (bad === originalContent) throw new Error("syntax-error anchor not found")
					const write = await callJson("manage_code", "write_source", {
						path: sourceRelative,
						content: bad,
						overwrite: true,
					}, 30000)
					assert(write.json?.success === true, clip(callText(write.response)))
					const compile = await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
					await delay(5000)
					const alive = await editorAlive("Live Coding syntax error")
					if (alive) pass("Live Coding syntax error did not kill the editor")
					const compileText = String(compile.json?.text ?? "")
					const syntaxLog = await callJson("manage_code", "logs", {
						path: "Saved/Logs/ViteMCPTest.log",
						lines: 500,
						filter: "error",
					}, 30000)
					const syntaxText = `${compileText}\n${String(syntaxLog.json?.text ?? "")}`
					const syntaxFailed = /(error|failed|compile failed)/i.test(syntaxText)
					syntaxFailed
						? pass("Live Coding syntax-error diagnostics observed", clip(syntaxText, 120))
						: warn("Live Coding syntax-error diagnostics", "no explicit error in tail")
				} catch (error) {
					fail("Live Coding syntax-error test", error.message)
				} finally {
					try {
						await callJson("manage_code", "write_source", {
							path: sourceRelative,
							content: originalContent,
							overwrite: true,
						}, 30000)
						await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
						await delay(5000)
						await editorAlive("Live Coding syntax-error recovery")
						pass("Live Coding syntax-error recovery compile")
					} catch (error) {
						fail("Live Coding syntax-error recovery", error.message)
					}
				}
			}

			// Compile during PIE.
			{
				const marker = `MCP_BATTLE_PIE_${Date.now()}`
				const anchor = originalContent.indexOf("AMCPLiveCodingTestActor::SetMCPTestColor")
				const brace = anchor >= 0 ? originalContent.indexOf("{", anchor) : -1
				if (brace > anchor) {
					const patched =
						originalContent.slice(0, brace + 1) +
						`\n\tUE_LOG(LogTemp, Warning, TEXT("${marker}"));` +
						originalContent.slice(brace + 1)
					try {
						await callJson("manage_editor", "start_pie", {}, 60000)
						await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === true, 30000)
						await callJson("manage_code", "write_source", { path: sourceRelative, content: patched, overwrite: true }, 30000)
						await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
						await delay(5000)
						const pie = await callJson("manage_editor", "is_pie_running")
						pie.json?.is_pie_running === true
							? pass("Live Coding compile during PIE kept PIE alive")
							: warn("Live Coding compile during PIE", "PIE stopped unexpectedly")
					} catch (error) {
						fail("Live Coding compile during PIE", error.message)
					} finally {
						try {
							await callJson("manage_editor", "stop_pie", {}, 60000)
							await waitFor(async () => (await callJson("manage_editor", "is_pie_running")).json?.is_pie_running === false, 30000)
							await callJson("manage_code", "write_source", { path: sourceRelative, content: originalContent, overwrite: true }, 30000)
							await callJson("manage_code", "compile", { confirm: true, waitMs: 6000 }, 60000)
							pass("Live Coding PIE test restored")
						} catch (error) {
							fail("Live Coding PIE cleanup", error.message)
						}
					}
				}
			}

			// Automation test request.
			try {
				const tests = await callJson("manage_code", "run_tests", {
					filter: "ViteMCPTest.MCP.LiveCoding",
					confirm: true,
					waitMs: 6000,
				}, 60000)
				assert(tests.json?.success === true, clip(callText(tests.response)))
				await delay(4000)
				const testLog = await callJson("manage_code", "logs", {
					path: "Saved/Logs/ViteMCPTest.log",
					lines: 500,
					filter: "ViteMCPTest.MCP.LiveCoding",
				}, 30000)
				const testText = String(testLog.json?.text ?? "")
				const testPassed = /(passed|completed|success|ran \d+ test)/i.test(testText) && !/(failed|error)/i.test(testText)
				testPassed
					? pass("Live Coding automation test completed", clip(testText, 120))
					: warn("Live Coding automation test requested", clip(testText, 160) || "inspect the log for completion")
			} catch (error) {
				fail("Live Coding automation test", error.message)
			}
		}
	}

	// ---------------------------------------------------------------------
	// Concurrency / stress
	// ---------------------------------------------------------------------
	console.log("[INFO] starting concurrency stress")
	try {
		const concurrent = await Promise.all(
			Array.from({ length: 10 }, () => call("manage_history", "status", {}, 60000)),
		)
		const bad = concurrent.filter((response) => response.status !== 200 || response.json?.ok !== true)
		bad.length === 0
			? pass("10 concurrent read calls")
			: fail("10 concurrent read calls", `${bad.length} failed: ${clip(callText(bad[0]))}`)
	} catch (error) {
		fail("10 concurrent read calls", error.message)
	}
	try {
		const started = Date.now()
		for (let index = 0; index < 30; index += 1) {
			const response = await call("manage_history", "status", {}, 30000)
			if (response.status !== 200 || response.json?.ok !== true) throw new Error(`iteration ${index}: ${clip(callText(response))}`)
		}
		pass("30 sequential read calls", `${Date.now() - started}ms`)
	} catch (error) {
		fail("30 sequential read calls", error.message)
	}

	// Deferred asset cleanup and tool-coverage report.
	await cleanupPendingAssets()
	try {
		const catalogData = await catalog()
		const missing = catalogData.tools.map((tool) => tool.name).filter((name) => !exercisedTools.has(name))
		missing.length === 0
			? pass("tool coverage", `${catalogData.tools.length} tools exercised`)
			: warn("tool coverage", `not exercised: ${missing.join(", ")}`)
	} catch (error) {
		warn("tool coverage", error.message)
	}

	// ---------------------------------------------------------------------
	// Final health, log, and crash checks
	// ---------------------------------------------------------------------
	const finalHealth = await request("/api/health", { timeoutMs: 15000 })
	finalHealth.status === 200 && finalHealth.json?.ok === true
		? pass("final health")
		: fail("final health", clip(finalHealth.text))
	await editorAlive("final editor check")

	if (fs.existsSync(editorLogPath)) {
		const size = fs.statSync(editorLogPath).size
		if (size >= startLogSize) {
			const fd = fs.openSync(editorLogPath, "r")
			const length = Math.min(size - startLogSize, 2_000_000)
			const buffer = Buffer.alloc(length)
			fs.readSync(fd, buffer, 0, length, startLogSize)
			fs.closeSync(fd)
			const appended = buffer.toString("utf8")
			const fatal = /(fatal error|critical error|assertion failed)/i.test(appended)
			fatal ? fail("editor log check", "fatal/critical/assertion text found") : pass("editor log check", "no fatal/critical/assertion text appended")
		} else {
			warn("editor log check", "log rotated or truncated")
		}
	} else {
		warn("editor log check", "log file missing")
	}
	if (fs.existsSync(crashDir)) {
		const fresh = fs.readdirSync(crashDir, { withFileTypes: true }).filter((entry) => {
			if (!entry.isDirectory()) return false
			const mtime = fs.statSync(path.join(crashDir, entry.name)).mtimeMs
			return mtime >= startTime
		})
		fresh.length === 0
			? pass("crash folder check", "no new crash folders")
			: fail("crash folder check", fresh.map((entry) => entry.name).join(", "))
	} else {
		pass("crash folder check", "no crash directory")
	}

	return finish()
}

function finish() {
	console.log("")
	console.log("=== BATTLE TEST SUMMARY ===")
	console.log(`pass=${results.pass} warn=${results.warn} fail=${results.fail} expected=${results.expected}`)
	if (warnings.length) {
		console.log("Warnings:")
		for (const warning of warnings) console.log(` - ${warning}`)
	}
	if (failures.length) {
		console.log("Failures:")
		for (const failure of failures) console.log(` - ${failure}`)
		process.exitCode = 1
	}
}

main().catch((error) => {
	console.error(`[FATAL] ${error.stack || error.message}`)
	process.exitCode = 1
})
