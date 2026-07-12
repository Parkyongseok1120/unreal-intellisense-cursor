#include "UE58CursorBridgeModule.h"
#include "CursorBridgeHttpServer.h"
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "UE58CursorBridge"

static TUniquePtr<FCursorBridgeHttpServer> GBridgeServer;

void FUE58CursorBridgeModule::StartupModule()
{
	GBridgeServer = MakeUnique<FCursorBridgeHttpServer>();
	GBridgeServer->Start();
}

void FUE58CursorBridgeModule::ShutdownModule()
{
	if (GBridgeServer.IsValid())
	{
		GBridgeServer->Stop();
		GBridgeServer.Reset();
	}
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FUE58CursorBridgeModule, UE58CursorBridge)
