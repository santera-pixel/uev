export const productVersion = "1.7.0"
export const serverVersion = "2026.11.6-1"
export const protocolVersion = 2

export const engineCompatibility = {
	minVersion: "4.27.0",
	maxVersionExclusive: "4.28.0",
	strictEnvVar: "UEV_STRICT_ENGINE",
	testedBuilds: ["4.27.2-vite-2026.10"],
} as const

// Kept for existing imports: MCP clients display the server build identity.
export const projectVersion = serverVersion
