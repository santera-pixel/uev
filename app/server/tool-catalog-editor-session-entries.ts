import type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const editorSessionEntries: ToolCatalogEntry[] = [
	{
		name: "get_unreal_engine_path",
		category: "Editor Session Info",
		description: "Get the active Unreal Engine root path from the connected editor session",
	},
	{
		name: "get_unreal_project_path",
		category: "Editor Session Info",
		description: "Get the active Unreal project file path from the connected editor session",
	},
]
