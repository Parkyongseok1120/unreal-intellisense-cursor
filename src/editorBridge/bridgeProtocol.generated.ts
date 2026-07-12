/** AUTO-GENERATED — run: node scripts/generate-bridge-protocol.mjs */
export const GENERATED_BRIDGE_METHODS = [
  'assetRegistry.get',
  'assetRegistry.list',
  'automation.cancel',
  'automation.list',
  'automation.run',
  'automation.status',
  'blueprint.findImplementations',
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
