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
import { getProjectSession, disposeAllProjectSessions } from './session/projectSessions';
import { getExtensionVersion } from './version';
import { refreshSemanticGraph, computeCompileParity, invalidateSemanticGraph } from './semantic/semanticService';
import { registerSemanticNavigation } from './semantic/semanticNavigation';
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

  registerSemanticNavigation(extensionContext, () => ctx.project);

  if (settings.experimentalHlsl) {
    registerHLSLProviders(extensionContext);
  }
  registerCommands(extensionContext);

  const { registerUprojectOpenHandler } = await import('./providers/uprojectOpenHandler');
  registerUprojectOpenHandler(extensionContext);

  const { registerContentBrowser } = await import('./assets/contentBrowserProvider');
  contentBrowser = registerContentBrowser(extensionContext);

  const { registerMcpDiagnostics } = await import('./mcp/mcpDiagnosticsProvider');
  mcpDiagnostics = registerMcpDiagnostics(extensionContext, () => ctx.project?.projectRoot);

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
      new UFunctionCodeLensProvider(() => ctx.project?.projectRoot),
    ),
    vscode.languages.registerDefinitionProvider(
      { language: 'cpp', scheme: 'file' },
      new GeneratedHeaderDefinitionProvider(() => ctx.project?.projectRoot),
    ),
    vscode.languages.registerDocumentLinkProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathDocumentLinkProvider(),
    ),
    vscode.languages.registerDefinitionProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathDefinitionProvider(() => ctx.project?.projectRoot),
    ),
    vscode.languages.registerReferenceProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetReferenceProvider(() => ctx.project?.projectRoot),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new AssetPathCodeLensProvider(),
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'cpp', scheme: 'file' },
      new UPropertyCodeLensProvider(() => ctx.project?.projectRoot),
    ),
    vscode.languages.registerHoverProvider(
      { language: 'cpp', scheme: 'file' },
      new GeneratedSymbolHoverProvider(() => ctx.project?.projectRoot),
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

  if (projectSession) {
    extensionContext.subscriptions.push(registerUhtSaveValidation(ctx, projectSession));
  }

  extensionContext.subscriptions.push(
    (await import('./detection/sourceWatcher')).watchSourceChanges(
      ctx,
      settings,
      () => {
        void scheduleCompileRefresh();
      },
      (headers) => {
        if (!projectSession) return;
        for (const h of headers) {
          void import('./uht/uhtValidation').then(({ scheduleUhtValidation }) =>
            scheduleUhtValidation(ctx, projectSession!, h),
          );
        }
      },
      () => {
        if (!ctx.project || !projectSession) return;
        const gen = projectSession.getGeneration();
        const token = projectSession.getActiveToken() ?? new vscode.CancellationTokenSource().token;
        void projectSession.runJob('detection', ctx.project.projectRoot, gen, token, async () => {
          invalidateSemanticGraph(ctx.project!.projectRoot);
          await refreshSemanticGraph(ctx.project!);
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
}

export function deactivate(): void {
  commandBridge?.dispose();
  projectSession?.dispose();
  editorBridge?.dispose();
  testExplorer?.dispose();
  disposeUhtDiagnostics();
  disposeAllProjectSessions();
}

async function openContentBrowserForProject(options?: { reopen?: boolean }): Promise<void> {
  if (!ctx.project) return;
  const { openContentBrowserByUiMode, createOpenAssetHandler } = await import('./assets/contentBrowserUi');
  if (options?.reopen !== false || settings.contentBrowserUi !== 'tree') {
    await openContentBrowserByUiMode(
      ctx.project.projectRoot,
      settings,
      createOpenAssetHandler(),
      extensionContext,
    );
  }
}

async function scheduleCompileRefresh(): Promise<void> {
  if (!projectSession || !ctx.project || !extensionPath) return;
  const gen = projectSession.getGeneration();
  const token = projectSession.getActiveToken() ?? new vscode.CancellationTokenSource().token;
  await projectSession.runJob('compileRefresh', ctx.project.projectRoot, gen, token, async () => {
    await runSilentCompileRefresh(gen);
  });
}

async function runSilentCompileRefresh(pipelineGeneration: number): Promise<void> {
  if (!ctx.project || !extensionPath || !projectSession) return;
  if (projectSession.isStale(pipelineGeneration)) return;
  const { ensureCompileDatabase } = await import('./cursor/bootstrapProject');
  const result = await ensureCompileDatabase(
    ctx,
    settings,
    extensionPath,
    (msg) => ctx.outputChannel.appendLine(msg),
    { force: true, token: projectSession.getActiveToken() },
  );
  if (projectSession.isStale(pipelineGeneration)) return;
  statusBar.setIntelliSense(result.mode);
  void statusBar.update(ctx, settings);
  try {
    await vscode.commands.executeCommand('clangd.restart');
  } catch {
    // clangd may not be active
  }
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
        await ensureUhtIntellisense(ctx.project!, extensionPath);
        statusBar.setIntelliSense(result.mode);
        void statusBar.update(ctx, settings);
        try {
          await vscode.commands.executeCommand('clangd.restart');
        } catch {
          // clangd may not be active
        }
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

  if (editorBridge) {
    const bridgeInfo = await withBridgeTimeout(editorBridge.connect(ctx.project.projectRoot), 5000);
    if (bridgeInfo) {
      testExplorer?.setBridge(editorBridge);
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
  void testExplorer?.refresh(ctx);

  if (ctx.project) {
    getProjectSession(ctx.project.projectRoot);
    const graph = await refreshSemanticGraph(ctx.project);
    ctx.outputChannel.appendLine(
      `[UE5_8 Cursor] Semantic graph: ${graph.modules.length} module(s), ${graph.reflection.length} class(es), ${graph.plugins.length} plugin(s)`,
    );
    const parity = await computeCompileParity(ctx.project);
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

  if (settings.engineRoot) {
    ctx.engine = (await createManualInstallation(settings.engineRoot)) ?? undefined;
  } else {
    const engines = await discoverEngines();
    ctx.outputChannel.appendLine(`[UE5_8 Cursor] Found ${engines.length} UE 5.8 engine(s).`);
    ctx.engine = await findMatchingEngine(ctx.project, engines);
    if (!ctx.engine && engines.length === 1) {
      ctx.engine = engines[0];
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] Engine auto-selected: ${ctx.engine.root}`);
    } else if (!ctx.engine && engines.length > 1) {
      ctx.engine = await promptSelectEngine(engines);
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
    const { bootstrapProject } = await import('./cursor/bootstrapProject');
    const result = await bootstrapProject(ctx, settings, extensionPath);
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

  if (ctx.project && projectSession) {
    commandBridge = await projectSession.ensureBridge(ctx.project.projectRoot);
    if (commandBridge) {
      const { readBridgePort } = await import('./mcp/commandBridge');
      const port = await readBridgePort(ctx.project.projectRoot);
      ctx.outputChannel.appendLine(`[UE5_8 Cursor] MCP command bridge on port ${port ?? 'unknown'}`);
    } else {
      ctx.outputChannel.appendLine('[UE5_8 Cursor] Command bridge unavailable');
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

  reg(Commands.SetupProject, async () => {
    const { setupProject } = await import('./commands/setupCommands');
    const result = await setupProject(ctx, settings, extensionPath);
    if (result) {
      statusBar.setIntelliSense(result.intelliSense, { provisional: result.intelliSense === 'partial' });
      void statusBar.update(ctx, settings);
    }
  });

  reg(Commands.Build, async () => {
    const { executeBuild } = await import('./commands/buildCommands');
    await executeBuild(ctx, settings, statusBar);
  });

  reg(Commands.Rebuild, async () => {
    const { executeRebuild } = await import('./commands/buildCommands');
    await executeRebuild(ctx, settings, statusBar);
  });

  reg(Commands.Clean, async () => {
    const { executeClean } = await import('./commands/buildCommands');
    await executeClean(ctx, settings, statusBar);
  });

  reg(Commands.LaunchEditor, async () => {
    const { launchEditorDetached } = await import('./commands/launchCommands');
    await launchEditorDetached(ctx);
    if (ctx.project && settings.autoStartLogViewer) {
      setTimeout(() => void logViewer.start(ctx.project!), 3000);
    }
  });

  reg(Commands.LiveCoding, async () => {
    const { triggerLiveCoding } = await import('./commands/liveCodingCommand');
    await triggerLiveCoding(ctx, settings);
  });

  reg(Commands.GenerateCompileCommands, async () => {
    const { generateCompileCommands } = await import('./commands/setupCommands');
    const mode = await generateCompileCommands(ctx, settings, extensionPath);
    statusBar.setIntelliSense(mode);
    void statusBar.update(ctx, settings);
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
    await debugLaunchEditor(ctx, settings);
  });

  reg(Commands.DebugAttachEditor, async () => {
    const { debugAttachEditor } = await import('./commands/debugCommands');
    await debugAttachEditor(ctx);
  });

  reg(Commands.DebugLaunchGame, async () => {
    const { debugLaunchGame } = await import('./commands/debugCommands');
    await debugLaunchGame(ctx, settings);
  });

  reg(Commands.DebugPIE, async () => {
    const { debugPIE } = await import('./commands/debugCommands');
    await debugPIE(ctx, settings);
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
    await launchMultiplayerDebug(ctx, settings, {
      players: Number(players),
      listenServer: mode.id === 'listen',
      dedicatedServer: mode.id === 'dedicated',
    });
  });

  reg(Commands.NewCppClass, async () => {
    const { runClassWizard } = await import('./commands/classWizardCommand');
    await runClassWizard(ctx, settings);
  });

  reg(Commands.OpenBlueprint, async (assetPath?: string) => {
    const { openBlueprintInEditor } = await import('./blueprint/blueprintCodeLens');
    if (!assetPath) return;
    await openBlueprintInEditor(ctx, assetPath);
  });

  reg(Commands.FindBlueprints, async (className?: string) => {
    const { findAndPickBlueprint } = await import('./blueprint/blueprintCodeLens');
    if (!className) return;
    await findAndPickBlueprint(ctx, className);
  });

  reg(Commands.CreateBlueprintSubclass, async (className?: string) => {
    const { createBlueprintSubclass } = await import('./blueprint/blueprintCodeLens');
    if (!className) return;
    await createBlueprintSubclass(ctx, className);
  });

  reg(Commands.JumpToCppFromBlueprint, async () => {
    const { jumpToCppFromBlueprint } = await import('./blueprint/blueprintCodeLens');
    await jumpToCppFromBlueprint(ctx);
  });

  reg(Commands.SetupMcp, async () => {
    const { setupMcpConfig } = await import('./commands/mcpCommands');
    await setupMcpConfig(ctx, settings, extensionPath);
  });

  reg(Commands.InstallCursorBridgePlugin, async () => {
    if (!ctx.project) {
      vscode.window.showWarningMessage('UE5_8 Cursor: open a UE project first.');
      return;
    }
    if (isCursorBridgePluginInstalled(ctx.project)) {
      vscode.window.showInformationMessage('UE5_8 Cursor: UE58CursorBridge is already installed.');
      return;
    }
    const files = await listCursorBridgePluginFiles(extensionPath);
    const preview = formatInstallPreview(ctx.project, extensionPath, files);
    const consent = await vscode.window.showWarningMessage(
      'Install UE58CursorBridge editor plugin into this project?',
      { modal: true, detail: preview },
      'Install',
      'Cancel',
    );
    if (consent !== 'Install') return;

    const result = await installCursorBridgePlugin(ctx.project, {
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
    if (!ctx.project) return;
    const { ensureUhtIntellisense } = await import('./cursor/projectSetup');
    await ensureUhtIntellisense(ctx.project, extensionPath);
    const { refreshAllIndexes } = await import('./assets/indexCoordinator');
    await refreshAllIndexes(ctx.project.projectRoot);
    void statusBar.update(ctx, settings);
    vscode.commands.executeCommand('clangd.restart');
    vscode.window.showInformationMessage('UE5_8 Cursor: UHT IntelliSense + 인덱스 갱신 완료');
  });

  reg(Commands.StartLogViewer, async () => {
    if (!ctx.project) return;
    await logViewer.start(ctx.project);
  });

  reg(Commands.StopLogViewer, () => {
    logViewer.stop();
  });

  reg(Commands.ShowWelcome, async () => {
    const { showWelcomePanel } = await import('./ui/welcomePanel');
    await showWelcomePanel(settings);
  });

  reg(Commands.OpenMultiRootWorkspace, async () => {
    if (!ctx.project) return;
    const { ensureMultiRootWorkspace } = await import('./cursor/multiRootWorkspace');
    const wsPath = await ensureMultiRootWorkspace(ctx.project);
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
    if (!ctx.project) return;
    const { refreshAllIndexes } = await import('./assets/indexCoordinator');
    const result = await refreshAllIndexes(ctx.project.projectRoot, { enrichMcp: true });
    await contentBrowser?.refresh();
    void statusBar.update(ctx, settings);
    vscode.window.showInformationMessage(
      `UE5_8 Cursor: 인덱스 갱신 완료 (Assets: ${result.assetCount}, UHT: ${result.reflectionClassCount})`,
    );
  });

  reg(Commands.OpenAsset, async (assetPath?: string | { entry?: { assetPath: string } }) => {
    const path =
      typeof assetPath === 'string' ? assetPath : assetPath?.entry?.assetPath;
    if (!path || !ctx.project || !ctx.engine) return;
    const { openAssetInEditor } = await import('./blueprint/blueprintEditor');
    await openAssetInEditor(ctx.engine, ctx.project, path);
  });

  reg(Commands.FindAssetReferences, async (assetPath?: string | { entry?: { assetPath: string } }) => {
    const path =
      typeof assetPath === 'string' ? assetPath : assetPath?.entry?.assetPath;
    if (!path || !ctx.project) return;
    const { showReferenceGraphPanel } = await import('./assets/referenceGraphPanel');
    await showReferenceGraphPanel(ctx.project.projectRoot, path, (p) => {
      void vscode.commands.executeCommand(Commands.OpenAsset, p);
    });
  });

  reg(Commands.ShowContentBrowser, async () => {
    await openContentBrowserForProject({ reopen: true });
  });

  reg(Commands.ShowMcpDiagnostics, async () => {
    if (!ctx.project) return;
    const { showMcpDiagnostics } = await import('./mcp/mcpDiagnosticsProvider');
    await showMcpDiagnostics(ctx.project.projectRoot, ctx.outputChannel);
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
    if (!ctx.project) return;
    const { showContentBrowserWebview } = await import('./assets/contentBrowserWebview');
    await showContentBrowserWebview(
      ctx.project.projectRoot,
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
