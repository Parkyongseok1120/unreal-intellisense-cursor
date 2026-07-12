using UnrealBuildTool;

public class SyntheticServerTarget : TargetRules
{
	public SyntheticServerTarget(TargetInfo Target) : base(Target)
	{
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		Type = TargetType.Server;
		ExtraModuleNames.Add("Synthetic");
	}
}
