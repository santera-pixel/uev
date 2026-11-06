import type { SafetyLimits } from "./types.js"

export type ValidationResult = { ok: true } | { ok: false; code: string; message: string }

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
const PATH_KEY_PATTERN = /(^|_)(path|paths|file|files|package|packages|folder|directory|directories)$/i

const hasPathTraversal = (value: string): boolean => value.split(/[\\/]+/).includes("..")

export const validateToolArgs = (args: unknown, limits: SafetyLimits): ValidationResult => {
	let serialized: string
	try {
		serialized = JSON.stringify(args ?? {})
	} catch {
		return { ok: false, code: "safety.invalid_args", message: "Arguments are not JSON-serializable." }
	}

	if (Buffer.byteLength(serialized, "utf8") > limits.maxArgsBytes) {
		return {
			ok: false,
			code: "safety.invalid_args",
			message: `Arguments exceed the ${limits.maxArgsBytes} byte limit.`,
		}
	}

	let nodes = 0

	const walk = (value: unknown, depth: number, key?: string): ValidationResult => {
		nodes += 1
		if (nodes > limits.maxNodes) {
			return { ok: false, code: "safety.invalid_args", message: "Arguments contain too many values." }
		}

		if (depth > limits.maxDepth) {
			return { ok: false, code: "safety.invalid_args", message: "Arguments are nested too deeply." }
		}

		if (typeof value === "string") {
			if (value.length > limits.maxStringLength) {
				return {
					ok: false,
					code: "safety.invalid_args",
					message: `A string argument exceeds the ${limits.maxStringLength} character limit.`,
				}
			}

			if (key && PATH_KEY_PATTERN.test(key)) {
				if (value.includes("\0")) {
					return { ok: false, code: "safety.invalid_args", message: "A path argument contains a null byte." }
				}

				if (value.startsWith("\\\\") || value.startsWith("//")) {
					return { ok: false, code: "safety.invalid_args", message: "UNC-style paths are not allowed." }
				}

				if (hasPathTraversal(value)) {
					return { ok: false, code: "safety.invalid_args", message: "Path traversal is not allowed." }
				}
			}

			return { ok: true }
		}

		if (Array.isArray(value)) {
			if (value.length > limits.maxArrayLength) {
				return {
					ok: false,
					code: "safety.invalid_args",
					message: `An array argument exceeds the ${limits.maxArrayLength} item limit.`,
				}
			}

			for (const item of value) {
				const result = walk(item, depth + 1, key)
				if (!result.ok) {
					return result
				}
			}

			return { ok: true }
		}

		if (value && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>)
			if (entries.length > limits.maxObjectKeys) {
				return {
					ok: false,
					code: "safety.invalid_args",
					message: `An object argument exceeds the ${limits.maxObjectKeys} key limit.`,
				}
			}

			for (const [childKey, childValue] of entries) {
				if (FORBIDDEN_KEYS.has(childKey)) {
					return { ok: false, code: "safety.invalid_args", message: "Forbidden object key in arguments." }
				}

				const result = walk(childValue, depth + 1, childKey)
				if (!result.ok) {
					return result
				}
			}
		}

		return { ok: true }
	}

	return walk(args ?? {}, 0)
}
