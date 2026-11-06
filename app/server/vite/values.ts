import {
	getViteCvarDefinition,
	type ViteCvarDefinition,
	type ViteCvarReading,
} from "./cvar-catalog.js"

export const normalizeViteCvarValue = (
	name: string,
	value: unknown,
	definition: ViteCvarDefinition | undefined = getViteCvarDefinition(name),
): boolean | number => {
	if (!definition) {
		throw new Error(`Unknown Vite cvar '${name}'. Add it to the catalog before setting it.`)
	}
	if (definition.readOnly) {
		throw new Error(`Vite cvar '${name}' is read-only.`)
	}

	if (definition.kind === "bool") {
		if (typeof value === "boolean") {
			return value
		}
		if (typeof value === "number") {
			return value !== 0
		}
		throw new Error(`Vite cvar '${name}' expects a boolean value.`)
	}

	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Vite cvar '${name}' expects a numeric value.`)
	}
	if (definition.kind === "int" && !Number.isInteger(value)) {
		throw new Error(`Vite cvar '${name}' expects an integer.`)
	}
	if (definition.min !== undefined && value < definition.min) {
		throw new Error(`Vite cvar '${name}' must be at least ${definition.min}.`)
	}
	if (definition.max !== undefined && value > definition.max) {
		throw new Error(`Vite cvar '${name}' must be at most ${definition.max}.`)
	}

	return value
}

export const previousViteCvarValue = (
	definition: ViteCvarDefinition | undefined,
	reading: ViteCvarReading | undefined,
): boolean | number => {
	if (!definition) {
		return 0
	}
	if (definition.kind === "bool") {
		return reading?.bool_value === true || reading?.string_value === "1"
	}
	if (definition.kind === "int") {
		return reading?.int_value ?? 0
	}
	return reading?.float_value ?? 0
}

export const normalizeViteCvarMap = (values: Record<string, unknown>): Record<string, boolean | number> => {
	const normalized: Record<string, boolean | number> = {}
	for (const [name, value] of Object.entries(values)) {
		normalized[name] = normalizeViteCvarValue(name, value)
	}
	return normalized
}
