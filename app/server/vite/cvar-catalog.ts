export type ViteCvarKind = "bool" | "int" | "float" | "string"

export interface ViteCvarDefinition {
	name: string
	group: string
	kind: ViteCvarKind
	description: string
	defaultValue?: string | number | boolean
	safeRange?: string
	min?: number
	max?: number
	requires?: string
	compiledOutByDefault?: boolean
	readOnly?: boolean
	source?: string
	notes?: string
}

export interface ViteCompileSwitchDefinition {
	name: string
	description: string
	probeCvars?: string[]
	notes?: string
}

export interface ViteCvarReading {
	available?: boolean
	string_value?: string
	float_value?: number
	int_value?: number
	bool_value?: boolean
	error?: string
}

const VITE_DOCS = "https://vitestudio-tech.github.io/UnrealEngineVite-Docs/console-variables.html"

export const viteCvarCatalog: ViteCvarDefinition[] = [
	{
		name: "r.Vite.SMAA.Mode",
		group: "Anti-Aliasing",
		kind: "int",
		description: "Vite SMAA mode. 0 disables the effect; higher values select the configured SMAA mode.",
		safeRange: "0-3",
		min: 0,
		max: 3,
		source: VITE_DOCS,
		notes: "Not registered in the current Vite build; availability depends on SMAA being compiled in.",
	},
	{
		name: "r.AntiAliasing.SMAA.Debug",
		group: "Anti-Aliasing",
		kind: "bool",
		description: "Shows the SMAA debug visualization.",
		source: VITE_DOCS,
	},
	{
		name: "r.Vite.SSAO",
		group: "Ambient Occlusion",
		kind: "bool",
		description: "Enables Vite screen-space ambient occlusion.",
		source: VITE_DOCS,
	},
	{
		name: "r.HBAO.Enable",
		group: "Ambient Occlusion",
		kind: "bool",
		description: "Enables HBAO ambient occlusion.",
		source: VITE_DOCS,
	},
	{
		name: "r.RayTracing",
		group: "Ray Tracing",
		kind: "bool",
		description: "Master ray tracing toggle for the Vite renderer.",
		source: VITE_DOCS,
	},
	{
		name: "r.RayTracing.Reflections",
		group: "Ray Tracing",
		kind: "bool",
		description: "Enables ray-traced reflections.",
		source: VITE_DOCS,
	},
	{
		name: "r.RayTracing.Shadows",
		group: "Ray Tracing",
		kind: "bool",
		description: "Enables ray-traced shadows.",
		source: VITE_DOCS,
	},
	{
		name: "r.RayTracing.AmbientOcclusion",
		group: "Ray Tracing",
		kind: "bool",
		description: "Enables ray-traced ambient occlusion.",
		source: VITE_DOCS,
	},
	{
		name: "r.RayTracing.GlobalIllumination",
		group: "Ray Tracing",
		kind: "bool",
		description: "Ray-traced global illumination.",
		compiledOutByDefault: true,
		source: VITE_DOCS,
		notes: "Compiled out by default in Vite. Setting it has no effect unless the feature is enabled in the build.",
	},
	{
		name: "r.RayTracing.Translucency",
		group: "Ray Tracing",
		kind: "bool",
		description: "Ray-traced translucency.",
		compiledOutByDefault: true,
		source: VITE_DOCS,
		notes: "Compiled out by default in Vite. Setting it has no effect unless the feature is enabled in the build.",
	},
	{
		name: "r.RayTracing.SampledDirectLighting",
		group: "Ray Tracing",
		kind: "bool",
		description: "Ray-traced sampled direct lighting.",
		compiledOutByDefault: true,
		source: VITE_DOCS,
		notes: "Compiled out by default in Vite. Setting it has no effect unless the feature is enabled in the build.",
	},
	{
		name: "r.RTXGI.DDGI",
		group: "DDGI",
		kind: "int",
		description: "Enables NVIDIA RTXGI DDGI in the Vite renderer.",
		safeRange: "0-1",
		min: 0,
		max: 1,
		source: VITE_DOCS,
	},
	{
		name: "r.RTXGI.DDGI.StatVolume",
		group: "DDGI",
		kind: "int",
		description: "DDGI per-volume statistics selector. Read-only diagnostic value.",
		readOnly: true,
		source: VITE_DOCS,
	},
	{
		name: "r.RTXGI.MemoryUsed",
		group: "DDGI",
		kind: "int",
		description: "DDGI memory usage diagnostic value.",
		readOnly: true,
		source: VITE_DOCS,
		notes: "Not registered in the current RTXGI build; availability depends on the RTXGI version.",
	},
	{
		name: "r.TessellationAdaptivePixelsPerTriangle",
		group: "Geometry",
		kind: "float",
		description: "Adaptive tessellation density. Lower values produce more triangles.",
		safeRange: "0-256",
		min: 0,
		max: 256,
		source: VITE_DOCS,
	},
	{
		name: "r.VolumetricFog",
		group: "Volumetrics",
		kind: "bool",
		description: "Enables volumetric fog.",
		source: VITE_DOCS,
	},
	{
		name: "r.VolumetricFog.UseUpScaledSizeVolumetricFog",
		group: "Volumetrics",
		kind: "bool",
		description: "Uses the upscaled render size for volumetric fog.",
		requires: "VITE_DLSS_PATCH",
		source: VITE_DOCS,
		notes: "Only compiled when the Vite DLSS patch is enabled.",
	},
	{
		name: "r.ScreenPercentage",
		group: "Performance",
		kind: "float",
		description: "Primary screen percentage used by the renderer.",
		safeRange: "10-200",
		min: 10,
		max: 200,
		source: VITE_DOCS,
	},
]

export const viteCompileSwitches: ViteCompileSwitchDefinition[] = [
	{
		name: "VITE_DLSS_PATCH",
		description: "Enables the Vite DLSS/Streamline patch and related rendering cvars.",
		probeCvars: ["r.VolumetricFog.UseUpScaledSizeVolumetricFog"],
		notes: "The probe cvar is only available when the patch is compiled in.",
	},
	{
		name: "VITE_PHYSX_FIXED_TIMESTEP",
		description: "Enables the p.VitePhysXFixedTimestep.* cvars.",
		notes: "Build-only switch. Verify the build flag if any p.VitePhysXFixedTimestep.* cvars are configured.",
	},
]

export const viteCatalogByName = new Map(
	viteCvarCatalog.map((definition) => [definition.name.toLowerCase(), definition]),
)

export const renderStateCvarNames = [
	"r.ScreenPercentage",
	"r.RTXGI.DDGI",
	"r.RTXGI.MemoryUsed",
	"r.RayTracing",
	"r.RayTracing.Reflections",
	"r.RayTracing.Shadows",
	"r.RayTracing.AmbientOcclusion",
	"r.HBAO.Enable",
	"r.Vite.SMAA.Mode",
	"r.Vite.SSAO",
	"r.TessellationAdaptivePixelsPerTriangle",
	"r.VolumetricFog",
	"r.VolumetricFog.UseUpScaledSizeVolumetricFog",
]

export const getViteCvarDefinition = (name: string): ViteCvarDefinition | undefined =>
	viteCatalogByName.get(name.trim().toLowerCase())

export const parseViteCvarValue = (
	definition: ViteCvarDefinition | undefined,
	reading: ViteCvarReading | undefined,
): string | number | boolean | undefined => {
	if (!definition || !reading?.available) {
		return undefined
	}

	switch (definition.kind) {
		case "bool":
			return Boolean(reading.bool_value) || /^(1|true|yes|on)$/i.test(reading.string_value ?? "")
		case "int":
			return Number.isFinite(reading.int_value) ? reading.int_value : Number(reading.string_value)
		case "float":
			return Number.isFinite(reading.float_value) ? reading.float_value : Number(reading.string_value)
		default:
			return reading.string_value
	}
}

export const buildCompileSwitchStatus = (
	switchDefinitions: ViteCompileSwitchDefinition[],
	availability: Record<string, ViteCvarReading>,
): Record<string, boolean | undefined> => {
	const result: Record<string, boolean | undefined> = {}
	for (const switchDefinition of switchDefinitions) {
		if (!switchDefinition.probeCvars || switchDefinition.probeCvars.length === 0) {
			result[switchDefinition.name] = undefined
			continue
		}
		result[switchDefinition.name] = switchDefinition.probeCvars.every(
			(name) => availability[name]?.available === true,
		)
	}
	return result
}
