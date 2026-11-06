#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const descriptorPath =
	process.env.UEV_CONTROL_DESCRIPTOR ||
	path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "UnrealMcp", "control.json")
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"))
const baseUrl = `http://127.0.0.1:${descriptor.port}`
let passed = 0
let failed = 0

const assert = (condition, message) => {
	if (!condition) {
		throw new Error(message)
	}
}

const pass = (name, detail = "") => {
	passed += 1
	console.log(`[PASS] ${name}${detail ? `: ${detail}` : ""}`)
}

const callRaw = async (tool, action, params = {}) => {
	const response = await fetch(`${baseUrl}/api/call`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${descriptor.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ tool, action, params }),
		signal: AbortSignal.timeout(120_000),
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${tool}.${action} returned non-JSON: ${text.slice(0, 300)}`)
	}
	if (!json.ok) {
		throw new Error(`${tool}.${action} transport failed: ${json.text ?? text}`)
	}
	return String(json.text ?? "")
}

const call = async (tool, action, params = {}) => {
	const text = await callRaw(tool, action, params)
	let payload
	try {
		payload = JSON.parse(text)
	} catch {
		throw new Error(`${tool}.${action} returned non-JSON payload: ${text.slice(0, 300)}`)
	}
	assert(payload.success === true, `${tool}.${action}: ${payload.message ?? "failed"}`)
	return payload
}

async function main() {
	const namespaces = await call("manage_tools", "list_namespaces", {})
	const animation = namespaces.namespaces.find((entry) => entry.tool_namespace === "manage_animation")
	assert(animation, "manage_animation namespace is missing")
	pass("manage_animation namespace", `${animation.supported_actions.length} actions`)

	const python = await callRaw("manage_editor", "run_python", {
		code: "import unreal\nprint('loaded=' + str(hasattr(unreal, 'UEVGraphLibrary')))",
	})
	assert(python.includes("loaded=True"), "UEVGraphLibrary is not loaded")
	pass("UEVGraphAuthoring module loaded")

	const sequences = await call("manage_animation", "search_animation_assets", {
		search_term: "ThirdPerson",
		limit: 20,
	})
	assert(sequences.assets.length > 0, "No animation assets found")
	pass("search_animation_assets", `${sequences.assets.length} assets`)

	const animGraph = await call("manage_animation", "inspect_graph", {
		anim_blueprint: "/Game/Mannequin/Animations/ThirdPerson_AnimBP",
	})
	assert(animGraph.graph?.name === "AnimGraph", "AnimGraph was not inspected")
	pass("inspect_graph", `${animGraph.graph.node_count} root nodes`)

	const sequence = await call("manage_animation", "inspect_sequence", {
		sequence_path: "/Game/Mannequin/Animations/ThirdPersonIdle",
	})
	assert(sequence.length > 0, "Sequence length is missing")
	pass("inspect_sequence", `${sequence.length.toFixed(3)}s`)

	const blueprint = await call("manage_blueprint", "inspect_graph", {
		blueprint_name: "/Game/ThirdPersonCPP/Blueprints/ThirdPersonCharacter",
		include_nodes: false,
	})
	assert(Array.isArray(blueprint.graphs), "Blueprint graphs are missing")
	pass("Blueprint graph inspection", `${blueprint.graphs.length} graphs`)

	const material = await call("manage_material", "inspect_graph", {
		asset_path: "/Game/Mannequin/Character/Materials/M_Male_Body",
	})
	assert(Array.isArray(material.expressions), "Material expressions are missing")
	pass("Material graph inspection", `${material.expressions.length} expressions`)

	console.log(`\nGraph-authoring check completed: ${passed} passed, ${failed} failed.`)
}

main().catch((error) => {
	failed += 1
	console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
