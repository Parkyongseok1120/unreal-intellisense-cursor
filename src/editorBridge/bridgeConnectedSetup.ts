import * as vscode from 'vscode';
import type { EditorBridgeClient } from './editorBridgeClient';
import { startBlueprintCompileDiagnosticsWatch } from '../blueprint/blueprintCompileDiagnostics';

const setupsByProject = new Map<string, vscode.Disposable>();
const setupInflight = new Map<string, Promise<void>>();
const setupEpochByProject = new Map<string, number>();

function currentSetupEpoch(key: string): number {
  return setupEpochByProject.get(key) ?? 0;
}

function bumpSetupEpoch(key: string): void {
  setupEpochByProject.set(key, currentSetupEpoch(key) + 1);
}

export type BridgeConnectedSetupOptions = {
  /** Called after bridge asset index is synced or a delta is applied. */
  onAssetIndexChanged?: (projectRoot: string) => void;
  onBridgeSyncError?: (projectRoot: string, message: string) => void;
};

/** Tear down bridge polling timers for a project (or all projects). */
export function disposeBridgeConnectedSetup(projectRoot?: string): void {
  if (projectRoot) {
    const key = projectRoot.toLowerCase();
    bumpSetupEpoch(key);
    setupsByProject.get(key)?.dispose();
    setupsByProject.delete(key);
    setupInflight.delete(key);
    return;
  }
  for (const key of [...setupsByProject.keys()]) bumpSetupEpoch(key);
  for (const disposable of setupsByProject.values()) disposable.dispose();
  setupsByProject.clear();
  setupInflight.clear();
}

export function isBridgeSetupActive(projectRoot: string): boolean {
  return setupsByProject.has(projectRoot.toLowerCase());
}

/** Start bridge services only when not already running for this project. */
export async function ensureBridgeServicesForProject(
  projectRoot: string,
  getBridge: () => EditorBridgeClient | undefined,
  diagnosticCollection: vscode.DiagnosticCollection,
  options?: BridgeConnectedSetupOptions,
): Promise<void> {
  const key = projectRoot.toLowerCase();
  if (isBridgeSetupActive(projectRoot)) return;
  const inflight = setupInflight.get(key);
  if (inflight) {
    await inflight;
    return;
  }
  await setupBridgeConnectedServices(projectRoot, getBridge, diagnosticCollection, options);
}

/** Bootstrap asset index sync and bridge polling after a successful handshake. */
export async function setupBridgeConnectedServices(
  projectRoot: string,
  getBridge: () => EditorBridgeClient | undefined,
  diagnosticCollection: vscode.DiagnosticCollection,
  options?: BridgeConnectedSetupOptions,
): Promise<void> {
  const key = projectRoot.toLowerCase();
  const existing = setupInflight.get(key);
  if (existing) {
    await existing;
    return;
  }

  const run = (async () => {
    const epochAtStart = currentSetupEpoch(key);
    setupsByProject.get(key)?.dispose();

    const disposables: vscode.Disposable[] = [];
    let assetDeltaSince = 0;
    let deltaPollInFlight = false;
    let assetSyncGeneration = 0;

    const runFullAssetSync = async (): Promise<void> => {
      const gen = ++assetSyncGeneration;
      if (currentSetupEpoch(key) !== epochAtStart) return;
      const bridge = getBridge();
      if (!bridge?.isConnected()) return;
      const assetsResult = await bridge.queryAllAssetsResult({ pageSize: 500, timeoutMs: 15_000 });
      if (gen !== assetSyncGeneration || currentSetupEpoch(key) !== epochAtStart) return;
      if (!assetsResult.ok) {
        options?.onBridgeSyncError?.(projectRoot, assetsResult.error.message);
        return;
      }
      const { refreshAssetIndex } = await import('../assets/assetIndex');
      await refreshAssetIndex(projectRoot, { bridgeAssets: assetsResult.value, authoritativeBridge: true });
      if (gen !== assetSyncGeneration || currentSetupEpoch(key) !== epochAtStart) return;
      options?.onAssetIndexChanged?.(projectRoot);
      const deltaHandshake = await bridge.queryAssetDeltaResult(0);
      if (gen !== assetSyncGeneration || currentSetupEpoch(key) !== epochAtStart) return;
      if (deltaHandshake.ok) assetDeltaSince = deltaHandshake.value.since;
    };

    const bridge = getBridge();
    if (!bridge?.isConnected()) return;

    await runFullAssetSync();
    if (currentSetupEpoch(key) !== epochAtStart) {
      disposables.forEach((d) => d.dispose());
      return;
    }

    const deltaTimer = setInterval(() => {
      void (async () => {
        if (deltaPollInFlight) return;
        const deltaEpoch = currentSetupEpoch(key);
        const deltaGen = assetSyncGeneration;
        const activeBridge = getBridge();
        if (!activeBridge?.isConnected()) return;
        deltaPollInFlight = true;
        try {
          const delta = await activeBridge.queryAssetDeltaResult(assetDeltaSince);
          if (
            deltaGen !== assetSyncGeneration
            || currentSetupEpoch(key) !== deltaEpoch
          ) {
            return;
          }
          if (!delta.ok) {
            options?.onBridgeSyncError?.(projectRoot, delta.error.message);
            return;
          }
          if (delta.value.added.length || delta.value.removed.length || delta.value.updated.length) {
            const { applyBridgeAssetDelta } = await import('../assets/assetIndex');
            await applyBridgeAssetDelta(projectRoot, {
              added: delta.value.added,
              removed: delta.value.removed,
              updated: delta.value.updated,
            });
            if (
              deltaGen !== assetSyncGeneration
              || currentSetupEpoch(key) !== deltaEpoch
            ) {
              return;
            }
            options?.onAssetIndexChanged?.(projectRoot);
          }
          assetDeltaSince = delta.value.since;
        } finally {
          deltaPollInFlight = false;
        }
      })();
    }, 30_000);
    disposables.push({ dispose: () => clearInterval(deltaTimer) });

    disposables.push(
      startBlueprintCompileDiagnosticsWatch(projectRoot, getBridge, diagnosticCollection),
    );

    const bundle: vscode.Disposable = {
      dispose: () => {
        assetSyncGeneration++;
        disposables.forEach((d) => d.dispose());
      },
    };
    if (currentSetupEpoch(key) !== epochAtStart) {
      bundle.dispose();
      return;
    }
    setupsByProject.set(key, bundle);
  })();

  setupInflight.set(key, run);
  try {
    await run;
  } finally {
    setupInflight.delete(key);
  }
}
