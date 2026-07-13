/** Editor Bridge protocol v1 — schema-driven method registry. */

import { GENERATED_BRIDGE_METHODS } from './bridgeProtocol.generated';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_CAPABILITY_VERSION = 1;

export const BRIDGE_ERROR_UNSUPPORTED = -32001;
export const BRIDGE_ERROR_INVALID_PARAMS = -32002;

export const BRIDGE_METHODS = GENERATED_BRIDGE_METHODS;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** Methods with real E2E-verified behavior (stubs excluded). */
export const BRIDGE_IMPLEMENTED_METHODS: ReadonlySet<BridgeMethod> = new Set([
  'handshake',
  'ping',
  'assetRegistry.list',
  'assetRegistry.get',
  'assetRegistry.delta',
  'assetRegistry.referencers',
  'assetRegistry.dependencies',
  'automation.list',
  'automation.run',
  'automation.status',
  'automation.cancel',
  'blueprint.listDerived',
  'blueprint.compileErrors',
  'blueprint.findImplementations',
  'blueprint.propertyOverrides',
  'blueprint.findUFunctionNodes',
  'logs.tail',
  'pie.getState',
]);

export const BRIDGE_CAPABILITIES = {
  assetRegistry: ['assetRegistry.list', 'assetRegistry.get', 'assetRegistry.delta', 'assetRegistry.referencers', 'assetRegistry.dependencies'] as BridgeMethod[],
  automationTests: ['automation.list', 'automation.run', 'automation.status', 'automation.cancel'] as BridgeMethod[],
  blueprintGraph: ['blueprint.listDerived', 'blueprint.findImplementations', 'blueprint.propertyOverrides', 'blueprint.compileErrors', 'blueprint.findUFunctionNodes'] as BridgeMethod[],
  pieState: ['pie.getState'] as BridgeMethod[],
  unrealLogs: ['logs.tail'] as BridgeMethod[],
} as const;

/** Methods declared in schema but not yet E2E-verified — return unsupported, not empty success. */
export const BRIDGE_STUB_METHODS: ReadonlySet<BridgeMethod> = new Set([]);

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

export function isStubMethod(method: BridgeMethod): boolean {
  return BRIDGE_STUB_METHODS.has(method);
}

/** Advertise only capability groups whose methods are all implemented (no stubs). */
export function advertisedCapabilities(): BridgeCapability[] {
  const caps: BridgeCapability[] = [];
  for (const cap of Object.keys(BRIDGE_CAPABILITIES) as BridgeCapability[]) {
    const methods = BRIDGE_CAPABILITIES[cap];
    if (methods.every((m) => isMethodImplemented(m))) caps.push(cap);
  }
  return caps;
}

/** C++ route table extracted from CursorBridgeHttpServer.cpp for contract tests. */
export const CPP_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'handshake',
  'ping',
  'assetRegistry.list',
  'assetRegistry.get',
  'assetRegistry.delta',
  'assetRegistry.referencers',
  'assetRegistry.dependencies',
  'automation.list',
  'automation.run',
  'automation.status',
  'automation.cancel',
  'blueprint.listDerived',
  'blueprint.compileErrors',
  'blueprint.findImplementations',
  'blueprint.propertyOverrides',
  'blueprint.findUFunctionNodes',
  'logs.tail',
  'pie.getState',
]);
