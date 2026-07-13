/** AUTO-GENERATED — run: node scripts/generate-bridge-protocol.mjs */
export const GENERATED_BRIDGE_METHODS = [
  'assetRegistry.delta',
  'assetRegistry.dependencies',
  'assetRegistry.get',
  'assetRegistry.list',
  'assetRegistry.referencers',
  'automation.cancel',
  'automation.list',
  'automation.run',
  'automation.status',
  'blueprint.compileErrors',
  'blueprint.findImplementations',
  'blueprint.findUFunctionNodes',
  'blueprint.listDerived',
  'blueprint.propertyOverrides',
  'handshake',
  'logs.tail',
  'pie.getState',
  'ping',
] as const;

export const GENERATED_BRIDGE_CAPABILITIES = [
  'assetRegistry',
  'automationTests',
  'blueprintGraph',
  'pieState',
  'unrealLogs',
] as const;
