using UnrealBuildTool;

public class SyntheticTarget : TargetRules
{
	public SyntheticTarget(TargetInfo Target) : base(Target)
	{
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		Type = TargetType.Game;
		ExtraModuleNames.Add("Synthetic");
	}
}
