import { contentEntries } from "./tool-catalog-content-entries.js"
import { coreDirectEntries } from "./tool-catalog-core-direct-entries.js"
import { coreNamespaceEntries } from "./tool-catalog-core-namespace-entries.js"
import { editorSessionEntries } from "./tool-catalog-editor-session-entries.js"
import { gameplayEntries } from "./tool-catalog-gameplay-entries.js"
import type { ToolCatalogEntry } from "./tool-catalog-types.js"
import { worldEntries } from "./tool-catalog-world-entries.js"

export type { ToolCatalogEntry } from "./tool-catalog-types.js"

export const toolCatalogEntries: ToolCatalogEntry[] = [
	...editorSessionEntries,
	...coreDirectEntries,
	...coreNamespaceEntries,
	...worldEntries,
	...contentEntries,
	...gameplayEntries,
]
