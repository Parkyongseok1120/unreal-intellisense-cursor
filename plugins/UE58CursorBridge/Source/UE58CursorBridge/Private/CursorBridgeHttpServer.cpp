#include "CursorBridgeHttpServer.h"
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
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

#if WITH_EDITOR
#include "Misc/AutomationTest.h"
#endif

static constexpr uint16 BRIDGE_BASE_PORT = 19321;
static constexpr uint16 BRIDGE_PORT_RANGE = 20;
static constexpr int32 DEFAULT_ASSET_PAGE_SIZE = 500;
static constexpr int32 MAX_ASSET_PAGE_SIZE = 2000;

/** Test name -> running | passed | failed | cancelled */
static TMap<FString, FString> GAutomationTestStates;

static FString MakeBridgeToken()
{
	return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens) + FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
}

static TSharedPtr<FJsonObject> MakeErrorObject(const FString& Message)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetNumberField(TEXT("code"), -32000);
	Obj->SetStringField(TEXT("message"), Message);
	return Obj;
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
	Descriptor->SetNumberField(TEXT("protocolVersion"), 1);
	Descriptor->SetStringField(TEXT("transport"), TEXT("http"));
	Descriptor->SetStringField(TEXT("issuedAt"), FDateTime::UtcNow().ToIso8601());
	Descriptor->SetStringField(TEXT("tokenExpiresAt"), TEXT("session"));

	TArray<TSharedPtr<FJsonValue>> Caps;
	Caps.Add(MakeShared<FJsonValueString>(TEXT("assetRegistry")));
	Caps.Add(MakeShared<FJsonValueString>(TEXT("automationTests")));
	Descriptor->SetArrayField(TEXT("capabilities"), Caps);

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Descriptor.ToSharedRef(), Writer);
	FFileHelper::SaveStringToFile(Out, *FPaths::Combine(DataDir, TEXT("editor-bridge.json")));
}

bool FCursorBridgeHttpServer::CheckAuth(const FHttpServerRequest& Request) const
{
	const FString* AuthHdr = Request.Headers.Find(TEXT("Authorization"));
	if (!AuthHdr)
	{
		return false;
	}
	const FString Prefix = TEXT("Bearer ");
	if (!AuthHdr->StartsWith(Prefix))
	{
		return false;
	}
	return AuthHdr->RightChop(Prefix.Len()) == AuthToken;
}

TSharedPtr<FJsonObject> FCursorBridgeHttpServer::ProcessRpcMethod(
	const FString& Method,
	const TSharedPtr<FJsonObject>& Params) const
{
	if (Method == TEXT("handshake"))
	{
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
		TArray<TSharedPtr<FJsonValue>> Caps;
		Caps.Add(MakeShared<FJsonValueString>(TEXT("assetRegistry")));
		Caps.Add(MakeShared<FJsonValueString>(TEXT("automationTests")));
		Result->SetArrayField(TEXT("capabilities"), Caps);
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
		TArray<FAssetData> AssetDataList;
		AssetRegistryModule.Get().GetAllAssets(AssetDataList, true);

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
		Result->SetNumberField(TEXT("hasMore"), Offset + Assets.Num() < Total);
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
		const FAssetData Data = AssetRegistryModule.Get().GetAssetByObjectPath(FSoftObjectPath(AssetPath));
		if (!Data.IsValid())
		{
			return nullptr;
		}

		TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("assetPath"), Data.GetObjectPathString());
		Entry->SetStringField(TEXT("className"), Data.AssetClassPath.GetAssetName().ToString());
		Entry->SetStringField(TEXT("packageName"), Data.PackageName.ToString());

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetObjectField(TEXT("asset"), Entry);
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
		GAutomationTestStates.Add(TestName, TEXT("running"));
		Result->SetBoolField(TEXT("ok"), true);
		Result->SetStringField(TEXT("message"), TEXT("started"));
		return Result;
	}

	if (Method == TEXT("automation.status"))
	{
		FString TestName;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), TestName))
		{
			return nullptr;
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		const FString* State = GAutomationTestStates.Find(TestName);
		if (!State)
		{
			Result->SetStringField(TEXT("state"), TEXT("unknown"));
			Result->SetStringField(TEXT("message"), TEXT("No execution record for test"));
			return Result;
		}

		Result->SetStringField(TEXT("state"), *State);
		return Result;
	}

	if (Method == TEXT("automation.cancel"))
	{
		FString TestName;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("name"), TestName))
		{
			return nullptr;
		}

		GAutomationTestStates.Add(TestName, TEXT("cancelled"));
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
		return Result;
	}

	if (Method == TEXT("blueprint.listDerived"))
	{
		FString ClassPath;
		if (!Params.IsValid() || !Params->TryGetStringField(TEXT("classPath"), ClassPath))
		{
			return nullptr;
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("derived"), TArray<TSharedPtr<FJsonValue>>());
		Result->SetNumberField(TEXT("total"), 0);
		return Result;
	}

	if (Method == TEXT("logs.tail"))
	{
		int32 Lines = 100;
		if (Params.IsValid())
		{
			double LinesNum = 0;
			if (Params->TryGetNumberField(TEXT("lines"), LinesNum))
			{
				Lines = FMath::Clamp(static_cast<int32>(LinesNum), 1, 5000);
			}
		}

		const FString LogDir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Logs"));
		TArray<FString> LogFiles;
		IFileManager::Get().FindFiles(LogFiles, *LogDir, TEXT("*.log"));

		TArray<TSharedPtr<FJsonValue>> Chunk;
		if (LogFiles.Num() > 0)
		{
			LogFiles.Sort();
			const FString Latest = FPaths::Combine(LogDir, LogFiles.Last());
			FString Content;
			if (FFileHelper::LoadFileToString(Content, *Latest))
			{
				TArray<FString> Split;
				Content.ParseIntoArrayLines(Split);
				const int32 Start = FMath::Max(0, Split.Num() - Lines);
				for (int32 i = Start; i < Split.Num(); ++i)
				{
					TSharedPtr<FJsonObject> LineObj = MakeShared<FJsonObject>();
					LineObj->SetStringField(TEXT("text"), Split[i]);
					Chunk.Add(MakeShared<FJsonValueObject>(LineObj));
				}
			}
		}

		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetArrayField(TEXT("lines"), Chunk);
		Result->SetNumberField(TEXT("count"), Chunk.Num());
		return Result;
	}

	if (Method == TEXT("pie.getState"))
	{
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("isPlaying"), false);
		Result->SetStringField(TEXT("mode"), TEXT("stopped"));
		return Result;
	}
#else
	if (Method == TEXT("automation.list") || Method == TEXT("automation.run"))
	{
		return nullptr;
	}
#endif

	return nullptr;
}

bool FCursorBridgeHttpServer::HandleRpcRequest(const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete)
{
	if (!CheckAuth(Request))
	{
		OnComplete(UnauthorizedResponse());
		return true;
	}

	const FString Body = FString(UTF8_TO_TCHAR(reinterpret_cast<const char*>(Request.Body.GetData())), Request.Body.Num());
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		OnComplete(JsonRpcResponse(0, nullptr, MakeErrorObject(TEXT("Invalid JSON-RPC request"))));
		return true;
	}

	int32 Id = 0;
	Root->TryGetNumberField(TEXT("id"), Id);
	FString Method;
	if (!Root->TryGetStringField(TEXT("method"), Method))
	{
		OnComplete(JsonRpcResponse(Id, nullptr, MakeErrorObject(TEXT("Missing method"))));
		return true;
	}

	const TSharedPtr<FJsonObject>* ParamsPtr = nullptr;
	Root->TryGetObjectField(TEXT("params"), ParamsPtr);
	const TSharedPtr<FJsonObject> Params = ParamsPtr ? *ParamsPtr : nullptr;

	const TSharedPtr<FJsonObject> Result = ProcessRpcMethod(Method, Params);
	if (!Result.IsValid())
	{
		OnComplete(JsonRpcResponse(Id, nullptr, MakeErrorObject(FString::Printf(TEXT("Unknown or invalid method: %s"), *Method))));
		return true;
	}

	OnComplete(JsonRpcResponse(Id, Result, nullptr));
	return true;
}

void FCursorBridgeHttpServer::Start()
{
	if (bRunning)
	{
		return;
	}

	AuthToken = MakeBridgeToken();
	Port = 0;
	HttpRouter.Reset();

	FHttpServerModule& HttpModule = FHttpServerModule::Get();
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
		[this](const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete)
		{
			return HandleRpcRequest(Request, OnComplete);
		});

	HttpModule.StartAllListeners();
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
	bRunning = false;
}
