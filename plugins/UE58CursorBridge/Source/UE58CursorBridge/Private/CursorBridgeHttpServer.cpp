#include "CursorBridgeHttpServer.h"
#include "BridgeProtocol.generated.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "HttpPath.h"
#include "HttpServerModule.h"
#include "HttpServerRequest.h"
#include "HttpServerResponse.h"
#include "IHttpRouter.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/App.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

#if WITH_EDITOR
#include "Misc/AutomationTest.h"
#include "Async/TaskGraphInterfaces.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Blueprint/BlueprintSupport.h"
#include "K2Node_CallFunction.h"
#include "EdGraph/EdGraph.h"
#endif

static constexpr uint16 BRIDGE_BASE_PORT = 19321;
static constexpr uint16 BRIDGE_PORT_RANGE = 20;
static constexpr int32 DEFAULT_ASSET_PAGE_SIZE = 500;
static constexpr int32 MAX_ASSET_PAGE_SIZE = 2000;
static constexpr int32 BRIDGE_ERROR_UNSUPPORTED = -32001;
static constexpr double AUTOMATION_TIMEOUT_SEC = 600.0;

struct FAutomationRunRecord
{
	FString State;
	double StartTime = 0.0;
	double EndTime = 0.0;
	FString ExecutionId;
	FString Message;
	int32 Line = 0;
	FString ArtifactPath;
};

static TMap<FString, FAutomationRunRecord> GAutomationTestStates;
static FString GActiveAutomationTestName;

struct FAssetSnapshotEntry
{
	FString ClassName;
	FString PackageName;
};

static TMap<FString, FAssetSnapshotEntry> GAssetRegistrySnapshot;
static int64 GAssetRegistrySnapshotSince = 0;

static FString MakeBridgeToken()
{
	return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens) + FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
}

static TSharedPtr<FJsonObject> MakeErrorObject(int32 Code, const FString& Message)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetNumberField(TEXT("code"), Code);
	Obj->SetStringField(TEXT("message"), Message);
	return Obj;
}

#if WITH_EDITOR
static FString BlueprintClassMatchToken(const FString& ClassPath)
{
	FString Token = ClassPath.Contains(TEXT("."))
		? ClassPath.Mid(ClassPath.Find(TEXT("."), ESearchCase::IgnoreCase, ESearchDir::FromEnd) + 1)
		: ClassPath;
	if (Token.Len() > 1 && (Token[0] == TCHAR('A') || Token[0] == TCHAR('U')) && FChar::IsUpper(Token[1]))
	{
		Token = Token.Mid(1);
	}
	return Token;
}

static bool BlueprintMatchesClassToken(const FAssetData& Data, const FString& ClassToken)
{
	const FString ParentClass = Data.GetTagValueRef<FString>(FBlueprintTags::ParentClassPath);
	const FString NativeParent = Data.GetTagValueRef<FString>(FBlueprintTags::NativeParentClassPath);
	const bool bParentMatch = !ParentClass.IsEmpty() && ParentClass.Contains(ClassToken, ESearchCase::IgnoreCase);
	const bool bNativeMatch = !NativeParent.IsEmpty() && NativeParent.Contains(ClassToken, ESearchCase::IgnoreCase);
	return bParentMatch || bNativeMatch;
}
#endif

static bool IsImplementedBridgeMethod(const FString& Method)
{
	static const TSet<FString> Implemented = {
		TEXT("handshake"),
		TEXT("ping"),
		TEXT("assetRegistry.list"),
		TEXT("assetRegistry.get"),
		TEXT("assetRegistry.delta"),
		TEXT("assetRegistry.referencers"),
		TEXT("assetRegistry.dependencies"),
		TEXT("automation.list"),
		TEXT("automation.run"),
		TEXT("automation.status"),
		TEXT("automation.cancel"),
		TEXT("blueprint.listDerived"),
		TEXT("blueprint.findImplementations"),
		TEXT("blueprint.propertyOverrides"),
		TEXT("blueprint.compileErrors"),
		TEXT("blueprint.findUFunctionNodes"),
		TEXT("logs.tail"),
		TEXT("pie.getState"),
	};
	return Implemented.Contains(Method);
}

static bool IsDeclaredStubMethod(const FString& Method)
{
	return false;
}

static TUniquePtr<FHttpServerResponse> JsonRpcResponse(
	int32 Id,
	const TSharedPtr<FJsonObject>& Result,
	const TSharedPtr<FJsonObject>& Error)
{
	TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("jsonrpc"), TEXT("2.0"));
	Root->SetNumberField(TEXT("id"), Id);
	if (Error.IsValid())
	{
		Root->SetObjectField(TEXT("error"), Error);
	}
	else
	{
		Root->SetObjectField(TEXT("result"), Result);
	}

	FString Body;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return FHttpServerResponse::Create(Body, TEXT("application/json"));
}

static TUniquePtr<FHttpServerResponse> UnauthorizedResponse()
{
	TUniquePtr<FHttpServerResponse> Response = FHttpServerResponse::Create(TEXT("Unauthorized"), TEXT("text/plain"));
	Response->Code = EHttpServerResponseCodes::Denied;
	return Response;
}

void FCursorBridgeHttpServer::WriteDescriptor() const
{
	const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	const FString DataDir = FPaths::Combine(ProjectDir, TEXT(".ue5_8cursor"));
	IFileManager::Get().MakeDirectory(*DataDir, true);

	TSharedPtr<FJsonObject> Descriptor = MakeShared<FJsonObject>();
	Descriptor->SetNumberField(TEXT("port"), Port);
	Descriptor->SetNumberField(TEXT("pid"), FPlatformProcess::GetCurrentProcessId());
	Descriptor->SetStringField(TEXT("token"), AuthToken);
	Descriptor->SetNumberField(TEXT("protocolVersion"), BRIDGE_PROTOCOL_SCHEMA_VERSION);
	Descriptor->SetNumberField(TEXT("capabilityVersion"), 1);
	Descriptor->SetStringField(TEXT("transport"), TEXT("http"));
	Descriptor->SetStringField(TEXT("projectId"), ProjectId);
	Descriptor->SetStringField(TEXT("engineBuildId"), FEngineVersion::Current().ToString());
	Descriptor->SetNumberField(TEXT("processStartTime"), ProcessStartTime);
	Descriptor->SetStringField(TEXT("issuedAt"), FDateTime::UtcNow().ToIso8601());
	Descriptor->SetStringField(TEXT("tokenExpiresAt"), TEXT("session"));

	TArray<TSharedPtr<FJsonValue>> Caps;
	Caps.Add(MakeShared<FJsonValueString>(TEXT("assetRegistry")));
	Caps.Add(MakeShared<FJsonValueString>(TEXT("automationTests")));
	Caps.Add(MakeShared<FJsonValueString>(TEXT("blueprintGraph")));
	Caps.Add(MakeShared<FJsonValueString>(TEXT("pieState")));
	Caps.Add(MakeShared<FJsonValueString>(TEXT("unrealLogs")));
	Descriptor->SetArrayField(TEXT("capabilities"), Caps);

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Descriptor.ToSharedRef(), Writer);

	const FString FinalPath = FPaths::Combine(DataDir, TEXT("editor-bridge.json"));
	const FString TempPath = FinalPath + TEXT(".tmp");
	FFileHelper::SaveStringToFile(Out, *TempPath);
	IFileManager::Get().Move(*FinalPath, *TempPath, true, true);
}

void FCursorBridgeHttpServer::DeleteDescriptor() const
{
	const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	const FString FinalPath = FPaths::Combine(ProjectDir, TEXT(".ue5_8cursor"), TEXT("editor-bridge.json"));
	IFileManager::Get().Delete(*FinalPath);
}

bool FCursorBridgeHttpServer::CheckAuth(const FHttpServerRequest& Request) const
{
	const TArray<FString>* AuthHeaders = Request.Headers.Find(TEXT("Authorization"));
	if (!AuthHeaders || AuthHeaders->Num() == 0)
	{
		return false;
	}
	const FString& AuthHdr = (*AuthHeaders)[0];
	const FString Prefix = TEXT("Bearer ");
	if (!AuthHdr.StartsWith(Prefix))
	{
		return false;
	}
	return AuthHdr.RightChop(Prefix.Len()) == AuthToken;
}

void FCursorBridgeHttpServer::RefreshRunningAutomationStates()
{
#if WITH_EDITOR
	const double Now = FPlatformTime::Seconds();
	FAutomationTestFramework& Framework = FAutomationTestFramework::Get();

	for (TPair<FString, FAutomationRunRecord>& Pair : GAutomationTestStates)
	{
		if (Pair.Value.State != TEXT("running"))
		{
			continue;
		}

		if (Now - Pair.Value.StartTime > AUTOMATION_TIMEOUT_SEC)
		{
			FAutomationTestExecutionInfo IgnoredExecutionInfo;
			Framework.StopTest(IgnoredExecutionInfo);
			Pair.Value.State = TEXT("timedOut");
			if (GActiveAutomationTestName == Pair.Key)
			{
				GActiveAutomationTestName.Empty();
			}
			continue;
		}

		if (Framework.ExecuteLatentCommands())
		{
			FAutomationTestExecutionInfo ExecutionInfo;
			const bool bStopped = Framework.StopTest(ExecutionInfo);
			const bool bPassed = bStopped && ExecutionInfo.GetErrorTotal() == 0;
			Pair.Value.EndTime = Now;
			Pair.Value.State = bPassed ? TEXT("passed") : TEXT("failed");
			Pair.Value.ArtifactPath = FPaths::ProjectLogDir() / (FString(FApp::GetProjectName()) + TEXT(".log"));
			if (!bPassed && ExecutionInfo.GetErrorTotal() > 0)
			{
				Pair.Value.Message = FString::Printf(TEXT("%d automation error(s)"), ExecutionInfo.GetErrorTotal());
				Pair.Value.Line = 1;
			}
			if (GActiveAutomationTestName == Pair.Key)
			{
				GActiveAutomationTestName.Empty();
			}
		}
	}
#endif
}

void FCursorBridgeHttpServer::TickAutomation(float DeltaTime)
{
	RefreshRunningAutomationStates();
}

TSharedPtr<FJsonObject> FCursorBridgeHttpServer::ProcessRpcMethod(
	const FString& Method,
	const TSharedPtr<FJsonObject>& Params)
{
	if (IsDeclaredStubMethod(Method))
	{
		return nullptr;
	}

	if (Method == TEXT("handshake"))
	{
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
		TArray<TSharedPtr<FJsonValue>> Caps;
		Caps.Add(MakeShared<FJsonValueString>(TEXT("assetRegistry")));
		Caps.Add(MakeShared<FJsonValueString>(TEXT("automationTests")));
		Caps.Add(MakeShared<FJsonValueString>(TEXT("blueprintGraph")));
		Caps.Add(MakeShared<FJsonValueString>(TEXT("pieState")));
		Caps.Add(MakeShared<FJsonValueString>(TEXT("unrealLogs")));
		Result->SetArrayField(TEXT("capabilities"), Caps);
		Result->SetNumberField(TEXT("capabilityVersion"), 1);
		return Result;
	}

	if (Method == TEXT("ping"))
	{
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("pong"), true);
		return Result;
	}

	if (Method == TEXT("assetRegistry.list"))
	{
		FString PathFilter;
		FString ClassFilter;
		int32 Limit = DEFAULT_ASSET_PAGE_SIZE;
		int32 Offset = 0;
		if (Params.IsValid())
		{
			Params->TryGetStringField(TEXT("path"), PathFilter);
			Params->TryGetStringField(TEXT("class"), ClassFilter);
			double LimitNum = 0;
			double OffsetNum = 0;
			if (Params->TryGetNumberField(TEXT("limit"), LimitNum))
			{
				Limit = FMath::Clamp(static_cast<int32>(LimitNum), 1, MAX_ASSET_PAGE_SIZE);
			}
			if (Params->TryGetNumberField(TEXT("offset"), OffsetNum))
			{
				Offset = FMath::Max(0, static_cast<int32>(OffsetNum));
			}
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		TArray<FAssetData> AssetDataList;

		if (!PathFilter.IsEmpty() || !ClassFilter.IsEmpty())
		{
			FARFilter Filter;
			Filter.bRecursivePaths = true;
			if (!PathFilter.IsEmpty())
			{
				Filter.PackagePaths.Add(FName(*PathFilter));
			}
			if (!ClassFilter.IsEmpty())
			{
				Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), FName(*ClassFilter)));
			}
			Registry.GetAssets(Filter, AssetDataList);
		}
		else
		{
			FARFilter Filter;
			Filter.bRecursivePaths = true;
			Filter.PackagePaths.Add(FName(TEXT("/Game")));
			Registry.GetAssets(Filter, AssetDataList);
		}

		TArray<TSharedPtr<FJsonValue>> Assets;
		int32 Total = 0;
		int32 Skipped = 0;

		for (const FAssetData& Data : AssetDataList)
		{
			const FString ObjectPath = Data.GetObjectPathString();
			if (!PathFilter.IsEmpty() && !ObjectPath.StartsWith(PathFilter))
			{
				continue;
			}
			const FString ClassName = Data.AssetClassPath.GetAssetName().ToString();
			if (!ClassFilter.IsEmpty() && !ClassName.Equals(ClassFilter, ESearchCase::IgnoreCase))
			{
				continue;
			}

			++Total;
			if (Skipped < Offset)
			{
				++Skipped;
				continue;
			}
			if (Assets.Num() >= Limit)
			{
				continue;
			}

			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("assetPath"), ObjectPath);
			Entry->SetStringField(TEXT("className"), ClassName);
			Entry->SetStringField(TEXT("packageName"), Data.PackageName.ToString());
			Assets.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("assets"), Assets);
		Result->SetNumberField(TEXT("total"), Total);
		Result->SetBoolField(TEXT("hasMore"), Offset + Assets.Num() < Total);
		Result->SetNumberField(TEXT("offset"), Offset);
		return Result;
	}

	if (Method == TEXT("assetRegistry.get"))
	{
		FString AssetPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), AssetPath))
		{
			return nullptr;
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		FSoftObjectPath RequestedPath(AssetPath);
		FAssetData Data = Registry.GetAssetByObjectPath(RequestedPath);
		if (!Data.IsValid())
		{
			return nullptr;
		}

		if (Data.AssetClassPath.GetAssetName() == FName(TEXT("ObjectRedirector")))
		{
			const FSoftObjectPath RedirectedPath = Registry.GetRedirectedObjectPath(RequestedPath);
			const FAssetData Redirected = Registry.GetAssetByObjectPath(RedirectedPath);
			if (Redirected.IsValid())
			{
				Data = Redirected;
				AssetPath = Redirected.GetObjectPathString();
			}
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("assetPath"), Data.GetObjectPathString());
		Entry->SetStringField(TEXT("className"), Data.AssetClassPath.GetAssetName().ToString());
		Entry->SetStringField(TEXT("packageName"), Data.PackageName.ToString());

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetObjectField(TEXT("asset"), Entry);
		return Result;
	}

	if (Method == TEXT("assetRegistry.delta"))
	{
		double SinceNum = 0;
		if (Params.IsValid())
		{
			Params->TryGetNumberField(TEXT("since"), SinceNum);
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		TArray<FAssetData> AssetDataList;
		FARFilter Filter;
		Filter.bRecursivePaths = true;
		Filter.PackagePaths.Add(FName(TEXT("/Game")));
		Registry.GetAssets(Filter, AssetDataList);

		TMap<FString, FAssetSnapshotEntry> Current;
		for (const FAssetData& Data : AssetDataList)
		{
			const FString ObjectPath = Data.GetObjectPathString();
			FAssetSnapshotEntry Entry;
			Entry.ClassName = Data.AssetClassPath.GetAssetName().ToString();
			Entry.PackageName = Data.PackageName.ToString();
			Current.Add(ObjectPath, Entry);
		}

		TArray<TSharedPtr<FJsonValue>> Added;
		TArray<TSharedPtr<FJsonValue>> Updated;
		TArray<TSharedPtr<FJsonValue>> Removed;
		const int64 SinceTs = static_cast<int64>(SinceNum);
		if (SinceTs <= 0 && GAssetRegistrySnapshot.Num() > 0)
		{
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetArrayField(TEXT("added"), TArray<TSharedPtr<FJsonValue>>());
			Result->SetArrayField(TEXT("updated"), TArray<TSharedPtr<FJsonValue>>());
			Result->SetArrayField(TEXT("removed"), TArray<TSharedPtr<FJsonValue>>());
			Result->SetNumberField(TEXT("since"), GAssetRegistrySnapshotSince);
			return Result;
		}
		const bool bBaseline = SinceTs <= 0 || GAssetRegistrySnapshot.Num() == 0;

		if (bBaseline)
		{
			for (const TPair<FString, FAssetSnapshotEntry>& Pair : Current)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("assetPath"), Pair.Key);
				Entry->SetStringField(TEXT("className"), Pair.Value.ClassName);
				Entry->SetStringField(TEXT("packageName"), Pair.Value.PackageName);
				Added.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}
		else
		{
			for (const TPair<FString, FAssetSnapshotEntry>& Pair : Current)
			{
				const FAssetSnapshotEntry* Previous = GAssetRegistrySnapshot.Find(Pair.Key);
				if (!Previous)
				{
					TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
					Entry->SetStringField(TEXT("assetPath"), Pair.Key);
					Entry->SetStringField(TEXT("className"), Pair.Value.ClassName);
					Entry->SetStringField(TEXT("packageName"), Pair.Value.PackageName);
					Added.Add(MakeShared<FJsonValueObject>(Entry));
					continue;
				}
				if (Previous->ClassName != Pair.Value.ClassName || Previous->PackageName != Pair.Value.PackageName)
				{
					TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
					Entry->SetStringField(TEXT("assetPath"), Pair.Key);
					Entry->SetStringField(TEXT("className"), Pair.Value.ClassName);
					Entry->SetStringField(TEXT("packageName"), Pair.Value.PackageName);
					Updated.Add(MakeShared<FJsonValueObject>(Entry));
				}
			}
			for (const TPair<FString, FAssetSnapshotEntry>& Pair : GAssetRegistrySnapshot)
			{
				if (!Current.Contains(Pair.Key))
				{
					Removed.Add(MakeShared<FJsonValueString>(Pair.Key));
				}
			}
		}

		GAssetRegistrySnapshot = Current;
		GAssetRegistrySnapshotSince = FDateTime::UtcNow().ToUnixTimestamp();

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("added"), Added);
		Result->SetArrayField(TEXT("updated"), Updated);
		Result->SetArrayField(TEXT("removed"), Removed);
		Result->SetNumberField(TEXT("since"), GAssetRegistrySnapshotSince);
		return Result;
	}

	if (Method == TEXT("assetRegistry.referencers"))
	{
		FString AssetPath;
		int32 Depth = 1;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), AssetPath))
		{
			return nullptr;
		}
		Params->TryGetNumberField(TEXT("depth"), Depth);
		Depth = FMath::Clamp(Depth, 1, 4);

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		const FAssetData Data = Registry.GetAssetByObjectPath(FSoftObjectPath(AssetPath));
		if (!Data.IsValid())
		{
			return nullptr;
		}

		TArray<TSharedPtr<FJsonValue>> Referencers;
		TSet<FString> SeenPaths;
		TArray<FString> Frontier;
		Frontier.Add(AssetPath);

		for (int32 Hop = 0; Hop < Depth && Frontier.Num() > 0; ++Hop)
		{
			TArray<FString> NextFrontier;
			for (const FString& Path : Frontier)
			{
				const FAssetData FrontierData = Registry.GetAssetByObjectPath(FSoftObjectPath(Path));
				if (!FrontierData.IsValid())
				{
					continue;
				}

				TArray<FName> ReferencerPackages;
				Registry.GetReferencers(FrontierData.PackageName, ReferencerPackages, UE::AssetRegistry::EDependencyCategory::Package);
				for (const FName& PackageName : ReferencerPackages)
				{
					TArray<FAssetData> PackageAssets;
					Registry.GetAssetsByPackageName(PackageName, PackageAssets);
					for (const FAssetData& RefData : PackageAssets)
					{
						const FString RefPath = RefData.GetObjectPathString();
						if (SeenPaths.Contains(RefPath))
						{
							continue;
						}
						SeenPaths.Add(RefPath);

						TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
						Entry->SetStringField(TEXT("assetPath"), RefPath);
						Entry->SetStringField(TEXT("className"), RefData.AssetClassPath.GetAssetName().ToString());
						Entry->SetStringField(TEXT("packageName"), RefData.PackageName.ToString());
						Referencers.Add(MakeShared<FJsonValueObject>(Entry));
						NextFrontier.Add(RefPath);
					}
				}
			}
			Frontier = MoveTemp(NextFrontier);
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("referencers"), Referencers);
		Result->SetNumberField(TEXT("total"), Referencers.Num());
		return Result;
	}

	if (Method == TEXT("assetRegistry.dependencies"))
	{
		FString AssetPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), AssetPath))
		{
			return nullptr;
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		const FAssetData Data = Registry.GetAssetByObjectPath(FSoftObjectPath(AssetPath));
		if (!Data.IsValid())
		{
			return nullptr;
		}

		TArray<TSharedPtr<FJsonValue>> Dependencies;
		TArray<FName> DependencyPackages;
		Registry.GetDependencies(Data.PackageName, DependencyPackages, UE::AssetRegistry::EDependencyCategory::Package);
		for (const FName& PackageName : DependencyPackages)
		{
			TArray<FAssetData> PackageAssets;
			Registry.GetAssetsByPackageName(PackageName, PackageAssets);
			for (const FAssetData& DepData : PackageAssets)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("assetPath"), DepData.GetObjectPathString());
				Entry->SetStringField(TEXT("className"), DepData.AssetClassPath.GetAssetName().ToString());
				Entry->SetStringField(TEXT("packageName"), DepData.PackageName.ToString());
				Dependencies.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("dependencies"), Dependencies);
		Result->SetNumberField(TEXT("total"), Dependencies.Num());
		return Result;
	}

#if WITH_EDITOR
	if (Method == TEXT("blueprint.listDerived"))
	{
		FString ClassPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("classPath"), ClassPath))
		{
			return nullptr;
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		FARFilter Filter;
		Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
		TArray<FAssetData> AssetDataList;
		Registry.GetAssets(Filter, AssetDataList);

		TArray<TSharedPtr<FJsonValue>> Derived;
		const FString ClassToken = BlueprintClassMatchToken(ClassPath);

		for (const FAssetData& Data : AssetDataList)
		{
			if (!BlueprintMatchesClassToken(Data, ClassToken))
			{
				continue;
			}
			const FString ParentClass = Data.GetTagValueRef<FString>(FBlueprintTags::ParentClassPath);
			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("assetPath"), Data.GetObjectPathString());
			Entry->SetStringField(TEXT("className"), Data.AssetClassPath.GetAssetName().ToString());
			Entry->SetStringField(TEXT("parentClassPath"), ParentClass);
			Derived.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("derived"), Derived);
		Result->SetNumberField(TEXT("total"), Derived.Num());
		return Result;
	}

	if (Method == TEXT("blueprint.findImplementations"))
	{
		FString ClassPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("classPath"), ClassPath))
		{
			return nullptr;
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		FARFilter Filter;
		Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
		TArray<FAssetData> AssetDataList;
		Registry.GetAssets(Filter, AssetDataList);

		TArray<TSharedPtr<FJsonValue>> Implementations;
		const FString InterfaceToken = ClassPath.Contains(TEXT("."))
			? ClassPath.Mid(ClassPath.Find(TEXT("."), ESearchCase::IgnoreCase, ESearchDir::FromEnd) + 1)
			: ClassPath;

		for (const FAssetData& Data : AssetDataList)
		{
			const FString ImplementedInterfaces = Data.GetTagValueRef<FString>(FBlueprintTags::ImplementedInterfaces);
			const FString ObjectPath = Data.GetObjectPathString();
			const bool bMatchesInterface =
				(!ImplementedInterfaces.IsEmpty() && ImplementedInterfaces.Contains(InterfaceToken, ESearchCase::IgnoreCase))
				|| ObjectPath.Contains(InterfaceToken, ESearchCase::IgnoreCase);
			if (!bMatchesInterface)
			{
				continue;
			}
			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("assetPath"), Data.GetObjectPathString());
			Entry->SetStringField(TEXT("className"), Data.AssetClassPath.GetAssetName().ToString());
			Implementations.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("implementations"), Implementations);
		Result->SetNumberField(TEXT("total"), Implementations.Num());
		return Result;
	}

	if (Method == TEXT("blueprint.propertyOverrides"))
	{
		FString ClassPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("classPath"), ClassPath))
		{
			return nullptr;
		}

		TArray<TSharedPtr<FJsonValue>> Overrides;
		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		FARFilter Filter;
		Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
		TArray<FAssetData> AssetDataList;
		Registry.GetAssets(Filter, AssetDataList);

		const FString ClassToken = BlueprintClassMatchToken(ClassPath);

		for (const FAssetData& Data : AssetDataList)
		{
			if (!BlueprintMatchesClassToken(Data, ClassToken))
			{
				continue;
			}

			const FString AssetPath = Data.GetObjectPathString();
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("property"), TEXT("assetPath"));
				Entry->SetStringField(TEXT("value"), AssetPath);
				Overrides.Add(MakeShared<FJsonValueObject>(Entry));
			}
			const FString NativeParent = Data.GetTagValueRef<FString>(FBlueprintTags::NativeParentClassPath);
			if (!NativeParent.IsEmpty())
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("property"), FString::Printf(TEXT("%s.NativeParentClassPath"), *AssetPath));
				Entry->SetStringField(TEXT("value"), NativeParent);
				Overrides.Add(MakeShared<FJsonValueObject>(Entry));
			}
			const FString ParentClassTag = Data.GetTagValueRef<FString>(FBlueprintTags::ParentClassPath);
			if (!ParentClassTag.IsEmpty())
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("property"), FString::Printf(TEXT("%s.ParentClassPath"), *AssetPath));
				Entry->SetStringField(TEXT("value"), ParentClassTag);
				Overrides.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("overrides"), Overrides);
		Result->SetNumberField(TEXT("total"), Overrides.Num());
		return Result;
	}

	if (Method == TEXT("blueprint.findUFunctionNodes"))
	{
		FString ClassPath;
		FString FunctionName;
		if (!Params.IsValid()
			|| !Params->TryGetStringField(TEXT("classPath"), ClassPath)
			|| !Params->TryGetStringField(TEXT("functionName"), FunctionName))
		{
			return nullptr;
		}

		FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& Registry = AssetRegistryModule.Get();
		FARFilter Filter;
		Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
		TArray<FAssetData> AssetDataList;
		Registry.GetAssets(Filter, AssetDataList);

		TArray<TSharedPtr<FJsonValue>> Nodes;
		const FString ClassToken = BlueprintClassMatchToken(ClassPath);
		const FName FunctionFName(*FunctionName);

		for (const FAssetData& Data : AssetDataList)
		{
			if (!BlueprintMatchesClassToken(Data, ClassToken))
			{
				continue;
			}

			UBlueprint* Blueprint = Cast<UBlueprint>(Data.ToSoftObjectPath().TryLoad());
			if (!Blueprint)
			{
				continue;
			}

			auto ScanGraph = [&](UEdGraph* Graph)
			{
				if (!Graph)
				{
					return;
				}
				for (UEdGraphNode* Node : Graph->Nodes)
				{
					const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node);
					if (!CallNode)
					{
						continue;
					}
					if (CallNode->FunctionReference.GetMemberName() != FunctionFName)
					{
						continue;
					}
					TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
					Entry->SetStringField(TEXT("assetPath"), Data.GetObjectPathString());
					Entry->SetStringField(TEXT("nodeName"), FunctionName);
					Entry->SetStringField(TEXT("graphName"), Graph->GetName());
					Entry->SetNumberField(TEXT("nodeX"), Node->NodePosX);
					Entry->SetNumberField(TEXT("nodeY"), Node->NodePosY);
					Nodes.Add(MakeShared<FJsonValueObject>(Entry));
				}
			};

			for (UEdGraph* Graph : Blueprint->UbergraphPages)
			{
				ScanGraph(Graph);
			}
			for (UEdGraph* Graph : Blueprint->FunctionGraphs)
			{
				ScanGraph(Graph);
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("nodes"), Nodes);
		Result->SetNumberField(TEXT("total"), Nodes.Num());
		return Result;
	}

	if (Method == TEXT("blueprint.compileErrors"))
	{
		FString ClassPath;
		if (Params.IsValid())
		{
			Params->TryGetStringField(TEXT("classPath"), ClassPath);
		}

		TArray<TSharedPtr<FJsonValue>> Errors;
		const FString EditorLogFilePath = FPaths::ProjectLogDir() / (FString(FApp::GetProjectName()) + TEXT(".log"));
		FString LogContent;
		if (FFileHelper::LoadFileToString(LogContent, *EditorLogFilePath))
		{
			TArray<FString> Lines;
			LogContent.ParseIntoArrayLines(Lines);
			const int32 Start = FMath::Max(0, Lines.Num() - 500);
			for (int32 i = Start; i < Lines.Num(); ++i)
			{
				const FString& Line = Lines[i];
				if (!Line.Contains(TEXT("Blueprint"), ESearchCase::IgnoreCase)) continue;
				if (!Line.Contains(TEXT("Error"), ESearchCase::IgnoreCase) && !Line.Contains(TEXT("Compile"), ESearchCase::IgnoreCase)) continue;
				if (!ClassPath.IsEmpty() && !Line.Contains(ClassPath, ESearchCase::IgnoreCase)) continue;

				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("assetPath"), ClassPath);
				Entry->SetStringField(TEXT("message"), Line.TrimStartAndEnd());
				Errors.Add(MakeShared<FJsonValueObject>(Entry));
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("errors"), Errors);
		Result->SetNumberField(TEXT("total"), Errors.Num());
		return Result;
	}

	if (Method == TEXT("pie.getState"))
	{
		const bool bPlaying = GEditor && GEditor->PlayWorld != nullptr;
		const bool bSimulating = GEditor && GEditor->bIsSimulatingInEditor;
		FString Mode = TEXT("stopped");
		if (bSimulating)
		{
			Mode = TEXT("simulate");
		}
		else if (bPlaying)
		{
			Mode = TEXT("pie");
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("isPlaying"), bPlaying || bSimulating);
		Result->SetStringField(TEXT("mode"), Mode);
		return Result;
	}
#endif

	if (Method == TEXT("logs.tail"))
	{
		int32 Lines = 50;
		int64 Offset = 0;
		FString FileId;
		if (Params.IsValid())
		{
			double LinesNum = 0;
			double OffsetNum = 0;
			if (Params->TryGetNumberField(TEXT("lines"), LinesNum))
			{
				Lines = FMath::Clamp(static_cast<int32>(LinesNum), 1, 500);
			}
			if (Params->TryGetNumberField(TEXT("offset"), OffsetNum))
			{
				Offset = static_cast<int64>(OffsetNum);
			}
			Params->TryGetStringField(TEXT("fileId"), FileId);
		}

		const FString LogDir = FPaths::ProjectLogDir();
		const FString LogFile = FPaths::Combine(LogDir, FString(FApp::GetProjectName()) + TEXT(".log"));
		const FString ResolvedFileId = FileId.IsEmpty() ? LogFile.ToLower() : FileId;
		TArray<TSharedPtr<FJsonValue>> LineEntries;
		int64 NewOffset = Offset;

		FString Content;
		if (FFileHelper::LoadFileToString(Content, *LogFile))
		{
			if (Offset > 0 && Offset < Content.Len())
			{
				Content = Content.Mid(static_cast<int32>(Offset));
			}
			TArray<FString> SplitLines;
			Content.ParseIntoArrayLines(SplitLines);
			const int32 Start = FMath::Max(0, SplitLines.Num() - Lines);
			for (int32 i = Start; i < SplitLines.Num(); ++i)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetNumberField(TEXT("line"), i + 1);
				Entry->SetStringField(TEXT("text"), SplitLines[i]);
				LineEntries.Add(MakeShared<FJsonValueObject>(Entry));
			}
			NewOffset = IFileManager::Get().FileSize(*LogFile);
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("lines"), LineEntries);
		Result->SetNumberField(TEXT("count"), LineEntries.Num());
		Result->SetNumberField(TEXT("offset"), static_cast<double>(NewOffset));
		Result->SetStringField(TEXT("fileId"), ResolvedFileId);
		return Result;
	}

#if WITH_EDITOR
	if (Method == TEXT("automation.list"))
	{
		TArray<FAutomationTestInfo> TestInfos;
		FAutomationTestFramework::Get().GetValidTestNames(TestInfos);

		TArray<TSharedPtr<FJsonValue>> Tests;
		for (const FAutomationTestInfo& Info : TestInfos)
		{
			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Info.GetDisplayName());
			Entry->SetStringField(TEXT("source"), TEXT("automation"));
			const FString SourceFile = Info.GetSourceFile();
			if (!SourceFile.IsEmpty())
			{
				Entry->SetStringField(TEXT("path"), SourceFile);
			}
			Tests.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("tests"), Tests);
		return Result;
	}

	if (Method == TEXT("automation.run"))
	{
		FString TestName;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), TestName))
		{
			return nullptr;
		}

		TArray<FAutomationTestInfo> TestInfos;
		FAutomationTestFramework::Get().GetValidTestNames(TestInfos);
		bool bFound = false;
		for (const FAutomationTestInfo& Info : TestInfos)
		{
			if (Info.GetDisplayName().Equals(TestName, ESearchCase::CaseSensitive))
			{
				bFound = true;
				break;
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		if (!bFound)
		{
			Result->SetBoolField(TEXT("ok"), false);
			Result->SetStringField(TEXT("message"), FString::Printf(TEXT("Test not found: %s"), *TestName));
			return Result;
		}

		FAutomationTestFramework::Get().StartTestByName(TestName, 0);
		FAutomationRunRecord Record;
		Record.State = TEXT("running");
		Record.StartTime = FPlatformTime::Seconds();
		Record.EndTime = 0.0;
		Record.ExecutionId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
		Record.Message.Empty();
		Record.Line = 0;
		Record.ArtifactPath.Empty();
		GAutomationTestStates.FindOrAdd(TestName) = MoveTemp(Record);
		GActiveAutomationTestName = TestName;
		Result->SetBoolField(TEXT("ok"), true);
		Result->SetStringField(TEXT("message"), TEXT("started"));
		Result->SetStringField(TEXT("executionId"), GAutomationTestStates[TestName].ExecutionId);
		return Result;
	}

	if (Method == TEXT("automation.status"))
	{
		FString TestName;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), TestName))
		{
			return nullptr;
		}

		RefreshRunningAutomationStates();

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		const FAutomationRunRecord* Record = GAutomationTestStates.Find(TestName);
		if (!Record)
		{
			Result->SetStringField(TEXT("state"), TEXT("unknown"));
			Result->SetStringField(TEXT("message"), TEXT("No execution record for test"));
			return Result;
		}

		Result->SetStringField(TEXT("state"), Record->State);
		if (!Record->Message.IsEmpty())
		{
			Result->SetStringField(TEXT("message"), Record->Message);
		}
		if (!Record->ExecutionId.IsEmpty())
		{
			Result->SetStringField(TEXT("executionId"), Record->ExecutionId);
		}
		if (Record->EndTime > Record->StartTime)
		{
			Result->SetNumberField(TEXT("durationMs"), static_cast<int64>((Record->EndTime - Record->StartTime) * 1000.0));
		}
		if (Record->Line > 0)
		{
			Result->SetNumberField(TEXT("line"), Record->Line);
		}
		if (!Record->ArtifactPath.IsEmpty())
		{
			Result->SetStringField(TEXT("artifactPath"), Record->ArtifactPath);
		}
		return Result;
	}

	if (Method == TEXT("automation.cancel"))
	{
		FString TestName;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), TestName))
		{
			return nullptr;
		}

		FAutomationTestExecutionInfo IgnoredExecutionInfo;
		FAutomationRunRecord* Record = GAutomationTestStates.Find(TestName);
		if (Record && Record->State == TEXT("running") && GActiveAutomationTestName == TestName)
		{
			FAutomationTestFramework::Get().StopTest(IgnoredExecutionInfo);
			GActiveAutomationTestName.Empty();
		}
		if (Record)
		{
			Record->State = TEXT("cancelled");
		}
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
		return Result;
	}
#else
	if (Method == TEXT("automation.list") || Method == TEXT("automation.run"))
	{
		return nullptr;
	}
#endif

	if (!IsImplementedBridgeMethod(Method))
	{
		return nullptr;
	}

	return nullptr;
}

bool FCursorBridgeHttpServer::HandleRpcRequest(const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete)
{
	UE_LOG(LogTemp, Verbose, TEXT("UE58CursorBridge: received RPC request (%d bytes)"), Request.Body.Num());
	if (!CheckAuth(Request))
	{
		UE_LOG(LogTemp, Warning, TEXT("UE58CursorBridge: rejected unauthorized RPC request"));
		OnComplete(UnauthorizedResponse());
		return true;
	}

	const FUTF8ToTCHAR Utf8Body(
		reinterpret_cast<const UTF8CHAR*>(Request.Body.GetData()),
		Request.Body.Num());
	const FString Body(Utf8Body.Length(), Utf8Body.Get());
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		UE_LOG(LogTemp, Warning, TEXT("UE58CursorBridge: invalid RPC JSON"));
		OnComplete(JsonRpcResponse(0, nullptr, MakeErrorObject(-32000, TEXT("Invalid JSON-RPC request"))));
		return true;
	}

	int32 Id = 0;
	Root->TryGetNumberField(TEXT("id"), Id);
	FString Method;
	if (!Root->TryGetStringField(TEXT("method"), Method))
	{
		OnComplete(JsonRpcResponse(Id, nullptr, MakeErrorObject(-32000, TEXT("Missing method"))));
		return true;
	}
	UE_LOG(LogTemp, Verbose, TEXT("UE58CursorBridge: dispatching RPC %s"), *Method);

	if (IsDeclaredStubMethod(Method))
	{
		OnComplete(JsonRpcResponse(
			Id,
			nullptr,
			MakeErrorObject(BRIDGE_ERROR_UNSUPPORTED, FString::Printf(TEXT("Method not implemented: %s"), *Method))));
		return true;
	}

	const TSharedPtr<FJsonObject>* ParamsPtr = nullptr;
	Root->TryGetObjectField(TEXT("params"), ParamsPtr);
	const TSharedPtr<FJsonObject> Params = ParamsPtr ? *ParamsPtr : nullptr;

	const TSharedPtr<FJsonObject> Result = ProcessRpcMethod(Method, Params);
	if (!Result.IsValid())
	{
		OnComplete(JsonRpcResponse(Id, nullptr, MakeErrorObject(-32000, FString::Printf(TEXT("Unknown or invalid method: %s"), *Method))));
		return true;
	}

	OnComplete(JsonRpcResponse(Id, Result, nullptr));
	UE_LOG(LogTemp, Verbose, TEXT("UE58CursorBridge: completed RPC %s"), *Method);
	return true;
}

void FCursorBridgeHttpServer::Start()
{
	if (bRunning)
	{
		return;
	}

	AuthToken = MakeBridgeToken();
	ProjectId = FPaths::GetBaseFilename(FPaths::GetProjectFilePath());
	ProcessStartTime = FPlatformTime::Seconds();
	Port = 0;
	HttpRouter.Reset();

	FHttpServerModule& HttpModule = FHttpServerModule::Get();
	// HTTPServer only performs an immediate bind failure check once listeners
	// are enabled. Enable first so bFailOnBindFailure selects a real endpoint,
	// rather than writing a descriptor for a port that later fails to listen.
	HttpModule.StartAllListeners();
	for (uint16 Offset = 0; Offset < BRIDGE_PORT_RANGE; ++Offset)
	{
		const uint16 Candidate = BRIDGE_BASE_PORT + Offset;
		TSharedPtr<IHttpRouter> Router = HttpModule.GetHttpRouter(Candidate, true);
		if (Router.IsValid())
		{
			Port = Candidate;
			HttpRouter = Router;
			break;
		}
	}

	if (!HttpRouter.IsValid())
	{
		Port = BRIDGE_BASE_PORT;
		return;
	}

	RpcRoute = HttpRouter->BindRoute(
		FHttpPath(TEXT("/rpc")),
		EHttpServerRequestVerbs::VERB_POST,
		FHttpRequestHandler::CreateLambda([this](const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete)
		{
			return HandleRpcRequest(Request, OnComplete);
		}));

	bRunning = true;
	WriteDescriptor();
}

void FCursorBridgeHttpServer::Stop()
{
	if (!bRunning)
	{
		return;
	}

	if (HttpRouter.IsValid() && RpcRoute.IsValid())
	{
		HttpRouter->UnbindRoute(RpcRoute);
		RpcRoute = FHttpRouteHandle();
	}

	HttpRouter.Reset();
	DeleteDescriptor();
	bRunning = false;
}
