import { editorPreludes, jsonArg, renderScript } from "./tools-base.js"

export const UESubstrateTool = (operation: string, args: Record<string, unknown> = {}) =>
	renderScript(
		"./scripts/ue_substrate_tools.py",
		{
			operation: jsonArg(operation),
			args: jsonArg(args),
		},
		editorPreludes.substrate,
	)
