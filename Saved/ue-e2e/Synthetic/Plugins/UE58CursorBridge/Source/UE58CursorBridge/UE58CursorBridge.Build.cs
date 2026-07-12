using UnrealBuildTool;

public class UE58CursorBridge : ModuleRules
{
	public UE58CursorBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "Json", "JsonUtilities" });
		PrivateDependencyModuleNames.AddRange(new string[] { "AssetRegistry", "AutomationController", "HTTPServer" });
	}
}
