using UnrealBuildTool;

public class SyntheticEditorTarget : TargetRules
{
	public SyntheticEditorTarget(TargetInfo Target) : base(Target)
	{
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		Type = TargetType.Editor;
		ExtraModuleNames.Add("Synthetic");
	}
}
