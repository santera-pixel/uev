using UnrealBuildTool;

public class UEVControlPanel : ModuleRules
{
	public UEVControlPanel(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
				"InputCore"
			}
		);

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"Slate",
				"SlateCore",
				"UnrealEd",
				"LevelEditor",
				"EditorStyle",
				"HTTP",
				"Json",
				"JsonUtilities",
				"ApplicationCore",
				"DeveloperSettings",
				"WorkspaceMenuStructure"
			}
		);
	}
}
