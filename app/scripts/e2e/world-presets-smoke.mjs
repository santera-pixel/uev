import { runWorldEnvironmentGeometryScenarios } from "./world-environment-geometry-smoke.mjs"
import { runWorldLevelScenarios } from "./world-level-smoke.mjs"
import { runWorldLevelStructureScenarios } from "./world-level-structure-smoke.mjs"

export async function runWorldPresetScenarios(ctx) {
	const { options } = ctx

	const state = {
		levelPrefix: `${options.prefix}_LevelWall`,
		levelMazePrefix: `${options.prefix}_LevelMaze`,
		levelPyramidPrefix: `${options.prefix}_LevelPyramid`,
		levelBridgePrefix: `${options.prefix}_LevelBridge`,
		levelTownPrefix: `${options.prefix}_LevelTown`,
		levelStructurePrefix: `${options.prefix}_House`,
		levelStructureTownPrefix: `${options.prefix}_StructureTown`,
		levelStructureBridgePrefix: `${options.prefix}_Bridge`,
		levelStructureSuspensionBridgePrefix: `${options.prefix}_SuspensionBridge`,
		levelStructureAqueductPrefix: `${options.prefix}_Aqueduct`,
		levelStructureCastlePrefix: `${options.prefix}_CastleFortress`,
		levelStructureMansionPrefix: `${options.prefix}_Mansion`,
		levelStructureTowerPrefix: `${options.prefix}_Tower`,
		levelStructureWallPrefix: `${options.prefix}_FortWall`,
		environmentPrefix: `${options.prefix}_Arch`,
		environmentTownPrefix: `${options.prefix}_EnvTown`,
		environmentStairPrefix: `${options.prefix}_EnvStair`,
		environmentPyramidPrefix: `${options.prefix}_Pyramid`,
		environmentMazePrefix: `${options.prefix}_EnvMaze`,
		geometryPrefix: `${options.prefix}_Stairs`,
		geometryArchPrefix: `${options.prefix}_GeoArch`,
		geometryWallPrefix: `${options.prefix}_GeoWall`,
		geometryPyramidPrefix: `${options.prefix}_GeoPyramid`,
	}

	await runWorldLevelScenarios(ctx, state)
	await runWorldLevelStructureScenarios(ctx, state)
	await runWorldEnvironmentGeometryScenarios(ctx, state)
}
