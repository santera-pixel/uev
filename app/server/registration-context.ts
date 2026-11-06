import { z } from "zod"

import { evaluateRequestGuards } from "./crash-guards.js"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as editorTools from "./editor/tools.js"
import {
	createPluginRegistry,
	loadPluginManifest,
	type PluginProbeResult,
	type PluginRegistry,
} from "./plugins/plugin-registry.js"
import { setAutoLaunchHandler, tryRunCommand } from "./remote-execution.js"
import { createSafetyGateway, loadSafetyConfig, type SafetyGateway } from "./safety/index.js"
import { StackManager } from "./stack-manager.js"
import type { SafetyConfig } from "./safety/types.js"
import {
	createDispatchHelpers,
	NamespaceActionRegistration,
	NamespaceDispatchResult,
	type ToolHandlerRegistry,
} from "./registration-context-dispatch.js"
import { createRegistrationParamHelpers } from "./registration-context-params.js"
import {
	colorInputSchema,
	recordSchema,
	rotatorInputSchema,
	stringListSchema,
	toColorArray,
	toColorRecord,
	toRotatorArray,
	toRotatorRecord,
	toVector2Array,
	toVector2Record,
	toVector3Array,
	toVector3Record,
	vector2InputSchema,
	vector3InputSchema,
	worldBuildBaseSchema,
} from "./registration-context-schemas.js"
import { toolDescription } from "./tool-catalog.js"

export interface RegistrationContext {
	actorNameParam: (params: Record<string, any>) => string
	assetPathListParam: (params: Record<string, any>) => string | string[] | undefined
	blueprintNameParam: (params: Record<string, any>) => string
	colorInputSchema: z.ZodTypeAny
	directDispatch: (payload: unknown) => NamespaceDispatchResult
	editorTools: typeof editorTools
	optionalStringListParam: (params: Record<string, any>, keys: string[]) => string[] | undefined
	optionalStringParam: (params: Record<string, any>, keys: string[]) => string | undefined
	pluginRegistry: import("./plugins/plugin-registry.js").PluginRegistry
	pythonDispatch: (command: string) => NamespaceDispatchResult
	rawServerTool: (...args: any[]) => unknown
	recordSchema: z.ZodRecord<z.ZodString, z.ZodAny>
	registerPythonTool: (
		name: string,
		description: string,
		schema: Record<string, z.ZodTypeAny>,
		buildCommand: (args: any) => string,
	) => void
	registerToolNamespace: (
		name: string,
		description: string,
		actions: Record<string, NamespaceActionRegistration>,
		options?: { compactParamsSchema?: boolean; hidden?: boolean },
	) => void
	registerZeroArgPythonTool: (name: string, description: string, buildCommand: () => string) => void
	safety: ReturnType<typeof createSafetyGateway>
	requiredStringListParam: (params: Record<string, any>, keys: string[]) => string[]
	requiredStringParam: (params: Record<string, any>, keys: string[]) => string
	searchAssetsCommand: (params: Record<string, any>, defaultAssetClass?: string) => string
	sourceControlFileListParam: (params: Record<string, any>) => string[]
	sourceControlFileParam: (params: Record<string, any>) => string
	sourceControlFilesCommand: (files: string[], singleOperation?: string, multiOperation?: string) => string
	sourceControlPackageListParam: (params: Record<string, any>) => string[]
	stackManager: StackManager
	stringListSchema: z.ZodArray<z.ZodString, "many">
	textResponse: (text: string) => { content: Array<{ type: "text"; text: string }> }
	toolDescription: (name: string) => string
	toolHandlerRegistry: ToolHandlerRegistry
	toolNamespaceRegistry: Map<
		string,
		{
			description: string
			supportedActions: string[]
			params: Record<string, import("./registration-context-dispatch.js").NamespaceActionParam[]>
		}
	>
	toColorArray: (value?: unknown) => number[] | undefined
	toColorRecord: (value?: unknown) => { a: number; b: number; g: number; r: number } | undefined
	toRotatorArray: (value?: unknown) => number[] | undefined
	toRotatorRecord: (value?: unknown) => { pitch: number; roll: number; yaw: number } | undefined
	toVector2Array: (value?: unknown) => number[] | undefined
	toVector2Record: (value?: unknown) => { x: number; y: number } | undefined
	toVector3Array: (value?: unknown) => number[] | undefined
	toVector3Record: (value?: unknown) => { x: number; y: number; z: number } | undefined
	vector2InputSchema: z.ZodTypeAny
	vector3InputSchema: z.ZodTypeAny
	rotatorInputSchema: z.ZodTypeAny
	worldBuildBaseSchema: {
		location: z.ZodTypeAny
		material_path: z.ZodTypeAny
		prefix: z.ZodTypeAny
	}
	worldBuildCommand: (operation: string, params: Record<string, any>) => string
	widgetBlueprintParam: (params: Record<string, any>) => string
}

let activeSafetyGateway: ReturnType<typeof createSafetyGateway> | undefined

export const shutdownSafety = () => {
	activeSafetyGateway?.close()
	activeSafetyGateway = undefined
}

export interface RegistrationRuntime {
	safetyConfig: SafetyConfig
	pluginRegistry: PluginRegistry
	safety: SafetyGateway
	stackManager: StackManager
}

const parsePythonJson = (text: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				return undefined
			}
		}
		return undefined
	}
}

export function createRegistrationRuntime(): RegistrationRuntime {
	const safetyConfig = loadSafetyConfig()
	const pluginRegistry = createPluginRegistry({
		manifest: loadPluginManifest(),
		probe: async (probes, modules) => {
			const text = await tryRunCommand(editorTools.UEPluginStatus(probes, modules))
			const parsed = parsePythonJson(text)
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Unexpected plugin status response: ${text.slice(0, 200)}`)
			}
			return parsed as PluginProbeResult
		},
	})
	const safety = createSafetyGateway({ ...safetyConfig, pluginRegistry })
	activeSafetyGateway = safety
	const stackManager = new StackManager()
	if (stackManager.getConfig().autoLaunch) {
		setAutoLaunchHandler(() => stackManager.ensure("auto"))
	}
	console.error(
		`UEV safety: profile=${safetyConfig.profile}${safetyConfig.readOnly ? " (read-only)" : ""}; allowlist v${safetyConfig.allowlist.version}; audit=${safetyConfig.auditPath}`,
	)
	return { safetyConfig, pluginRegistry, safety, stackManager }
}

export function createRegistrationContext(
	server: McpServer,
	runtime: RegistrationRuntime = createRegistrationRuntime(),
): RegistrationContext {
	const { pluginRegistry, safety, stackManager } = runtime
	activeSafetyGateway = safety

	const toolHandlerRegistry: ToolHandlerRegistry = new Map()
	const registerToolBase = server.registerTool.bind(server) as (
		name: string,
		config: Record<string, unknown>,
		cb: (...args: any[]) => unknown,
	) => unknown
	const rawServerRegisterTool = ((name: string, config: Record<string, unknown>, cb: (...args: any[]) => unknown) => {
		const toolName = String(name)
		toolHandlerRegistry.set(toolName, {
			name: toolName,
			description: typeof config.description === "string" ? config.description : "",
			inputSchema: config.inputSchema,
			kind: "namespace",
			handler: cb,
		})
		return registerToolBase(name, config, cb)
	}) as (
		name: string,
		config: Record<string, unknown>,
		cb: (...args: any[]) => unknown,
	) => unknown
	const rawServerToolBase = server.tool.bind(server) as (...args: any[]) => unknown
	const rawServerTool = ((...args: any[]) => {
		const callbackIndex = args.length - 1
		const callback = args[callbackIndex]
		if (typeof callback !== "function") {
			return rawServerToolBase(...args)
		}

		const toolName = String(args[0])
		const guardedCallback = (...callbackArgs: any[]) =>
			safety.guard({
				tool: toolName,
				args: callbackArgs[0],
				callback: () => callback(...callbackArgs),
			})

		toolHandlerRegistry.set(toolName, {
			name: toolName,
			description: typeof args[1] === "string" ? args[1] : "",
			inputSchema: args.length >= 4 ? args[2] : undefined,
			kind: "direct",
			handler: guardedCallback,
		})

		const nextArgs = [...args]
		nextArgs[callbackIndex] = guardedCallback
		return rawServerToolBase(...nextArgs)
	}) as (...args: any[]) => unknown

	const textResponse = (text: string) => ({
		content: [{ type: "text" as const, text }],
	})

	const toolNamespaceRegistry = new Map<
		string,
		{
			description: string
			supportedActions: string[]
			params: Record<string, import("./registration-context-dispatch.js").NamespaceActionParam[]>
		}
	>()
	const dispatchHelpers = createDispatchHelpers({
		rawServerRegisterTool,
		rawServerTool,
		recordSchema,
		safetyGuard: safety.guard,
		crashGuard: evaluateRequestGuards,
		textResponse,
		toolHandlerRegistry,
		toolNamespaceRegistry,
	})
	const paramHelpers = createRegistrationParamHelpers(editorTools)

	const worldBuildCommand = (operation: string, params: Record<string, any>) =>
		editorTools.UEWorldBuildingTool(operation, {
			...params,
			location: toVector3Array(params.location),
		})

	return {
		colorInputSchema,
		editorTools,
		pluginRegistry,
		rawServerTool,
		recordSchema,
		safety,
		stackManager,
		stringListSchema,
		textResponse,
		toolDescription,
		toolHandlerRegistry,
		toolNamespaceRegistry,
		toColorArray,
		toColorRecord,
		toRotatorArray,
		toRotatorRecord,
		toVector2Array,
		toVector2Record,
		toVector3Array,
		toVector3Record,
		vector2InputSchema,
		vector3InputSchema,
		rotatorInputSchema,
		worldBuildBaseSchema,
		worldBuildCommand,
		...dispatchHelpers,
		...paramHelpers,
	}
}
