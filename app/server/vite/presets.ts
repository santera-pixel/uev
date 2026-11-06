export interface VitePreset {
	name: string
	description: string
	values: Record<string, string | number | boolean>
}

export const vitePresets: VitePreset[] = [
	{
		name: "performance",
		description: "Disables ray tracing and DDGI, lowers screen percentage, and disables volumetrics.",
		values: {
			"r.RTXGI.DDGI": 0,
			"r.RayTracing": 0,
			"r.HBAO.Enable": 0,
			"r.Vite.SMAA.Mode": 0,
			"r.ScreenPercentage": 70,
			"r.VolumetricFog": 0,
		},
	},
	{
		name: "balanced",
		description: "Keeps DDGI and ray-traced shadows/AO, disables reflections and HBAO, and keeps volumetrics.",
		values: {
			"r.RTXGI.DDGI": 1,
			"r.RayTracing": 1,
			"r.RayTracing.Reflections": 0,
			"r.RayTracing.Shadows": 1,
			"r.RayTracing.AmbientOcclusion": 1,
			"r.HBAO.Enable": 0,
			"r.Vite.SMAA.Mode": 1,
			"r.ScreenPercentage": 100,
			"r.VolumetricFog": 1,
		},
	},
	{
		name: "quality",
		description: "Enables DDGI, ray-traced reflections/shadows/AO, HBAO, SMAA, and volumetrics at full screen percentage.",
		values: {
			"r.RTXGI.DDGI": 1,
			"r.RayTracing": 1,
			"r.RayTracing.Reflections": 1,
			"r.RayTracing.Shadows": 1,
			"r.RayTracing.AmbientOcclusion": 1,
			"r.HBAO.Enable": 1,
			"r.Vite.SMAA.Mode": 1,
			"r.ScreenPercentage": 100,
			"r.VolumetricFog": 1,
		},
	},
]

export const getVitePreset = (name: string): VitePreset | undefined =>
	vitePresets.find((preset) => preset.name === name.trim())
