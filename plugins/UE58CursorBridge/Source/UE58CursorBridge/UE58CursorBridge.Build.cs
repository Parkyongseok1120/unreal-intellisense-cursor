using UnrealBuildTool;

public class UE58CursorBridge : ModuleRules
{
	public UE58CursorBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "AssetRegistry" });
	}
}
