import type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const gameplayEntries: ToolCatalogEntry[] = [
	{
		name: "manage_physics",
		category: "Gameplay & Systems Tool Namespaces",
		description: "Physics tool namespace for spawning physics-enabled Blueprints, editing component physics, applying forces and impulses in PIE, setting collision profile/response and CharacterMovement properties, and running a bounded PIE drop test.",
	},
	{
		name: "manage_input",
		category: "Gameplay & Systems Tool Namespaces",
		description: "Input tool namespace for creating classic UE4 input mappings.",
	},
	{
		name: "manage_gas",
		category: "Gameplay & Systems Tool Namespaces",
		description: "GAS tool namespace for searching gameplay-ability-related assets and inspecting their asset metadata.",
	},
]
