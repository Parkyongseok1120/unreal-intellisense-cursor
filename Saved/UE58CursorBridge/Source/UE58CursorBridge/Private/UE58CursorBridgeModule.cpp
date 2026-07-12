#include "UE58CursorBridgeModule.h"
#include "CursorBridgeHttpServer.h"
#include "Containers/Ticker.h"
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "UE58CursorBridge"

static TUniquePtr<FCursorBridgeHttpServer> GBridgeServer;
static FTSTicker::FDelegateHandle GAutomationTickerHandle;

void FUE58CursorBridgeModule::StartupModule()
{
	GBridgeServer = MakeUnique<FCursorBridgeHttpServer>();
	GBridgeServer->Start();
	GAutomationTickerHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateLambda([](float DeltaTime)
		{
			if (GBridgeServer.IsValid())
			{
				GBridgeServer->TickAutomation(DeltaTime);
			}
			return true;
		}));
}

void FUE58CursorBridgeModule::ShutdownModule()
{
	if (GAutomationTickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(GAutomationTickerHandle);
		GAutomationTickerHandle.Reset();
	}
	if (GBridgeServer.IsValid())
	{
		GBridgeServer->Stop();
		GBridgeServer.Reset();
	}
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FUE58CursorBridgeModule, UE58CursorBridge)
