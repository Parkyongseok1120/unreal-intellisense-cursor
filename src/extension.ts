import * as vscode from 'vscode';
import * as path from 'path';
import { EXTENSION_ID, Commands, ContextKeys } from './constants';
import { UE5_8CursorSettings } from './config/settings';
import { StatusBarManager } from './ui/statusBar';
import { createOutputChannel } from './ui/outputChannel';
import { detectProjects, resolvePrimaryProject, watchForProjectChanges } from './detection/projectDetector';
import {
  discoverEngines,
  findMatchingEngine,
  promptSelectEngine,
  createManualInstallation,
} from './detection/engineDiscovery';
import { BlueprintCodeLensProvider } from './blueprint/blueprintCodeLens';
import { UFunctionCodeLensProvider } from './providers/ufunctionCodeLens';
import { GeneratedHeaderDefinitionProvider } from './providers/generatedHeaderProvider';
import { UE5_8CursorTaskProvider } from './build/taskProvider';
import { UnrealLogViewer } from './logs/unrealLogViewer';
import { CommandBridge } from './mcp/commandBridge';
import { configureMcpBridge } from './blueprint/mcpBlueprintBridge';
import { parseBuildProgress } from './parsers/buildProgressParser';
import { ProjectSession } from './session/projectSession';
import { getWorkspaceProjectRegistry, disposeWorkspaceProjectRegistry, type ProjectRuntime } from './session/workspaceProjectRegistry';
import { getExtensionVersion } from './version';
import { refreshSemanticGraph, computeCompileParity, invalidateSemanticGraph } from './semantic/semanticService';
import { registerSemanticNavigation } from './semantic/semanticNavigation';
import { registerUeNavigationCommands } from './navigation/ueNavigationCommands';
import { EditorBridgeClient, formatBridgeStatus, withBridgeTimeout } from './editorBridge/editorBridgeClient';
import {
  formatInstallPreview,
  installCursorBridgePlugin,
  isCursorBridgePluginInstalled,
  listCursorBridgePluginFiles,
} from './editorBridge/editorBridgeRpc';
import { UhtCodeActionProvider } from './uht/uhtCodeActionProvider';
import { disposeUhtDiagnostics } from './uht/uhtDiagnostics';
import { registerUhtSaveValidation } from './uht/uhtValidation';
import { registerHLSLProviders } from './hlsl/hlslProviders';
import { UnrealTestExplorer } from './testing/unrealTestExplorer';
import type { UE5_8CursorContext } from './types';
import { requestClangdRestart } from './cursor/clangdLifecycle';
import {
  disposeIntelliSenseMetrics,
  getIntelliSenseMetricsTracker,
  startIntelliSenseMetricsRun,
} from './telemetry/intellisenseMetrics';

let ctx: UE5_8CursorContext;
let settings: UE5_8CursorSettings;
let statusBar: StatusBarManager;
let logViewer: UnrealLogViewer;
let commandBridge: CommandBridge | undefined;
let projectSession: ProjectSession | undefined;
let editorBridge: EditorBridgeClient | undefined;
let testExplorer: UnrealTestExplorer | undefined;
let contentBrowser: import('./assets/contentBrowserProvider').ContentBrowserProvider | undefined;
let mcpDiagnostics: import('./mcp/mcpDiagnosticsProvider').McpDiagnosticsProvider | undefined;
let extensionPath = '';
let extensionContext: vscode.ExtensionContext | undefined;
let bridgeDispatchRoot: string | undefined;
let bridgeDispatchChain: Promise<void> = Promise.resolve();
const pluginIndexRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const headerCompileContextLog = new Map<string, string>();

function projectRegistry() {
  return getWorkspaceProjectRegistry();
}

function resolveRuntime(uri?: vscode.Uri): ProjectRuntime | undefined {
  const reg = projectRegistry();
  if (uri) return reg.getByUri(uri);
  // HTTP bridge requests have no editor URI. Their project root takes priority
  // over the focused document while the serialized dispatch is in progress.
  if (bridgeDispatchRoot) {
    const bridgeRuntime = reg.getByRoot(bridgeDispatchRoot);
    if (bridgeRuntime) return bridgeRuntime;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const byUri = reg.getByUri(activeUri);
    if (byUri) return byUri;
  }
  return reg.getActive();
}

function resolveProjectRoot(uri?: vscode.Uri): string | undefined {
  return resolveRuntime(uri)?.project.projectRoot ?? ctx?.project?.projectRoot;
}

/** Project-scoped view used by commands launched from the active editor. */
function runtimeContext(uri?: vscode.Uri): UE5_8CursorContext {
  const runtime = resolveRuntime(uri);
  if (!runtime) return ctx;
  return { ...ctx, project: runtime.project, engine: runtime.engine };
}

async function promoteOpenedPluginDocument(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== 'file' || !settings.clangdLazyPluginIndexing || !extensionPath) return;
  const runtime = resolveRuntime(document.uri);
  if (!runtime) return;

  const { promotePluginIndexing } = await import('./cursor/clangdConfig');
  const promotionStarted = performance.now();
  const promotion = await promotePluginIndexing(runtime.project.projectRoot, document.uri.fsPath, {
    lazyPluginIndexing: settings.clangdLazyPluginIndexing,
  });
  if (!promotion.changed || !promotion.pluginRoot) return;

  const { getCompileDbIndexPlan } = await import('./cursor/bootstrapProject');
  statusBar.setIndexPlan(await getCompileDbIndexPlan(runtime.project.projectRoot), promotion.promotedPluginRoots.length);
  ctx.outputChannel.appendLine(
    `[UE5_8 Cursor] Plugin indexing promoted: ${promotion.pluginRoot} (${promotion.promotedPluginRoots.length} active plugin root(s)).`,
  );
  const metrics = getIntelliSenseMetricsTracker(runtime.project.projectRoot);
  metrics?.markPluginPromotion(Math.round(performance.now() - promotionStarted));
  statusBar.setIndexingPhase('plugin-indexing');

  const existingTimer = pluginIndexRestartTimers.get(runtime.project.projectRoot);
  if (existingTimer) clearTimeout(existingTimer);
  pluginIndexRestartTimers.set(runtime.project.projectRoot, setTimeout(() => {
    pluginIndexRestartTimers.delete(runtime.project.projectRoot);
    void requestClangdRestart(
      runtime.project.projectRoot,
      `plugin indexing promotion (${promotion.pluginRoot})`,
      (message) => ctx.outputChannel.appendLine(message),
    );
  }, 300));
}

async function reportHeaderCompileContext(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== 'file' || !/\.(?:h|hpp|inl)$/i.test(document.uri.fsPath)) return;
  const runtime = resolveRuntime(document.uri);
  if (!runtime) return;
  const { resolveHeaderCompileContext } = await import('./projectModel/headerCompileContext');
  const resolved = await resolveHeaderCompileContext(runtime.project.projectRoot, document.uri.fsPath);
  const key = document.uri.fsPath.toLowerCase();
  const fingerprint = `${resolved.provenance}:${resolved.translationUnit ?? ''}`;
  if (headerCompileContextLog.get(key) === fingerprint) return;
  if (resolved.provenance === 'authoritative-module-tu') {
    const { applyAuthoritativeHeaderCompileContext } = await import('./cursor/clangdHeaderContext');
    const applied = await applyAuthoritativeHeaderCompileContext(runtime.project.projectRoot, resolved);
    if (applied.applied) {
      headerCompileContextLog.set(key, fingerprint);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] Header compile context applied: ${document.uri.fsPath} <- ${resolved.translationUnit}`);
    } else {
      // Do not cache an unavailable/starting client. The next focus event can
      // safely retry without inventing a fallback command.
      headerCompileContextLog.delete(key);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] Header compile context provisional: ${document.uri.fsPath}. ${applied.reason}`);
    }
  } else {
    headerCompileContextLog.set(key, fingerprint);
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Header compile context provisional: ${document.uri.fsPath}. ${resolved.reason}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  extensionPath = context.extensionPath;
  settings = new UE5_8CursorSettings();
  statusBar = new StatusBarManager();
  logViewer = new UnrealLogViewer();
  projectSession = new ProjectSession();
  editorBridge = new EditorBridgeClient(undefined, context);
  testExplorer = new UnrealTestExplorer();
  const outputChannel = createOutputChannel();

  ctx = {
    project: undefined,
    engine: undefined,
    outputChannel,
    diagnosticCollection: vscode.languages.createDiagnosticCollection(EXTENSION_ID),
  };

  extensionContext.subscriptions.push(outputChannel, statusBar, logViewer, ctx.diagnosticCollection);
  if (projectSession) extensionContext.subscriptions.push(projectSession);
  if (editorBridge) extensionContext.subscriptions.push(editorBridge);
  if (testExplorer) extensionContext.subscriptions.push(testExplorer);

  registerSemanticNavigation(extensionContext, (doc) => resolveRuntime(doc.uri)?.project, settings);
  registerUeNavigationCommands(extensionContext, () => resolveRuntime()?.project);

  if (settings.experimentalHlsl) {
    registerHLSLProviders(extensionContext);
  }
  registerCommands(extensionContext);

  const { registerUprojectOpenHandler } = await import('./providers/uprojectOpenHandler');
  registerUprojectOpenHandler(extensionContext);

  const { registerContentBrowser } = await import('./assets/contentBrowserProvider');
  contentBrowser = registerContentBrowser(extensionContext);

  const { registerMcpDiagnostics } = await import('./mcp/mcpDiagnosticsProvider');
  mcpDiagnostics = registerMcpDiagnostics(extensionContext, () => resolveProjectRoot());

  const {
    AssetPathDocumentLinkProvider,
    AssetPathDefinitionProvider,
    AssetPathCodeLensProvider,
  } = await import('./providers/assetPathProvider');
  const { AssetReferenceProvider } = await import('./providers/assetReferenceProvider');
  const { UPropertyCodeLensProvider, GeneratedSymbolHoverProvider } = await import('./uht/providers/uhtProviders');

  extensionContext.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new BlueprintCodeLensProvider(() => ctx),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new UFunctionCodeLensProvider(() => resolveProjectRoot()),
    ),
    vscode.languages.registerDefinitionProvider(
      { language: 'cpp', scheme: 'file' },
      new GeneratedHeaderDefinitionProvider((doc) => resolveRuntime(doc.uri)?.project),
    ),
    vscode.languages.registerDocumentLinkProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathDocumentLinkProvider(),
    ),
    vscode.languages.registerDefinitionProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathDefinitionProvider(() => resolveProjectRoot()),
    ),
    vscode.languages.registerReferenceProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetReferenceProvider(() => resolveProjectRoot()),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathCodeLensProvider(),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new UPropertyCodeLensProvider(() => resolveProjectRoot()),
    ),
    vscode.languages.registerHoverProvider(
      { language: 'cpp', scheme: 'file' },
      new GeneratedSymbolHoverProvider(() => resolveProjectRoot()),
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: 'cpp', scheme: 'file' },
      new UhtCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.tasks.registerTaskProvider(
      UE5_8CursorTaskProvider.type,
      new UE5_8CursorTaskProvider(() => ctx, () => settings),
    ),
  );

  statusBar.startPolling();

  extensionContext.subscriptions.push(registerUhtSaveValidation((uri) => {
    const runtime = resolveRuntime(uri);
    return runtime ? { ctx: runtimeContext(uri), session: runtime.session } : undefined;
  }, settings));

  extensionContext.subscriptions.push(
    (await import('./detection/sourceWatcher')).watchSourceChanges(
      settings,
      (uri) => {
        const runtime = resolveRuntime(uri);
        return runtime ? { ctx: runtimeContext(uri), key: runtime.project.projectRoot } : undefined;
      },
      (runtime) => {
        const owner = projectRegistry().getByRoot(runtime.ctx.project!.projectRoot);
        if (owner) void scheduleCompileRefresh(runtime.ctx, owner.session);
      },
      (runtime, headers) => {
        const owner = projectRegistry().getByRoot(runtime.ctx.project!.projectRoot);
        if (!owner) return;
        for (const h of headers) {
          void import('./uht/uhtValidation').then(({ scheduleUhtValidation }) =>
            scheduleUhtValidation(runtime.ctx, owner.session, h, settings),
          );
        }
      },
      (runtime) => {
        const owner = projectRegistry().getByRoot(runtime.ctx.project!.projectRoot);
        if (!owner) return;
        const gen = owner.session.getGeneration();
        const token = owner.session.getActiveToken() ?? new vscode.CancellationTokenSource().token;
        void owner.session.runJob('detection', runtime.ctx.project!.projectRoot, gen, token, async () => {
          invalidateSemanticGraph(runtime.ctx.project!.projectRoot);
          await refreshSemanticGraph(runtime.ctx.project!, {
            engine: runtime.ctx.engine,
            targetType: settings.buildTarget,
            platform: settings.platform,
            configuration: settings.buildConfiguration,
          });
        });
      },
    ),
  );

  outputChannel.appendLine(`[UE5_8 Cursor] Activating UE 5.8 development environment (v${getExtensionVersion(extensionPath)})...`);
  configureMcpBridge(undefined, extensionPath);
  await runDetectionPipeline({ allowAutoSetup: true });

  if (settings.showWelcomeOnFirstOpen && !extensionContext.globalState.get('ue58rider.welcomeShown')) {
    extensionContext.globalState.update('ue58rider.welcomeShown', true);
    const { showWelcomePanel } = await import('./ui/welcomePanel');
    void showWelcomePanel(settings);
  }

  extensionContext.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) {
        projectRegistry().disposeUnder(folder.uri.fsPath);
      }
    }),
  );
  extensionContext.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const runtime = resolveRuntime(editor.document.uri);
      if (!runtime) return;
      projectRegistry().setActive(runtime.project.projectRoot);
      commandBridge = runtime.session.getBridge();
      contentBrowser?.setProjectRoot(runtime.project.projectRoot);
      testExplorer?.setRuntime(runtime.project.projectRoot, runtime.editorBridge);
      void testExplorer?.refresh(runtimeContext(editor.document.uri));
      void promoteOpenedPluginDocument(editor.document);
      void reportHeaderCompileContext(editor.document);
    }),
  );
  extensionContext.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void promoteOpenedPluginDocument(document);
      void reportHeaderCompileContext(document);
    }),
  );

  extensionContext.subscriptions.push(watchForProjectChanges(() => runDetectionPipeline()));
  extensionContext.subscriptions.push(
    settings.onDidChange(() => {
      void statusBar.update(ctx, settings);
      if (ctx.project) {
        void openContentBrowserForProject({ reopen: false });
      }
      runDetectionPipeline();
    }),
  );

  outputChannel.appendLine('[UE5_8 Cursor] Ready.');
  if (vscode.window.activeTextEditor) {
    void promoteOpenedPluginDocument(vscode.window.activeTextEditor.document);
    void reportHeaderCompileContext(vscode.window.activeTextEditor.document);
  }
}

export function deactivate(): void {
  commandBridge?.dispose();
  projectSession?.dispose();
  editorBridge?.dispose();
  testExplorer?.dispose();
  disposeUhtDiagnostics();
  disposeIntelliSenseMetrics();
  disposeWorkspaceProjectRegistry();
}

async function openContentBrowserForProject(options?: { reopen?: boolean }): Promise<void> {
  const commandCtx = runtimeContext();
  if (!commandCtx.project) return;
  const { openContentBrowserByUiMode, createOpenAssetHandler } = await import('./assets/contentBrowserUi');
  if (options?.reopen !== false || settings.contentBrowserUi !== 'tree') {
    await openContentBrowserByUiMode(
      commandCtx.project.projectRoot,
      settings,
      createOpenAssetHandler(),
      extensionContext,
    );
  }
}

async function scheduleCompileRefresh(commandCtx = runtimeContext(), session = resolveRuntime()?.session ?? projectSession): Promise<void> {
  if (!session || !commandCtx.project || !extensionPath) return;
  const gen = session.getGeneration();
  const token = session.getActiveToken() ?? new vscode.CancellationTokenSource().token;
  await session.runJob('compileRefresh', commandCtx.project.projectRoot, gen, token, async () => {
    await runSilentCompileRefresh(commandCtx, session, gen);
  });
}

async function runSilentCompileRefresh(commandCtx: UE5_8CursorContext, session: ProjectSession, pipelineGeneration: number): Promise<void> {
  if (!commandCtx.project || !extensionPath) return;
  if (session.isStale(pipelineGeneration)) return;
  const { ensureCompileDatabase } = await import('./cursor/bootstrapProject');
  const result = await ensureCompileDatabase(
    commandCtx,
    settings,
    extensionPath,
    (msg) => commandCtx.outputChannel.appendLine(msg),
    { force: true, token: session.getActiveToken() },
  );
  if (session.isStale(pipelineGeneration)) return;
  statusBar.setIntelliSense(result.mode);
  void statusBar.update(commandCtx, settings);
  await requestClangdRestart(commandCtx.project.projectRoot, 'compile database refresh', (msg) => commandCtx.outputChannel.appendLine(msg));
}

/**
 * Run the UHT cache warm-up (UBT Editor build) in the background with a progress
 * notification, then regenerate compile_commands from the now-warm cache and
 * upgrade IntelliSense to 'ready' — without ever blocking editor activation.
 */
async function scheduleBackgroundCacheWarmup(pipelineGeneration: number): Promise<void> {
  if (!projectSession || !ctx.project || !extensionPath) return;
  const token = projectSession.getActiveToken() ?? new vscode.CancellationTokenSource().token;
  await projectSession.runJob('warmup', ctx.project.projectRoot, pipelineGeneration, token, async () => {
    await runBackgroundCacheWarmup(pipelineGeneration, token);
  });
}

async function runBackgroundCacheWarmup(
  pipelineGeneration: number,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!ctx.project || !extensionPath || !projectSession) return;
  const log = (msg: string) => ctx.outputChannel.appendLine(msg);
  try {
    const { runCacheWarmup, ensureCompileDatabase } = await import('./cursor/bootstrapProject');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'UE5_8 Cursor: UHT 캐시 생성 중 (IntelliSense 정확도 향상)',
        cancellable: false,
      },
      async (progress) => {
        await runCacheWarmup(ctx, settings, log, (line) => {
          const p = parseBuildProgress(line);
          if (p) {
            const pct = Math.round((p.current / p.total) * 100);
            progress.report({ message: `${p.current}/${p.total} (${pct}%)` });
            statusBar.setBuildProgress(p.current, p.total);
          }
        }, token);
        if (projectSession!.isStale(pipelineGeneration) || token.isCancellationRequested) return;
        statusBar.clearBuildProgress();
        progress.report({ message: 'compile_commands 재생성 중...' });
        const result = await ensureCompileDatabase(ctx, settings, extensionPath, log, {
          force: true,
          token,
        });
        if (projectSession!.isStale(pipelineGeneration) || token.isCancellationRequested) return;
        const { ensureUhtIntellisense } = await import('./cursor/projectSetup');
        await ensureUhtIntellisense(ctx.project!, extensionPath, undefined, { lazyPluginIndexing: settings.clangdLazyPluginIndexing });
        statusBar.setIntelliSense(result.mode);
        void statusBar.update(ctx, settings);
        await requestClangdRestart(ctx.project!.projectRoot, 'UHT cache warm-up', log);
      },
    );
  } catch (err) {
    log(`[UE5_8 Cursor] Background cache warm-up failed: ${err}`);
    statusBar.clearBuildProgress();
  }
}

async function runDetectionPipeline(options?: { allowAutoSetup?: boolean }): Promise<void> {
  if (!projectSession) return;
  await projectSession.runPipeline(async (runOptions, token) => {
    await executeDetectionPipeline(runOptions, token);
  }, options);
}

async function executeDetectionPipeline(
  options: { allowAutoSetup?: boolean },
  token: vscode.CancellationToken,
): Promise<void> {
  if (token.isCancellationRequested || !projectSession) return;
  const gen = projectSession.getGeneration();

  const projects = await detectProjects();
  projectSession.markLoadingProjectModel();

  if (projects.length === 0) {
    ctx.outputChannel.appendLine('[UE5_8 Cursor] No UE 5.8 .uproject found in workspace.');
    await setContext(ContextKeys.ProjectDetected, false);
    ctx.project = undefined;
    statusBar.setIntelliSense('missing');
    void statusBar.update(ctx, settings);
    return;
  }

  if (settings.projectFile) {
    ctx.project = projects.find((p) => p.uprojectPath === settings.projectFile) ?? projects[0];
  } else {
    ctx.project = await resolvePrimaryProject(projects);
  }

  if (!ctx.project) {
    await setContext(ContextKeys.ProjectDetected, false);
    statusBar.setIntelliSense('missing');
    void statusBar.update(ctx, settings);
    return;
  }

  if (token.isCancellationRequested || projectSession.isStale(gen)) return;

  await setContext(ContextKeys.ProjectDetected, true);
  ctx.outputChannel.appendLine(`[UE5_8 Cursor] Project: ${ctx.project.name} (${ctx.project.projectRoot})`);

  configureMcpBridge(ctx.project.projectRoot, extensionPath);
  contentBrowser?.setProjectRoot(ctx.project.projectRoot);

  let discoveredEngines: Awaited<ReturnType<typeof discoverEngines>> = [];
  if (settings.engineRoot) {
    ctx.engine = (await createManualInstallation(settings.engineRoot)) ?? undefined;
  } else {
    discoveredEngines = await discoverEngines();
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Found ${discoveredEngines.length} UE 5.8 engine(s).`);
    ctx.engine = await findMatchingEngine(ctx.project, discoveredEngines);
    if (!ctx.engine && discoveredEngines.length === 1) {
      ctx.engine = discoveredEngines[0];
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] Engine auto-selected: ${ctx.engine.root}`);
    } else if (!ctx.engine && discoveredEngines.length > 1) {
      ctx.engine = await promptSelectEngine(discoveredEngines);
    }
  }

  // Register every discovered project. Providers resolve a runtime from the
  // active document URI, so secondary workspace folders must exist here even
  // when the UI chooses a different primary project.
  for (const project of projects) {
    const runtimeEngine =
      project.projectRoot === ctx.project.projectRoot
        ? ctx.engine
        : settings.engineRoot
          ? ctx.engine
          : await findMatchingEngine(project, discoveredEngines);
    projectRegistry().ensure(project, runtimeEngine, extensionContext);
  }

  const runtime = projectRegistry().getByRoot(ctx.project.projectRoot)!;
  projectRegistry().setActive(ctx.project.projectRoot);
  // This pipeline was started by the current global session. Replacing it while
  // the run is in flight makes later generation checks compare against a fresh
  // session and abort first activation as stale. Gate 2 routes whole pipelines
  // through ProjectRuntime; retain the owning session for this run until then.
  editorBridge = runtime.editorBridge;

  if (editorBridge) {
    const bridgeInfo = await withBridgeTimeout(editorBridge.connect(ctx.project.projectRoot), 5000);
    if (bridgeInfo) {
      testExplorer?.setRuntime(ctx.project.projectRoot, editorBridge);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] ${formatBridgeStatus(bridgeInfo)}`);
      statusBar.setBridgeStatus(bridgeInfo);
      if (bridgeInfo.connected) {
        try {
          const bridgeResult = await withBridgeTimeout(editorBridge.queryAssets(), 5000);
          if (bridgeResult?.assets?.length) {
            const { refreshAssetIndex } = await import('./assets/assetIndex');
            await refreshAssetIndex(ctx.project.projectRoot, { bridgeAssets: bridgeResult.assets });
          }
        } catch {
          // bridge asset sync optional
        }
      }
    }
  }
  testExplorer?.setRuntime(ctx.project.projectRoot, editorBridge);
  void testExplorer?.refresh(ctx);

  if (ctx.project) {
    const graph = await refreshSemanticGraph(ctx.project, {
      engine: ctx.engine,
      targetType: settings.buildTarget,
      platform: settings.platform,
      configuration: settings.buildConfiguration,
    });
    ctx.outputChannel.appendLine(
      `[UE5_8 Cursor] Semantic graph: ${graph.modules.length} module(s), ${graph.reflection.length} class(es), ${graph.plugins.length} plugin(s)`,
    );
    const parity = await computeCompileParity(ctx.project, {
      engine: ctx.engine,
      targetType: settings.buildTarget,
      platform: settings.platform,
      configuration: settings.buildConfiguration,
    });
    statusBar.setCompileParity(parity.parity, parity.synthetic, {
      status: parity.status,
      provenance: parity.provenance,
    });
    if (parity.synthetic && parity.total > 0) {
      ctx.outputChannel.appendLine(
        `[UE5_8 Cursor] Compile action parity: ${Math.round(parity.parity * 100)}% (synthetic DB)`,
      );
    }
  }

  if (token.isCancellationRequested || projectSession.isStale(gen)) return;

  await setContext(ContextKeys.EngineFound, !!ctx.engine);
  if (ctx.engine) {
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Engine: ${ctx.engine.root}`);
  } else {
    ctx.outputChannel.appendLine('[UE5_8 Cursor] Engine not found — workspace artifacts only (set ue58rider.engineRoot).');
  }

  void mcpDiagnostics?.refresh();

  if (ctx.project && options?.allowAutoSetup !== false && settings.autoSetupOnOpen && extensionPath) {
    projectSession?.markRefreshing();
    const metricsProjectRoot = ctx.project.projectRoot;
    const metrics = await startIntelliSenseMetricsRun(metricsProjectRoot, {
      onPhase: (phase, snapshot) => {
        if (resolveRuntime()?.project.projectRoot === metricsProjectRoot) {
          statusBar.setIndexingPhase(phase, {
            projectUsableMeasured: snapshot.timings.projectUsableMs !== undefined,
            privateMemoryBudget: snapshot.acceptance.privateMemory,
          });
        }
      },
    });
    const { bootstrapProject } = await import('./cursor/bootstrapProject');
    const result = await bootstrapProject(ctx, settings, extensionPath);
    metrics.markCompileDatabaseReady();
    if (result.indexPlan) metrics.markProjectModelReady(result.indexPlan);
    statusBar.setIndexPlan(result.indexPlan);
    const metricsSnapshot = metrics.snapshot();
    statusBar.setIndexingPhase(metricsSnapshot.phase, {
      projectUsableMeasured: metricsSnapshot.timings.projectUsableMs !== undefined,
      privateMemoryBudget: metricsSnapshot.acceptance.privateMemory,
    });
    statusBar.setIntelliSense(result.intelliSense, { provisional: result.intelliSense === 'partial' });
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        ctx.outputChannel.appendLine(`[UE5_8 Cursor] Bootstrap note: ${err}`);
      }
    }
    if (result.warmupPending) {
      projectSession.markWarmingUht();
      void scheduleBackgroundCacheWarmup(gen);
    }
  }

  projectSession.markIndexing();
  void statusBar.update(ctx, settings);

  if (ctx.project) {
    // CommandBridge is owned by each project runtime. Every discovered project
    // gets a separate authenticated endpoint and bridge file under its root.
    for (const project of projects) {
      const projectRuntime = projectRegistry().getByRoot(project.projectRoot);
      if (!projectRuntime) continue;
      const bridge = await projectRuntime.session.ensureBridge(project.projectRoot);
      if (project.projectRoot === ctx.project.projectRoot) commandBridge = bridge;
      if (bridge) {
        const { readBridgePort } = await import('./mcp/commandBridge');
        const port = await readBridgePort(project.projectRoot);
        ctx.outputChannel.appendLine(`[UE5_8 Cursor] MCP command bridge (${project.name}) on port ${port ?? 'unknown'}`);
      } else {
        ctx.outputChannel.appendLine(`[UE5_8 Cursor] Command bridge unavailable for ${project.name}`);
      }
    }

    if (settings.autoStartLogViewer) {
      void logViewer.start(ctx.project);
    }
  }
}

function registerCommands(extensionContext: vscode.ExtensionContext): void {
  const reg = (id: string, fn: () => Promise<void> | void) => {
    extensionContext.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  extensionContext.subscriptions.push(vscode.commands.registerCommand(
    'ue58rider.executeProjectBridgeCommand',
    async (request: { projectRoot?: string; command?: string; args?: unknown[] }) => {
      if (!request?.projectRoot || !request.command || !projectRegistry().getByRoot(request.projectRoot)) return;
      // Command handlers were intentionally written around runtimeContext().
      // Serialize bridge invocations so this temporary context cannot leak from
      // one project's authenticated endpoint into another project's command.
      const dispatch = bridgeDispatchChain.then(async () => {
        const previous = bridgeDispatchRoot;
        bridgeDispatchRoot = request.projectRoot;
        try {
          await vscode.commands.executeCommand(request.command!, ...(request.args ?? []));
        } finally {
          bridgeDispatchRoot = previous;
        }
      });
      bridgeDispatchChain = dispatch.catch(() => {});
      await dispatch;
    },
  ));

  reg(Commands.SetupProject, async () => {
    const { setupProject } = await import('./commands/setupCommands');
    const result = await setupProject(runtimeContext(), settings, extensionPath);
    if (result) {
      statusBar.setIndexPlan(result.indexPlan);
      statusBar.setIntelliSense(result.intelliSense, { provisional: result.intelliSense === 'partial' });
      void statusBar.update(ctx, settings);
    }
  });

  reg(Commands.Build, async () => {
    const { executeBuild } = await import('./commands/buildCommands');
    await executeBuild(runtimeContext(), settings, statusBar);
  });

  reg(Commands.Rebuild, async () => {
    const { executeRebuild } = await import('./commands/buildCommands');
    await executeRebuild(runtimeContext(), settings, statusBar);
  });

  reg(Commands.Clean, async () => {
    const { executeClean } = await import('./commands/buildCommands');
    await executeClean(runtimeContext(), settings, statusBar);
  });

  reg(Commands.LaunchEditor, async () => {
    const { launchEditorDetached } = await import('./commands/launchCommands');
    const commandCtx = runtimeContext();
    await launchEditorDetached(commandCtx);
    if (commandCtx.project && settings.autoStartLogViewer) {
      setTimeout(() => void logViewer.start(commandCtx.project!), 3000);
    }
  });

  reg(Commands.LiveCoding, async () => {
    const { triggerLiveCoding } = await import('./commands/liveCodingCommand');
    await triggerLiveCoding(runtimeContext(), settings);
  });

  reg(Commands.GenerateCompileCommands, async () => {
    const commandCtx = runtimeContext();
    const metrics = commandCtx.project
      ? startIntelliSenseMetricsRun(commandCtx.project.projectRoot, {
        onPhase: (phase, snapshot) => statusBar.setIndexingPhase(phase, {
          projectUsableMeasured: snapshot.timings.projectUsableMs !== undefined,
          privateMemoryBudget: snapshot.acceptance.privateMemory,
        }),
      })
      : undefined;
    const { generateCompileCommands } = await import('./commands/setupCommands');
    const mode = await generateCompileCommands(commandCtx, settings, extensionPath);
    if (commandCtx.project) {
      const { getCompileDbIndexPlan } = await import('./cursor/bootstrapProject');
      const plan = await getCompileDbIndexPlan(commandCtx.project.projectRoot);
      metrics?.markCompileDatabaseReady();
      metrics?.markProjectModelReady(plan);
      statusBar.setIndexPlan(plan);
      const snapshot = metrics?.snapshot();
      statusBar.setIndexingPhase(snapshot?.phase, {
        projectUsableMeasured: snapshot?.timings.projectUsableMs !== undefined,
        privateMemoryBudget: snapshot?.acceptance.privateMemory,
      });
    }
    statusBar.setIntelliSense(mode);
    void statusBar.update(ctx, settings);
  });

  reg(Commands.CaptureDiagnosticBaseline, async () => {
    const { captureDiagnosticsForProject } = await import('./commands/gate4Commands');
    await captureDiagnosticsForProject(runtimeContext());
  });

  reg(Commands.BenchmarkIntelliSense, async () => {
    const { benchmarkActiveDefinition } = await import('./commands/gate4Commands');
    const commandCtx = runtimeContext();
    await benchmarkActiveDefinition(commandCtx);
    if (commandCtx.project) {
      const snapshot = getIntelliSenseMetricsTracker(commandCtx.project.projectRoot)?.snapshot();
      statusBar.setIndexingPhase(snapshot?.phase, {
        projectUsableMeasured: snapshot?.timings.projectUsableMs !== undefined,
        privateMemoryBudget: snapshot?.acceptance.privateMemory,
      });
    }
  });

  reg(Commands.ShowIntelliSenseMetrics, async () => {
    const { showLatestIntelliSenseMetrics } = await import('./commands/gate4Commands');
    await showLatestIntelliSenseMetrics(runtimeContext());
  });

  reg(Commands.SwitchHeaderSource, async () => {
    const { switchHeaderSource } = await import('./commands/headerSourceSwitch');
    await switchHeaderSource();
  });

  reg(Commands.SelectEngine, async () => {
    const engines = await discoverEngines();
    const picked = await promptSelectEngine(engines);
    if (picked) {
      ctx.engine = picked;
      await setContext(ContextKeys.EngineFound, true);
      void statusBar.update(ctx, settings);
      await runDetectionPipeline();
    }
  });

  reg(Commands.SelectProject, async () => {
    const projects = await detectProjects();
    const { selectProject } = await import('./detection/projectDetector');
    const picked = await selectProject(projects);
    if (picked) {
      ctx.project = picked;
      void statusBar.update(ctx, settings);
      await runDetectionPipeline();
    }
  });

  reg(Commands.SelectBuildConfig, async () => {
    const configs = ['Debug', 'DebugGame', 'Development', 'Shipping', 'Test'];
    const picked = await vscode.window.showQuickPick(configs, { placeHolder: '빌드 구성 선택' });
    if (picked) {
      await vscode.workspace.getConfiguration('ue58rider').update('buildConfiguration', picked);
    }
  });

  reg(Commands.ShowProjectInfo, async () => {
    const { showProjectInfo } = await import('./commands/infoCommands');
    await showProjectInfo(ctx, settings);
  });

  reg(Commands.CheckPrerequisites, async () => {
    const { runPrerequisiteCheck } = await import('./commands/infoCommands');
    await runPrerequisiteCheck(settings);
  });

  reg(Commands.ApplyExplorerFilter, async () => {
    if (!ctx.project) return;
    const { applyExplorerFilter } = await import('./cursor/workspaceSetup');
    await applyExplorerFilter(ctx.project);
    vscode.window.showInformationMessage('UE5_8 Cursor: Explorer 필터 적용됨.');
  });

  reg(Commands.ResetExplorerFilter, async () => {
    if (!ctx.project) return;
    const { removeExplorerFilter } = await import('./cursor/workspaceSetup');
    await removeExplorerFilter(ctx.project);
    vscode.window.showInformationMessage('UE5_8 Cursor: Explorer 필터 해제됨.');
  });

  reg(Commands.DebugLaunchEditor, async () => {
    const { debugLaunchEditor } = await import('./commands/debugCommands');
    await debugLaunchEditor(runtimeContext(), settings);
  });

  reg(Commands.DebugAttachEditor, async () => {
    const { debugAttachEditor } = await import('./commands/debugCommands');
    await debugAttachEditor(runtimeContext(), settings);
  });

  reg(Commands.DebugLaunchGame, async () => {
    const { debugLaunchGame } = await import('./commands/debugCommands');
    await debugLaunchGame(runtimeContext(), settings);
  });

  reg(Commands.DebugPIE, async () => {
    const { debugPIE } = await import('./commands/debugCommands');
    await debugPIE(runtimeContext(), settings);
  });

  reg(Commands.DebugMultiplayer, async () => {
    const players = await vscode.window.showInputBox({
      prompt: 'Number of PIE clients',
      value: '2',
      validateInput: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? undefined : 'Enter a positive number'),
    });
    if (!players) return;
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Listen server + clients', id: 'listen' },
        { label: 'Dedicated server', id: 'dedicated' },
      ],
      { placeHolder: 'Multiplayer debug mode' },
    );
    if (!mode) return;
    const { launchMultiplayerDebug } = await import('./debug/multiplayerRun');
    await launchMultiplayerDebug(runtimeContext(), settings, {
      players: Number(players),
      listenServer: mode.id === 'listen',
      dedicatedServer: mode.id === 'dedicated',
    });
  });

  reg(Commands.NewCppClass, async () => {
    const { runClassWizard } = await import('./commands/classWizardCommand');
    await runClassWizard(runtimeContext(), settings);
  });

  reg(Commands.OpenBlueprint, async (assetPath?: string) => {
    const { openBlueprintInEditor } = await import('./blueprint/blueprintCodeLens');
    if (!assetPath) return;
    await openBlueprintInEditor(runtimeContext(), assetPath);
  });

  reg(Commands.FindBlueprints, async (className?: string) => {
    const { findAndPickBlueprint } = await import('./blueprint/blueprintCodeLens');
    if (!className) return;
    await findAndPickBlueprint(runtimeContext(), className);
  });

  reg(Commands.CreateBlueprintSubclass, async (className?: string) => {
    const { createBlueprintSubclass } = await import('./blueprint/blueprintCodeLens');
    if (!className) return;
    await createBlueprintSubclass(runtimeContext(), className);
  });

  reg(Commands.JumpToCppFromBlueprint, async () => {
    const { jumpToCppFromBlueprint } = await import('./blueprint/blueprintCodeLens');
    await jumpToCppFromBlueprint(runtimeContext());
  });

  reg(Commands.SetupMcp, async () => {
    const { setupMcpConfig } = await import('./commands/mcpCommands');
    await setupMcpConfig(ctx, settings, extensionPath);
  });

  reg(Commands.InstallCursorBridgePlugin, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: open a UE project first.');
      return;
    }
    if (isCursorBridgePluginInstalled(commandCtx.project)) {
      vscode.window.showInformationMessage('UE5_8 Cursor: UE58CursorBridge is already installed.');
      return;
    }
    const files = await listCursorBridgePluginFiles(extensionPath);
    const preview = formatInstallPreview(commandCtx.project, extensionPath, files);
    const consent = await vscode.window.showWarningMessage(
      'Install UE58CursorBridge editor plugin into this project?',
      { modal: true, detail: preview },
      'Install',
      'Cancel',
    );
    if (consent !== 'Install') return;

    const result = await installCursorBridgePlugin(commandCtx.project, {
      consentGranted: true,
      extensionPath,
      enableInUproject: true,
    });
    if (result.ok) {
      vscode.window.showInformationMessage(
        result.message ?? 'UE58CursorBridge installed. Restart the Unreal Editor to load the bridge.',
      );
      await runDetectionPipeline();
    } else {
      vscode.window.showErrorMessage(result.message ?? 'Failed to install UE58CursorBridge.');
    }
  });

  reg(Commands.VerifyMcp, async () => {
    const { verifyMcpConnection } = await import('./commands/mcpCommands');
    await verifyMcpConnection(ctx, settings, extensionPath);
  });

  reg(Commands.RefreshUhtIntellisense, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    const { ensureUhtIntellisense } = await import('./cursor/projectSetup');
    await ensureUhtIntellisense(commandCtx.project, extensionPath, undefined, { lazyPluginIndexing: settings.clangdLazyPluginIndexing });
    const { refreshAllIndexes } = await import('./assets/indexCoordinator');
    await refreshAllIndexes(commandCtx.project.projectRoot);
    void statusBar.update(ctx, settings);
    await requestClangdRestart(commandCtx.project.projectRoot, 'UHT IntelliSense refresh', (msg) => commandCtx.outputChannel.appendLine(msg));
    vscode.window.showInformationMessage('UE5_8 Cursor: UHT IntelliSense + 인덱스 갱신 완료');
  });

  reg(Commands.StartLogViewer, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    await logViewer.start(commandCtx.project);
  });

  reg(Commands.StopLogViewer, () => {
    logViewer.stop();
  });

  reg(Commands.ShowWelcome, async () => {
    const { showWelcomePanel } = await import('./ui/welcomePanel');
    await showWelcomePanel(settings);
  });

  reg(Commands.OpenMultiRootWorkspace, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    const { ensureMultiRootWorkspace } = await import('./cursor/multiRootWorkspace');
    const wsPath = await ensureMultiRootWorkspace(commandCtx.project);
    if (wsPath) {
      const open = await vscode.window.showInformationMessage(
        `UE5_8 Cursor: ${path.basename(wsPath)} 생성됨`,
        'Workspace 열기',
        '파일만 보기',
      );
      if (open === 'Workspace 열기') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), true);
      } else {
        const doc = await vscode.workspace.openTextDocument(wsPath);
        await vscode.window.showTextDocument(doc);
      }
    } else {
      vscode.window.showInformationMessage('UE5_8 Cursor: 멀티 루트 workspace가 이미 최신입니다.');
    }
  });

  reg(Commands.ShowUFunctionInfo, async (funcName?: string, flags?: string[]) => {
    if (!funcName) return;
    const flagStr = flags?.join(', ') ?? '';
    vscode.window.showInformationMessage(`UFUNCTION ${funcName}(${flagStr})`);
  });

  reg(Commands.FindUFunctionBlueprints, async (functionName?: string, className?: string, documentPath?: string) => {
    const { findUFunctionBlueprints } = await import('./commands/ufunctionCommands');
    if (!functionName) return;
    await findUFunctionBlueprints(ctx, functionName, className, documentPath);
  });

  reg(Commands.RefreshMcpSchema, async () => {
    const { refreshMcpSchema } = await import('./commands/mcpCommands');
    await refreshMcpSchema(ctx, settings, extensionPath);
  });

  reg(Commands.RefreshAssetIndex, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    const { refreshAllIndexes } = await import('./assets/indexCoordinator');
    const result = await refreshAllIndexes(commandCtx.project.projectRoot, { enrichMcp: true });
    await contentBrowser?.refresh();
    void statusBar.update(ctx, settings);
    vscode.window.showInformationMessage(
      `UE5_8 Cursor: 인덱스 갱신 완료 (Assets: ${result.assetCount}, UHT: ${result.reflectionClassCount})`,
    );
  });

  reg(Commands.OpenAsset, async (assetPath?: string | { entry?: { assetPath: string } }) => {
    const path =
      typeof assetPath === 'string' ? assetPath : assetPath?.entry?.assetPath;
    const commandCtx = runtimeContext();
    if (!path || !commandCtx.project || !commandCtx.engine) return;
    const { openAssetInEditor } = await import('./blueprint/blueprintEditor');
    await openAssetInEditor(commandCtx.engine, commandCtx.project, path);
  });

  reg(Commands.FindAssetReferences, async (assetPath?: string | { entry?: { assetPath: string } }) => {
    const path =
      typeof assetPath === 'string' ? assetPath : assetPath?.entry?.assetPath;
    const commandCtx = runtimeContext();
    if (!path || !commandCtx.project) return;
    const { showReferenceGraphPanel } = await import('./assets/referenceGraphPanel');
    await showReferenceGraphPanel(commandCtx.project.projectRoot, path, (p) => {
      void vscode.commands.executeCommand(Commands.OpenAsset, p);
    });
  });

  reg(Commands.ShowContentBrowser, async () => {
    await openContentBrowserForProject({ reopen: true });
  });

  reg(Commands.ShowMcpDiagnostics, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    const { showMcpDiagnostics } = await import('./mcp/mcpDiagnosticsProvider');
    await showMcpDiagnostics(commandCtx.project.projectRoot, ctx.outputChannel);
    await mcpDiagnostics?.refresh();
  });

  reg(Commands.FilterContentBrowser, async () => {
    if (!contentBrowser) return;
    const { pickClassFilter } = await import('./assets/contentBrowserProvider');
    const picked = await pickClassFilter(contentBrowser.getClassFilter());
    if (picked) contentBrowser.setClassFilter(picked);
  });

  reg(Commands.SearchAssets, async () => {
    if (!contentBrowser) return;
    const { promptAssetSearch } = await import('./assets/contentBrowserProvider');
    await promptAssetSearch(contentBrowser);
  });

  reg(Commands.CopyAssetPath, async (item?: vscode.TreeItem) => {
    const assetPath = typeof item?.tooltip === 'string' ? item.tooltip : undefined;
    if (assetPath) {
      await vscode.env.clipboard.writeText(assetPath);
      vscode.window.showInformationMessage(`복사됨: ${assetPath}`);
    }
  });

  reg(Commands.ShowContentWebview, async () => {
    const commandCtx = runtimeContext();
    if (!commandCtx.project) return;
    const { showContentBrowserWebview } = await import('./assets/contentBrowserWebview');
    await showContentBrowserWebview(
      commandCtx.project.projectRoot,
      (p) => void vscode.commands.executeCommand(Commands.OpenAsset, p),
      extensionContext,
      settings,
    );
  });
}

function setContext(key: string, value: unknown): Thenable<void> {
  return vscode.commands.executeCommand('setContext', key, value);
}

export function getContext(): UE5_8CursorContext {
  return ctx;
}
