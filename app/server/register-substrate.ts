import { z } from "zod"

import { UESubstrateTool } from "./editor/tools-substrate.js"
import { RegistrationContext } from "./registration-context.js"

const targetShape = {
	handle: z
		.string()
		.optional()
		.describe(
			"Handle from a previous result: 'uev:<kind>:<object path>' is stable (survives releases, PIE transitions and editor restarts). Legacy 'obj_<n>' is still accepted but only stays valid until the retained-object registry is released.",
		),
	target: z.string().optional(),
	selector: z.record(z.any()).optional(),
	world: z.enum(["editor", "pie"]).optional(),
}

const paginationShape = {
	limit: z.number().int().min(1).max(500).optional(),
	offset: z.number().int().min(0).optional(),
	compact: z.boolean().optional(),
}

const queryShape = {
	class: z.string().optional(),
	label: z.string().optional(),
	tag: z.string().optional(),
	component: z.string().optional(),
	asset_ref: z.string().optional(),
	path: z.string().optional(),
	world: z.enum(["editor", "pie"]).optional(),
	...paginationShape,
}

const spawnShape = {
	class: z.string(),
	label: z.string().optional(),
	name: z.string().optional(),
	location: z.any().optional(),
	rotation: z.any().optional(),
	scale: z.any().optional(),
	folder: z.string().optional(),
	properties: z.record(z.any()).optional(),
	world: z.enum(["editor", "pie"]).optional(),
}

export function registerSubstrateNamespaces(ctx: RegistrationContext) {
	const { pythonDispatch, registerToolNamespace } = ctx
	const run = (operation: string, args: Record<string, unknown>) =>
		pythonDispatch(UESubstrateTool(operation, args || {}))

	registerToolNamespace(
		"manage_query",
		"Find objects in the level or assets by class, label, tag, component or asset reference. Each result carries a stable 'uev:<kind>:<object path>' handle for manage_object plus the numeric 'native_handle' (obj_<n>).",
		{
			query: {
				paramsSchema: z.object(queryShape).strict(),
				handler: (params) => run("query", params),
			},
		},
	)

	registerToolNamespace(
		"manage_object",
		"Generic UObject control: describe schema, read/write any property path, call functions, spawn by class path, destroy, duplicate, and run transactional batches.",
		{
			describe: {
				paramsSchema: z
					.object({
						...targetShape,
						class: z.string().optional(),
						values: z.boolean().optional(),
						functions: z.boolean().optional(),
					})
					.strict(),
				handler: (params) => run("describe", params),
			},
			get: {
				paramsSchema: z.object({ ...targetShape, path: z.string() }).strict(),
				handler: (params) => run("get", params),
			},
			set: {
				paramsSchema: z
					.object({
						...targetShape,
						path: z.string(),
						value: z.any(),
						dry_run: z.boolean().optional(),
					})
					.strict(),
				handler: (params) => run("set", params),
			},
			call: {
				paramsSchema: z
					.object({
						...targetShape,
						function: z.string(),
						args: z.array(z.any()).optional(),
					})
					.strict(),
				handler: (params) => run("call", params),
			},
			spawn: {
				paramsSchema: z.object(spawnShape).strict(),
				handler: (params) => run("spawn", params),
			},
			ensure: {
				paramsSchema: z.object(spawnShape).strict(),
				handler: (params) => run("ensure", params),
			},
			destroy: {
				paramsSchema: z.object({ ...targetShape }).strict(),
				handler: (params) => run("destroy", params),
			},
			duplicate: {
				paramsSchema: z
					.object({
						...targetShape,
						count: z.number().int().min(1).max(500).optional(),
						offset: z.any().optional(),
					})
					.strict(),
				handler: (params) => run("duplicate", params),
			},
			apply: {
				paramsSchema: z
					.object({
						operations: z.array(
							z
								.object({
									action: z.string(),
									params: z.record(z.any()).optional(),
								})
								.strict(),
						),
						label: z.string().optional(),
						dry_run: z.boolean().optional(),
						world: z.enum(["editor", "pie"]).optional(),
					})
					.strict(),
				handler: (params) => run("batch", params),
			},
			release_handles: {
				paramsSchema: z.object({}).strict(),
				handler: () => run("release_handles", {}),
			},
		},
	)
}
