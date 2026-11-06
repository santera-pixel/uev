import { AsyncLocalStorage } from "node:async_hooks"

import type { ActionMode, SafetyProfile } from "./types.js"

export interface HistoryMetadata {
	undo: "native" | "semantic" | "none"
	inverse?: Record<string, unknown>
	forward?: Record<string, unknown>
}

export interface CallContext {
	tool: string
	action?: string
	mode: ActionMode
	profile: SafetyProfile
	allowRetry: boolean
	callId: string
	transactional: boolean
	transactionLabel?: string
	history?: HistoryMetadata
}

const storage = new AsyncLocalStorage<CallContext>()

export const runWithCallContext = <T>(context: CallContext, callback: () => T): T =>
	storage.run(context, callback)

export const getCallContext = (): CallContext | undefined => storage.getStore()
