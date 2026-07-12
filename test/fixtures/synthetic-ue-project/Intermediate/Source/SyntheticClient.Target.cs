using UnrealBuildTool;

public class SyntheticClientTarget : TargetRules
{
	public SyntheticClientTarget(TargetInfo Target) : base(Target)
	{
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		Type = TargetType.Client;
		ExtraModuleNames.Add("Synthetic");
	}
}
