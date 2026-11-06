import { editorPreludes } from "./prelude-loader.js"
import { jsonArg as encodeJsonArg, renderEditorScript } from "./script-renderer.js"

export { editorPreludes }

export const jsonArg = encodeJsonArg

export function renderScript(
	filePath: string,
	vars: Record<string, string>,
	extraPrelude = "",
) {
	return renderEditorScript(filePath, vars, { extraPrelude })
}
