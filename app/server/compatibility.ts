import { engineCompatibility } from "./version.js"
import { envFlag } from "./identity.js"

export interface EngineIdentity {
	version?: string
	build?: string
	compatible: boolean
	strict: boolean
	reason?: string
}

const parseVersion = (value: string): number[] => {
	const match = value.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
	return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : []
}

const compareVersion = (left: number[], right: number[]): number => {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0)
		if (delta !== 0) {
			return delta
		}
	}
	return 0
}

export const engineIdentity = (version?: string, build?: string): EngineIdentity => {
	const strict = envFlag("STRICT_ENGINE")
	const parsed = version ? parseVersion(version) : []
	if (parsed.length === 0) {
		return {
			version,
			build,
			compatible: !strict,
			strict,
			reason: "Engine version is unknown; dispatch is allowed unless strict mode is enabled.",
		}
	}

	const min = parseVersion(engineCompatibility.minVersion)
	const max = parseVersion(engineCompatibility.maxVersionExclusive)
	const aboveMin = compareVersion(parsed, min) >= 0
	const belowMax = compareVersion(parsed, max) < 0
	if (!aboveMin || !belowMax) {
		return {
			version,
			build,
			compatible: false,
			strict,
			reason: `Unsupported engine ${version}; supported range is >=${engineCompatibility.minVersion} <${engineCompatibility.maxVersionExclusive}.`,
		}
	}

	const tested = Boolean(build && (engineCompatibility.testedBuilds as readonly string[]).includes(build))
	return {
		version,
		build,
		compatible: true,
		strict,
		reason: tested ? undefined : "This 4.27 build is not in the tested matrix; compatibility is best-effort.",
	}
}
