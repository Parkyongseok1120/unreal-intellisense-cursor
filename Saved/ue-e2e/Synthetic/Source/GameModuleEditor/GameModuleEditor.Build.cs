using UnrealBuildTool;

public class GameModuleEditor : ModuleRules
{
	public GameModuleEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
		PrivateDependencyModuleNames.AddRange(new string[] { "UnrealEd" });
	}
}
