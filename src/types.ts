import * as vscode from 'vscode';

export interface UEInstallation {
  version: string;
  root: string;
  source: 'registry' | 'path-scan' | 'manual';
  ubtPath: string;
  editorPath: string;
  isSourceBuild: boolean;
}

export interface UEProject {
  name: string;
  uprojectPath: string;
  projectRoot: string;
  engineAssociation: string;
  modules: UEProjectModule[];
}

export interface UEProjectModule {
  name: string;
  type: string;
  loadingPhase: string;
}

export interface UProjectData {
  fileVersion: number;
  engineAssociation: string;
  modules: UEProjectModule[];
}

export type BuildConfiguration = 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test';
export type BuildTargetType = 'Editor' | 'Game' | 'Client' | 'Server';
export type BuildPlatform = 'Win64' | 'Linux' | 'Mac';

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UE5_8CursorContext {
  project: UEProject | undefined;
  engine: UEInstallation | undefined;
  outputChannel: vscode.OutputChannel;
  diagnosticCollection: vscode.DiagnosticCollection;
}

/** @deprecated Use UE5_8CursorContext */
export type UE58RiderContext = UE5_8CursorContext;

export interface ParsedBuildDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface UE5_8CursorTaskDefinition {
  type: 'ue58rider';
  action: 'build' | 'rebuild' | 'clean' | 'generateCompileCommands';
}

/** @deprecated Use UE5_8CursorTaskDefinition */
export type UE58RiderTaskDefinition = UE5_8CursorTaskDefinition;

export interface UBTCommandLine {
  executable: string;
  args: string[];
}

export interface PrerequisiteCheck {
  name: string;
  ok: boolean;
  detail: string;
  fixHint?: string;
}
