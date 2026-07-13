import * as vscode from 'vscode';
import type { EditorBridgeClient } from './editorBridgeClient';
import { withBridgeTimeout } from './editorBridgeClient';
import { startBlueprintCompileDiagnosticsWatch } from '../blueprint/blueprintCompileDiagnostics';

const setupsByProject = new Map<string, vscode.Disposable>();

/** Tear down bridge polling timers for a project (or all projects). */
export function disposeBridgeConnectedSetup(projectRoot?: string): void {
  if (projectRoot) {
    setupsByProject.get(projectRoot.toLowerCase())?.dispose();
    setupsByProject.delete(projectRoot.toLowerCase());
    return;
  }
  for (const disposable of setupsByProject.values()) disposable.dispose();
  setupsByProject.clear();
}

export function isBridgeSetupActive(projectRoot: string): boolean {
  return setupsByProject.has(projectRoot.toLowerCase());
}

/** Start bridge services only when not already running for this project. */
export async function ensureBridgeServicesForProject(
  projectRoot: string,
  getBridge: () => EditorBridgeClient | undefined,
  diagnosticCollection: vscode.DiagnosticCollection,
): Promise<void> {
  if (isBridgeSetupActive(projectRoot)) return;
  await setupBridgeConnectedServices(projectRoot, getBridge, diagnosticCollection);
}

/** Bootstrap asset index sync and bridge polling after a successful handshake. */
export async function setupBridgeConnectedServices(
  projectRoot: string,
  getBridge: () => EditorBridgeClient | undefined,
  diagnosticCollection: vscode.DiagnosticCollection,
): Promise<void> {
  const key = projectRoot.toLowerCase();
  setupsByProject.get(key)?.dispose();

  const disposables: vscode.Disposable[] = [];
  let assetDeltaSince = 0;
  let deltaPollInFlight = false;

  const bridge = getBridge();
  if (!bridge?.isConnected()) return;

  try {
    const bridgeResult = await withBridgeTimeout(bridge.queryAllAssets(), 15_000);
    if (bridgeResult?.length) {
      const { refreshAssetIndex } = await import('../assets/assetIndex');
      await refreshAssetIndex(projectRoot, { bridgeAssets: bridgeResult });
    }
    const handshake = await bridge.queryAssetDelta(0);
    assetDeltaSince = handshake.since;
  } catch {
    // optional full sync
  }

  const deltaTimer = setInterval(() => {
    void (async () => {
      if (deltaPollInFlight) return;
      const activeBridge = getBridge();
      if (!activeBridge?.isConnected()) return;
      deltaPollInFlight = true;
      try {
        const delta = await activeBridge.queryAssetDelta(assetDeltaSince);
        if (delta.added.length || delta.removed.length || delta.updated.length) {
          const { applyBridgeAssetDelta } = await import('../assets/assetIndex');
          await applyBridgeAssetDelta(projectRoot, delta);
        }
        assetDeltaSince = delta.since;
      } catch {
        // optional delta sync — keep prior cursor on failure
      } finally {
        deltaPollInFlight = false;
      }
    })();
  }, 30_000);
  disposables.push({ dispose: () => clearInterval(deltaTimer) });

  disposables.push(startBlueprintCompileDiagnosticsWatch(getBridge, diagnosticCollection));

  const bundle: vscode.Disposable = { dispose: () => disposables.forEach((d) => d.dispose()) };
  setupsByProject.set(key, bundle);
}
