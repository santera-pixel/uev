import { randomUUID } from "node:crypto"
import net from "node:net"

export interface SupervisorCallStart {
	id: string
	tool: string
	action?: string
	timeoutMs: number
}

export interface SupervisorClientStatus {
	enabled: boolean
	connected: boolean
	pipePath: string
}

export interface SupervisorClient {
	notifyCallStart: (call: SupervisorCallStart) => void
	notifyCallEnd: (id: string) => void
	panic: (reason: string) => void
	requestStatus: (timeoutMs?: number) => Promise<Record<string, unknown>>
	getLastStatus: () => Record<string, unknown> | undefined
	getStatus: () => SupervisorClientStatus
	close: () => void
}

export interface SupervisorClientOptions {
	/** The single supervisor pipe this client connects to. */
	pipePath: string
	log?: (message: string) => void
}

export const createSupervisorClient = (options: SupervisorClientOptions): SupervisorClient => {
	const log = options.log ?? ((message: string) => console.error(`UEV supervisor: ${message}`))
	let socket: net.Socket | undefined
	let connected = false
	let closed = false
	let retryTimer: ReturnType<typeof setTimeout> | undefined
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined
	let retryDelayMs = 1000
	let warned = false
	let receiveBuffer = ""
	let lastStatus: Record<string, unknown> | undefined
	const pendingStatus = new Map<string, { resolve: (value: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>()
	const pipePath = options.pipePath

	const clearHeartbeat = () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer)
			heartbeatTimer = undefined
		}
	}

	const failPendingStatus = (message: string) => {
		for (const [requestId, request] of pendingStatus) {
			clearTimeout(request.timer)
			request.resolve({ connected: false, message })
			pendingStatus.delete(requestId)
		}
	}

	const settleStatus = (message: Record<string, unknown>) => {
		const requestId = typeof message.requestId === "string" ? message.requestId : undefined
		if (!requestId) {
			return
		}

		const request = pendingStatus.get(requestId)
		if (!request) {
			return
		}

		pendingStatus.delete(requestId)
		clearTimeout(request.timer)
		request.resolve(message)
	}

	const scheduleReconnect = () => {
		if (closed || retryTimer) {
			return
		}

		retryTimer = setTimeout(() => {
			retryTimer = undefined
			connect()
			retryDelayMs = Math.min(retryDelayMs * 2, 15000)
		}, retryDelayMs)
		retryTimer.unref?.()
	}

	const connect = () => {
		if (closed || !pipePath) {
			return
		}

		receiveBuffer = ""
		const nextSocket = net.createConnection(pipePath)
		nextSocket.setNoDelay(true)
		nextSocket.unref()

		nextSocket.on("connect", () => {
			socket = nextSocket
			connected = true
			retryDelayMs = 1000
			warned = false
			log(`connected to ${pipePath}`)
			clearHeartbeat()
			heartbeatTimer = setInterval(() => {
				if (socket?.writable) {
					socket.write(`${JSON.stringify({ type: "heartbeat" })}\n`)
				}
			}, 5000)
			heartbeatTimer.unref?.()
		})

		nextSocket.on("data", (chunk) => {
			receiveBuffer += chunk.toString("utf8")
			const lines = receiveBuffer.split(/\r?\n/)
			receiveBuffer = lines.pop() ?? ""
			for (const line of lines) {
				if (!line.trim()) {
					continue
				}
				try {
					const message = JSON.parse(line) as Record<string, unknown>
					if (!message || typeof message !== "object") {
						continue
					}
					if (
						message.editorPid !== undefined ||
						message.killed !== undefined ||
						message.activeCalls !== undefined
					) {
						lastStatus = message
					}
					settleStatus(message)
				} catch {
					// Ignore malformed supervisor responses; the hard-kill path does not depend on them.
				}
			}
		})

		nextSocket.on("error", (error) => {
			if (!warned) {
				log(`not available (${error.message}); hard kill disabled until it connects`)
				warned = true
			}

			connected = false
			if (socket === nextSocket) {
				socket = undefined
			}
			failPendingStatus(`Supervisor connection failed: ${error.message}`)
			nextSocket.destroy()
			scheduleReconnect()
		})

		nextSocket.on("close", () => {
			connected = false
			if (socket === nextSocket) {
				socket = undefined
			}
			clearHeartbeat()
			failPendingStatus("Supervisor connection closed.")
			scheduleReconnect()
		})
	}

	const send = (message: Record<string, unknown>) => {
		if (socket?.writable) {
			socket.write(`${JSON.stringify(message)}\n`)
		}
	}

	connect()

	return {
		notifyCallStart: ({ id, tool, action, timeoutMs }) =>
			send({ type: "call_start", id, tool, action, timeoutMs }),
		notifyCallEnd: (id) => send({ type: "call_end", id }),
		panic: (reason) => send({ type: "panic", reason }),
		requestStatus: (timeoutMs = 2000) => {
			if (!connected || !socket?.writable) {
				return Promise.resolve(lastStatus ?? { connected: false, message: "Supervisor is not connected." })
			}

			const requestId = randomUUID()
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					pendingStatus.delete(requestId)
					resolve(lastStatus ?? { connected: false, message: "Supervisor status request timed out." })
				}, timeoutMs)
				timer.unref?.()
				pendingStatus.set(requestId, { resolve, timer })
				send({ type: "status", requestId })
			})
		},
		getLastStatus: () => lastStatus,
		getStatus: () => ({ enabled: !closed, connected, pipePath }),
		close: () => {
			closed = true
			if (retryTimer) {
				clearTimeout(retryTimer)
				retryTimer = undefined
			}
			clearHeartbeat()
			failPendingStatus("Supervisor client closed.")
			socket?.destroy()
			socket = undefined
			connected = false
		},
	}
}
