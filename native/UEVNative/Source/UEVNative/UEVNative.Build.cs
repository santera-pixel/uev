using UnrealBuildTool;

public class UEVNative : ModuleRules
{
	public UEVNative(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"Json",
			"Projects",
			"UnrealEd",
		});
	}
}
