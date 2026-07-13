#pragma once
// AUTO-GENERATED — run: node scripts/generate-bridge-protocol.mjs
static constexpr int32 BRIDGE_PROTOCOL_SCHEMA_VERSION = 1;

static const TCHAR* GGeneratedBridgeMethods[] = {
	TEXT("assetRegistry.delta"),
	TEXT("assetRegistry.dependencies"),
	TEXT("assetRegistry.get"),
	TEXT("assetRegistry.list"),
	TEXT("assetRegistry.referencers"),
	TEXT("automation.cancel"),
	TEXT("automation.list"),
	TEXT("automation.run"),
	TEXT("automation.status"),
	TEXT("blueprint.compileErrors"),
	TEXT("blueprint.findImplementations"),
	TEXT("blueprint.findUFunctionNodes"),
	TEXT("blueprint.listDerived"),
	TEXT("blueprint.propertyOverrides"),
	TEXT("handshake"),
	TEXT("logs.tail"),
	TEXT("pie.getState"),
	TEXT("ping")
};

static constexpr int32 GGeneratedBridgeMethodCount = 18;
