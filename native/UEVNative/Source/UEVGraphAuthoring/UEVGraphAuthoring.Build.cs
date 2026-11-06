using UnrealBuildTool;

public class UEVGraphAuthoring : ModuleRules
{
	public UEVGraphAuthoring(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"AIGraph",
			"AIModule",
			"Json",
			"JsonUtilities",
			"UnrealEd",
			"BlueprintGraph",
			"Kismet",
			"MaterialEditor",
			"UMG",
			"UMGEditor",
			"AnimGraph",
			"AnimGraphRuntime",
			"AnimationModifiers",
			"AssetTools",
			"AssetRegistry",
			"MovieScene",
			"Slate",
			"SlateCore",
			"RenderCore",
		});
	}
}
