/** Editor Bridge protocol v1 — single source of truth for TS/C++ method parity. */

export const BRIDGE_PROTOCOL_VERSION = 1;

export const BRIDGE_METHODS = [
  'handshake',
  'ping',
  'assetRegistry.list',
  'assetRegistry.get',
  'assetRegistry.referencers',
  'assetRegistry.dependencies',
  'blueprint.listDerived',
  'blueprint.findFunctionUsages',
  'blueprint.findImplementations',
  'blueprint.propertyOverrides',
  'blueprint.interfaceImplementers',
  'automation.list',
  'automation.run',
  'automation.status',
  'automation.cancel',
  'pie.getState',
  'logs.tail',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** Methods implemented in C++ server today (Gate 2 expands this). */
export const BRIDGE_IMPLEMENTED_METHODS: ReadonlySet<BridgeMethod> = new Set([
  'handshake',
  'ping',
  'assetRegistry.list',
  'assetRegistry.get',
  'automation.list',
  'automation.run',
  'automation.status',
  'automation.cancel',
  'blueprint.listDerived',
  'logs.tail',
  'pie.getState',
]);

export const BRIDGE_CAPABILITIES = {
  assetRegistry: ['assetRegistry.list', 'assetRegistry.get'] as BridgeMethod[],
  automationTests: ['automation.list', 'automation.run', 'automation.status', 'automation.cancel'] as BridgeMethod[],
  blueprintGraph: [
    'blueprint.listDerived',
    'blueprint.findImplementations',
    'blueprint.propertyOverrides',
  ] as BridgeMethod[],
  pieState: ['pie.getState'] as BridgeMethod[],
  unrealLogs: ['logs.tail'] as BridgeMethod[],
} as const;

export type BridgeCapability = keyof typeof BRIDGE_CAPABILITIES;

export function capabilityForMethod(method: BridgeMethod): BridgeCapability | undefined {
  for (const [cap, methods] of Object.entries(BRIDGE_CAPABILITIES)) {
    if ((methods as BridgeMethod[]).includes(method)) {
      return cap as BridgeCapability;
    }
  }
  return undefined;
}

export function isMethodImplemented(method: BridgeMethod): boolean {
  return BRIDGE_IMPLEMENTED_METHODS.has(method);
}

/** C++ route table extracted from CursorBridgeHttpServer.cpp for contract tests. */
export const CPP_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'handshake',
  'ping',
  'assetRegistry.list',
  'assetRegistry.get',
  'automation.list',
  'automation.run',
  'automation.status',
  'automation.cancel',
  'blueprint.listDerived',
  'logs.tail',
  'pie.getState',
]);
