#include "UE58CursorBridgeModule.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "UE58CursorBridge"

void FUE58CursorBridgeModule::StartupModule()
{
	// Future: authenticated named pipe / WebSocket server exposing Asset Registry deltas,
	// Blueprint graph metadata, PIE state, and structured Unreal logs to the VSIX.
}

void FUE58CursorBridgeModule::ShutdownModule()
{
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FUE58CursorBridgeModule, UE58CursorBridge)
