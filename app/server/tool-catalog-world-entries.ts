import type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const worldEntries: ToolCatalogEntry[] = [
	{
		name: "manage_lighting",
		category: "World & Environment Tool Namespaces",
		description: "Lighting tool namespace for spawning common light actors, transforming them, and inspecting level lighting state.",
	},
	{
		name: "manage_volumes",
		category: "World & Environment Tool Namespaces",
		description: "Volume tool namespace for spawning common engine volumes and applying delete or transform actions.",
	},
	{
		name: "manage_navigation",
		category: "World & Environment Tool Namespaces",
		description: "Navigation tool namespace for spawning navigation volumes and proxies plus basic map inspection actions.",
	},
	{
		name: "manage_splines",
		category: "World & Environment Tool Namespaces",
		description: "Spline tool namespace for spawning a spline-host actor or Blueprint and then transforming or deleting it.",
	},
	{
		name: "manage_geometry",
		category: "World & Environment Tool Namespaces",
		description: "Geometry tool namespace for all preset builders: wall, maze, pyramid, bridge, town, house, mansion, tower, suspension bridge, aqueduct, castle fortress, arch, and staircase.",
	},
	{
		name: "manage_effect",
		category: "World & Environment Tool Namespaces",
		description: "Effects tool namespace for spawning debug-shape actors, assigning materials, tinting them, and deleting them.",
	},
]
