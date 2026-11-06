#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"

const repoRoot = process.cwd()
const packageJsonPath = path.join(repoRoot, "package.json")
const packageLockPath = path.join(repoRoot, "package-lock.json")
const serverVersionPath = path.join(repoRoot, "server", "version.ts")
const serverMetadataPath = path.join(repoRoot, "server.json")

const requestedVersion = process.argv[2]

if (!requestedVersion) {
	console.error("Usage: node scripts/set-version.mjs <YYYY.M.D-N>")
	process.exit(1)
}

function normalizeVersion(version) {
	const semverPattern = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d+)$/
	const legacyPattern = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/
	const semverMatch = version.match(semverPattern)
	if (semverMatch) {
		const [, year, month, day, count] = semverMatch
		return `${Number(year)}.${Number(month)}.${Number(day)}-${Number(count)}`
	}
	const legacyMatch = version.match(legacyPattern)
	if (legacyMatch) {
		const [, year, month, day, count] = legacyMatch
		return `${Number(year)}.${Number(month)}.${Number(day)}-${Number(count)}`
	}
	return null
}

const nextVersion = normalizeVersion(requestedVersion)

if (!nextVersion) {
	console.error(`Invalid version format: ${requestedVersion}`)
	console.error("Expected format: YYYY.M.D-N")
	console.error("Legacy input format YYYY.MM.DD.N is also accepted and normalized.")
	process.exit(1)
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
packageJson.version = nextVersion
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

if (fs.existsSync(packageLockPath)) {
	const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"))
	packageLock.version = nextVersion
	if (packageLock.packages?.[""]) {
		packageLock.packages[""].version = nextVersion
	}
	fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`)
}

const serverVersionSource = `export const projectVersion = "${nextVersion}"\n`
fs.writeFileSync(serverVersionPath, serverVersionSource)

if (fs.existsSync(serverMetadataPath)) {
	const serverMetadata = JSON.parse(fs.readFileSync(serverMetadataPath, "utf8"))
	serverMetadata.version = nextVersion
	if (Array.isArray(serverMetadata.packages)) {
		for (const pkg of serverMetadata.packages) {
			if (pkg && typeof pkg === "object") {
				pkg.version = nextVersion
			}
		}
	}
	fs.writeFileSync(serverMetadataPath, `${JSON.stringify(serverMetadata, null, 2)}\n`)
}

console.log(`Updated project version to ${nextVersion}`)
