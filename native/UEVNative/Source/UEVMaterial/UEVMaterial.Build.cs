using UnrealBuildTool;

public class UEVMaterial : ModuleRules
{
	public UEVMaterial(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"Json",
			"JsonUtilities",
			"RenderCore",
			"RHI",
		});
	}
}
