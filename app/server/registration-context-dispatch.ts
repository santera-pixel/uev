import { z } from "zod"

import { type CrashGuardRefusal, evaluateRequestGuards } from "./crash-guards.js"
import { tryRunCommand } from "./remote-execution.js"

export type NamespaceDispatchResult = { kind: "python"; command: string } | { kind: "direct"; payload: unknown }

export interface RegisteredToolHandler {
	name: string
	description: string
	inputSchema?: unknown
	kind: "namespace" | "direct"
	hidden?: boolean
	handler: (args: any) => unknown | Promise<unknown>
}

export type ToolHandlerRegistry = Map<string, RegisteredToolHandler>

export interface NamespaceActionParam {
	name: string
	type: string
	required: boolean
	description?: string
	enum?: string[]
	properties?: Record<string, NamespaceActionParam>
	items?: NamespaceActionParam
	/** Value descriptor for an open record parameter (the catalog's `additionalProperties`). */
	additionalProperties?: NamespaceActionParam
	/** Distinct shapes the original schema accepted (for example ["object", "array"] for vector shorthands). */
	variants?: string[]
	/** Field that selects the active shape for a discriminated union (for example "kind"). */
	discriminator?: string
}

export type NamespaceActionHandler = (
	params: Record<string, any>,
) => NamespaceDispatchResult | Promise<NamespaceDispatchResult>

export interface NamespaceActionDefinition {
	description?: string
	handler: NamespaceActionHandler
	paramsSchema?: z.ZodTypeAny
}

export type NamespaceActionRegistration = NamespaceActionDefinition | NamespaceActionHandler
export interface ToolNamespaceRegistrationOptions {
	compactParamsSchema?: boolean
	hidden?: boolean
}

type TextResponse = { content: Array<{ type: "text"; text: string }> }

interface DispatchHelperOptions {
	rawServerRegisterTool: (name: string, config: Record<string, unknown>, cb: (...args: any[]) => unknown) => unknown
	rawServerTool: (...args: any[]) => unknown
	recordSchema: z.ZodRecord<z.ZodString, z.ZodAny>
	safetyGuard: (options: {
		tool: string
		action?: string
		args: unknown
		callback: () => unknown | Promise<unknown>
	}) => Promise<unknown>
	/** Request-only crash guards; defaults to the shared registry. */
	crashGuard?: (request: {
		tool: string
		action: string
		params: Record<string, unknown>
	}) => CrashGuardRefusal | undefined
	textResponse: (text: string) => TextResponse
	toolHandlerRegistry: ToolHandlerRegistry
	toolNamespaceRegistry: Map<
		string,
		{ description: string; supportedActions: string[]; params: Record<string, NamespaceActionParam[]> }
	>
}

const unwrapZodType = (schema: any): any => {
	let current = schema
	for (let index = 0; index < 8 && current?._def; index += 1) {
		const typeName = current._def.typeName
		if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
			current = current._def.innerType
			continue
		}
		if (typeName === "ZodEffects") {
			current = current._def.schema
			continue
		}
		break
	}
	return current
}

export interface ZodTypeDescription {
	type: string
	enum?: string[]
	properties?: Record<string, NamespaceActionParam>
	items?: NamespaceActionParam
	/** Value descriptor for an open record, emitted as the catalog's `additionalProperties`. */
	additionalProperties?: NamespaceActionParam
	/** Distinct shapes a union accepts, as type names (for example ["object", "array"]). */
	variants?: string[]
	/** Field that selects the active shape for a discriminated union (for example "kind"). */
	discriminator?: string
}

const describeParam = (name: string, field: any, depth: number): NamespaceActionParam => {
	const fieldType = field?._def?.typeName
	const innerField = unwrapZodType(field)
	const described = describeZodType(field, depth)
	return {
		name,
		type: described.type,
		required: fieldType !== "ZodOptional" && fieldType !== "ZodDefault" && fieldType !== "ZodNullable",
		description: field?._def?.description ?? innerField?._def?.description,
		enum: described.enum,
		properties: described.properties,
		items: described.items,
		additionalProperties: described.additionalProperties,
		variants: described.variants,
		discriminator: described.discriminator,
	}
}

const describeZodType = (schema: any, depth = 0): ZodTypeDescription => {
	const inner = unwrapZodType(schema)
	switch (inner?._def?.typeName) {
		case "ZodString":
			return { type: "string" }
		case "ZodNumber":
			return { type: "number" }
		case "ZodBoolean":
			return { type: "boolean" }
		case "ZodLiteral":
			return { type: typeof inner._def.value, enum: [String(inner._def.value)] }
		case "ZodEnum":
			return { type: "string", enum: [...(inner._def.values ?? [])] }
		case "ZodNativeEnum":
			return { type: "string", enum: Object.values(inner._def.values ?? {}).filter((v) => typeof v === "string") as string[] }
		case "ZodArray": {
			const items = inner._def.type ? describeParam("item", inner._def.type, depth + 1) : undefined
			return { type: "array", items }
		}
		case "ZodTuple": {
			// Tuples (vector/rotator/color shorthands) are arrays with a fixed element list; describe the element
			// type when every entry agrees so the panel can still render typed element editors.
			const tupleItems: any[] = Array.isArray(inner._def.items) ? inner._def.items : []
			const described = tupleItems.map((item: any) => describeZodType(item, depth + 1))
			const uniform = described.length > 0 && described.every((entry) => entry.type === described[0]!.type)
			const items = uniform ? describeParam("item", tupleItems[0], depth + 1) : undefined
			return { type: "array", items }
		}
		case "ZodObject": {
			if (depth >= 6) {
				return { type: "object" }
			}
			const shape = typeof inner._def.shape === "function" ? inner._def.shape() : {}
			const properties: Record<string, NamespaceActionParam> = {}
			for (const [name, field] of Object.entries(shape)) {
				properties[name] = describeParam(name, field, depth + 1)
			}
			return { type: "object", properties }
		}
		case "ZodRecord": {
			const valueType = inner._def.valueType
			const describedValue = valueType ? describeZodType(valueType, depth + 1) : undefined
			// z.record(z.any()) stays a bare object; a typed record advertises its value shape.
			const additionalProperties =
				valueType && describedValue && describedValue.type !== "any"
					? describeParam("value", valueType, depth + 1)
					: undefined
			return { type: "object", additionalProperties }
		}
		case "ZodUnion": {
			const options: ZodTypeDescription[] = (inner._def.options ?? []).map((option: any) =>
				describeZodType(option, depth + 1),
			)
			const variants: string[] = Array.from(new Set(options.map((option) => option.type)))
			const enumValues = Array.from(new Set(options.flatMap((option) => option.enum ?? [])))
			const objectOptions = options.filter(
				(option: ZodTypeDescription) =>
					option.type === "object" && option.properties && Object.keys(option.properties).length > 0,
			)
			const arrayOptions = options.filter((option: ZodTypeDescription) => option.type === "array")
			// Prefer the most specific declared shape (object with properties, then array) over collapsing to "any":
			// union shorthands such as vector3/color accept both an object and a tuple, and the panel needs the
			// object fields to render typed subforms.
			const bestObject = objectOptions.sort(
				(left: ZodTypeDescription, right: ZodTypeDescription) =>
					Object.keys(right.properties ?? {}).length - Object.keys(left.properties ?? {}).length,
			)[0]
			if (bestObject) {
				return {
					type: "object",
					properties: bestObject.properties,
					items: arrayOptions.find((option: ZodTypeDescription) => option.items)?.items,
					enum: enumValues.length > 0 ? enumValues : undefined,
					variants,
				}
			}
			if (arrayOptions.length > 0) {
				return {
					type: "array",
					items: arrayOptions.find((option: ZodTypeDescription) => option.items)?.items,
					enum: enumValues.length > 0 ? enumValues : undefined,
					variants,
				}
			}
			return {
				type: variants.length === 1 ? variants[0]! : "any",
				enum: enumValues.length > 0 ? enumValues : undefined,
				variants: variants.length > 1 ? variants : undefined,
			}
		}
		case "ZodDiscriminatedUnion": {
			// A discriminated union (for example pie_expect conditions) declares one shape per discriminator value.
			// Merge those shapes into a single object so the panel can render one typed form: the discriminator
			// keeps every value it accepts, shared fields keep the first description, and fields that only one
			// variant declares stay optional.
			const discriminator = typeof inner._def.discriminator === "string" ? inner._def.discriminator : undefined
			const optionSource = inner._def.options
			const optionSchemas: any[] =
				optionSource instanceof Map ? Array.from(optionSource.values()) : Array.isArray(optionSource) ? optionSource : []
			const optionDescriptions: ZodTypeDescription[] = optionSchemas.map((option) =>
				describeZodType(option, depth + 1),
			)
			const properties: Record<string, NamespaceActionParam> = {}
			for (const option of optionDescriptions) {
				for (const [name, property] of Object.entries(option.properties ?? {})) {
					const existing = properties[name]
					if (!existing) {
						properties[name] = { ...property, required: false }
						continue
					}
					const mergedEnum = Array.from(new Set([...(existing.enum ?? []), ...(property.enum ?? [])]))
					properties[name] = {
						...existing,
						description: existing.description ?? property.description,
						required: existing.required && property.required,
						enum: mergedEnum.length > 0 ? mergedEnum : existing.enum,
						properties: existing.properties ?? property.properties,
						items: existing.items ?? property.items,
						additionalProperties: existing.additionalProperties ?? property.additionalProperties,
					}
				}
			}
			if (discriminator && properties[discriminator]) {
				properties[discriminator] = { ...properties[discriminator]!, required: true }
			}
			return {
				type: "object",
				properties,
				discriminator,
				variants: Array.from(new Set(optionDescriptions.map((option) => option.type))),
			}
		}
		default:
			return { type: "any" }
	}
}

const describeActionParams = (schema: z.ZodTypeAny | undefined): NamespaceActionParam[] => {
	const inner = unwrapZodType(schema)
	if (inner?._def?.typeName !== "ZodObject") {
		return []
	}
	const shape = typeof inner._def.shape === "function" ? inner._def.shape() : {}
	return Object.entries(shape).map(([name, field]) => describeParam(name, field, 0))
}

export function createDispatchHelpers(options: DispatchHelperOptions) {
	const {
		rawServerRegisterTool,
		rawServerTool,
		recordSchema,
		safetyGuard,
		crashGuard = evaluateRequestGuards,
		textResponse,
		toolHandlerRegistry,
		toolNamespaceRegistry,
	} = options

	const pythonDispatch = (command: string): NamespaceDispatchResult => ({ kind: "python", command })
	const directDispatch = (payload: unknown): NamespaceDispatchResult => ({ kind: "direct", payload })
	const normalizeActionName = (action: string) => action.trim().toLowerCase()
	const normalizeActionDefinition = (actionRegistration: NamespaceActionRegistration): NamespaceActionDefinition =>
		typeof actionRegistration === "function" ? { handler: actionRegistration } : actionRegistration

	const registerPythonTool = (
		name: string,
		description: string,
		schema: Record<string, z.ZodTypeAny>,
		buildCommand: (args: any) => string,
	) => {
		rawServerTool(name, description, schema, async (args: any) => textResponse(await tryRunCommand(buildCommand(args))))
	}

	const registerZeroArgPythonTool = (name: string, description: string, buildCommand: () => string) => {
		rawServerTool(name, description, async () => textResponse(await tryRunCommand(buildCommand())))
	}

	const unsupportedNamespaceAction = (
		toolName: string,
		action: string,
		supportedActions: string[],
	): NamespaceDispatchResult =>
		directDispatch({
			success: false,
			message: `Action '${action}' is not supported by ${toolName} in this UE4.27 port.`,
			supported_actions: supportedActions,
		})

	const runNamespaceDispatch = async (result: NamespaceDispatchResult) => {
		if (result.kind === "python") {
			return textResponse(await tryRunCommand(result.command))
		}

		return textResponse(JSON.stringify(result.payload, null, 2))
	}

	const coerceNamespaceParams = (
		params: unknown,
	): { success: true; params: Record<string, any> } | { success: false; message: string } => {
		if (params === undefined || params === null) {
			return { success: true, params: {} }
		}
		if (typeof params === "string") {
			const text = params.trim()
			if (!text) {
				return { success: true, params: {} }
			}
			try {
				const parsed = JSON.parse(text)
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return { success: true, params: parsed as Record<string, any> }
				}
				return {
					success: false,
					message: "params must decode to a JSON object, not an array or primitive value.",
				}
			} catch {
				return {
					success: false,
					message:
						"params was sent as a string but is not valid JSON. Pass a real JSON object, not a JSON-encoded string.",
				}
			}
		}
		if (typeof params !== "object" || Array.isArray(params)) {
			return { success: false, message: "params must be a JSON object." }
		}
		return { success: true, params: params as Record<string, any> }
	}

	const namespaceActionSchema = (supportedActions: string[]) =>
		supportedActions.length === 1
			? z.literal(supportedActions[0])
			: z.enum(supportedActions as [string, string, ...string[]])

	const namespaceParamsSchema = (
		name: string,
		supportedActions: string[],
		normalizedActions: Record<string, NamespaceActionDefinition>,
		options: ToolNamespaceRegistrationOptions = {},
	) => {
		if (options.compactParamsSchema) {
			return z.union([recordSchema, z.string()]).describe(
				`Parameters for the selected ${name} action. Runtime validation is action-specific. Supported actions: ${supportedActions
					.map((actionName) => `${name}.${actionName}`)
					.join(", ")}.`,
			)
		}

		const paramsSchemas = supportedActions.map((actionName) => {
			const actionDefinition = normalizedActions[actionName]
			return (actionDefinition.paramsSchema ?? z.object({}).strict()).describe(
				actionDefinition.description
					? `${name}.${actionName}: ${actionDefinition.description}`
					: `Parameters for ${name}.${actionName}`,
			)
		})

		// Accept a JSON-encoded string at the transport layer so the handler can
		// coerce it and return a clear, action-specific error. Strict clients still
		// see the per-action object schemas first.
		const transportSchemas = [...paramsSchemas, z.string()]
		return transportSchemas.length === 1
			? transportSchemas[0]
			: z.union(transportSchemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
	}

	const validateNamespaceParams = async (
		name: string,
		action: string,
		actionDefinition: NamespaceActionDefinition,
		params: Record<string, any>,
	) => {
		if (!actionDefinition.paramsSchema) {
			return { success: true as const, params }
		}

		const parseResult = await actionDefinition.paramsSchema.safeParseAsync(params)
		if (parseResult.success) {
			return { success: true as const, params: parseResult.data }
		}

		return {
			success: false as const,
			response: textResponse(
				JSON.stringify(
					{
						success: false,
						tool: name,
						action,
						message: `Invalid params for ${name}.${action}: ${parseResult.error.message}`,
					},
					null,
					2,
				),
			),
		}
	}

	const registerToolNamespace = (
		name: string,
		description: string,
		actions: Record<string, NamespaceActionRegistration>,
		options: ToolNamespaceRegistrationOptions = {},
	) => {
		const normalizedActions = Object.fromEntries(
			Object.entries(actions).map(([actionName, actionRegistration]) => [
				normalizeActionName(actionName),
				normalizeActionDefinition(actionRegistration),
			]),
		) as Record<string, NamespaceActionDefinition>
		const supportedActions = Object.keys(normalizedActions).sort()
		const actionParams = Object.fromEntries(
			Object.entries(normalizedActions).map(([actionName, definition]) => [
				actionName,
				describeActionParams(definition.paramsSchema),
			]),
		)
		toolNamespaceRegistry.set(name, { description, supportedActions, params: actionParams })

		const inputSchema = z
			.object({
				action: namespaceActionSchema(supportedActions).describe(`Action to execute inside tool namespace ${name}`),
				params: namespaceParamsSchema(name, supportedActions, normalizedActions, options)
					.optional()
					.describe(
						`Parameters for the selected ${name} action. Pass a JSON object with real nested values, not a JSON-encoded string. Supported actions: ${supportedActions
							.map((actionName) => `${name}.${actionName}`)
							.join(", ")}.`,
					),
			})
			.strict()

		const registerResult = rawServerRegisterTool(
			name,
			{
				description,
				inputSchema,
			},
			async ({ action, params }: { action: string; params?: unknown }) => {
				const normalizedAction = normalizeActionName(action)

				try {
					const actionDefinition = normalizedActions[normalizedAction]
					if (!actionDefinition) {
						return await runNamespaceDispatch(unsupportedNamespaceAction(name, normalizedAction, supportedActions))
					}

					const coerced = coerceNamespaceParams(params)
					if (!coerced.success) {
						return textResponse(
							JSON.stringify(
								{
									success: false,
									tool: name,
									action: normalizedAction,
									message: coerced.message,
								},
								null,
								2,
							),
						)
					}

					const validated = await validateNamespaceParams(name, normalizedAction, actionDefinition, coerced.params)
					if (!validated.success) {
						return validated.response
					}

					// Crash guards run before the engine is touched: a refused operation
					// must never reach a handler that mutates editor state.
					const crashRefusal = crashGuard({
						tool: name,
						action: normalizedAction,
						params: validated.params as Record<string, unknown>,
					})
					if (crashRefusal) {
						return textResponse(JSON.stringify(crashRefusal, null, 2))
					}

					return await safetyGuard({
						tool: name,
						action: normalizedAction,
						args: validated.params,
						callback: async () => {
							const result = await actionDefinition.handler(validated.params)
							return await runNamespaceDispatch(result)
						},
					})
				} catch (error) {
					return textResponse(
						JSON.stringify(
							{
								success: false,
								tool: name,
								action: normalizedAction,
								message: error instanceof Error ? error.message : String(error),
							},
							null,
							2,
						),
					)
				}
			},
		)
		const registered = toolHandlerRegistry.get(name)
		if (registered) {
			registered.hidden = options.hidden === true
		}
		return registerResult
	}

	return {
		directDispatch,
		pythonDispatch,
		registerPythonTool,
		registerToolNamespace,
		registerZeroArgPythonTool,
	}
}
