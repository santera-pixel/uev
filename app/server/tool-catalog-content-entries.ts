import type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const contentEntries: ToolCatalogEntry[] = [
	{
		name: "manage_skeleton",
		category: "Content & Authoring Tool Namespaces",
		description: "Skeleton tool namespace for searching Skeleton and SkeletalMesh assets and inspecting their metadata.",
	},
	{
		name: "manage_material",
		category: "Content & Authoring Tool Namespaces",
		description: "Material tool namespace for listing/applying materials and tinting material instances, plus Material and MaterialFunction expression-graph authoring.",
	},
	{
		name: "manage_texture",
		category: "Content & Authoring Tool Namespaces",
		description: "Texture tool namespace for searching texture assets, importing image files as textures, and reading their asset metadata.",
	},
	{
		name: "manage_data",
		category: "Content & Authoring Tool Namespaces",
		description: "Data tool namespace for searching data assets, creating common data containers, and inspecting their asset metadata.",
	},
	{
		name: "manage_blueprint",
		category: "Content & Authoring Tool Namespaces",
		description: "Blueprint tool namespace for Blueprint creation, component editing, graph/event/function/variable authoring, typed function signatures, local variables, macro libraries, Construction Script nodes, compilation, verification, and summary actions.",
	},
	{
		name: "manage_sequence",
		category: "Content & Authoring Tool Namespaces",
		description: "Sequence tool namespace for creating, searching, inspecting, and editing LevelSequence assets, including bindings, tracks, sections, keys, camera cuts, playback ranges, and speed-track time calculations.",
	},
	{
		name: "manage_animation",
		category: "Content & Authoring Tool Namespaces",
		description: "Animation authoring namespace for AnimBlueprint AnimGraphs and state machines, AnimSequence notifies/curves/markers, and AnimMontage slots/sections/segments/notifies.",
	},
	{
		name: "manage_audio",
		category: "Content & Authoring Tool Namespaces",
		description: "Audio tool namespace for importing audio files, searching audio assets, and inspecting their asset metadata.",
	},
	{
		name: "manage_widget",
		category: "Content & Authoring Tool Namespaces",
		description: "Widget tool namespace for UMG Blueprint creation, widget-tree inspection, widget-tree edits, CanvasPanel root normalization, and viewport spawning actions. Use inspect_tree to verify designer contents, add_child_widget for nested layout work, and ensure_canvas_root when absolute CanvasPanel positioning is required.",
	},
]
