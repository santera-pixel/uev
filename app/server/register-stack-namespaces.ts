import { z } from "zod"

import type { RegistrationContext } from "./registration-context.js"

export function registerStackNamespaces(ctx: RegistrationContext) {
	const { directDispatch, registerToolNamespace, stackManager } = ctx

	registerToolNamespace(
		"manage_stack",
		"Bring the Unreal editor, supervisor, and control API up on demand, attach to a running editor, inspect readiness, or stop the processes this server started.",
		{
			status: {
				description: "Report the configured paths and the live editor, supervisor, control API, and remote-connection state.",
				handler: async () => directDispatch(await stackManager.status()),
			},
			config: {
				description: "Return the resolved stack configuration and where it came from.",
				handler: async () => directDispatch(stackManager.getConfig()),
			},
			ensure: {
				description:
					"Ensure the stack is ready. auto uses attach when the editor is running and launch otherwise; launch starts the supervisor and editor; attach starts the control API for an existing editor; restart stops the managed stack and launches it again.",
				paramsSchema: z
					.object({
						mode: z.enum(["auto", "attach", "launch", "restart"]).optional(),
						wait_seconds: z.number().optional(),
					})
					.strict(),
				handler: async (params) =>
					directDispatch(
						await stackManager.ensure(
							(params as { mode?: "auto" | "attach" | "launch" | "restart" }).mode ?? "auto",
							Math.max(1, Number((params as { wait_seconds?: number }).wait_seconds ?? 60)) * 1000,
						),
					),
			},
			relaunch: {
				description:
					"Close the editor (requires discard:true), optionally run UBT, relaunch the packaged supervisor/editor, and wait for readiness. Call from the stdio MCP server; a supervisor-hosted control API will be terminated with the editor.",
				paramsSchema: z
					.object({
						build: z.boolean().optional(),
						discard: z.boolean().optional(),
						wait_seconds: z.number().optional(),
					})
					.strict(),
				handler: async (params) =>
					directDispatch(
						await stackManager.relaunch({
							build: (params as { build?: boolean }).build,
							discard: (params as { discard?: boolean }).discard,
							waitMs:
								Math.max(
									1,
									Number((params as { wait_seconds?: number }).wait_seconds ?? 120),
								) * 1000,
						}),
					),
			},
			stop: {
				description: "Stop the supervisor and control API processes this server started.",
				handler: async () => directDispatch(await stackManager.stop()),
			},
		},
	)
}
