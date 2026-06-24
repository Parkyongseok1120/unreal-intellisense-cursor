import type { UEInstallation, UEProject, BuildConfiguration, BuildTargetType, BuildPlatform, UBTCommandLine } from '../types';
import { TARGET_SUFFIXES } from '../constants';

export function resolveTargetName(project: UEProject, targetType: BuildTargetType): string {
  return project.name + (TARGET_SUFFIXES[targetType] ?? '');
}

export function buildCommandLine(
  engine: UEInstallation,
  project: UEProject,
  options: {
    configuration: BuildConfiguration;
    targetType: BuildTargetType;
    platform: BuildPlatform;
    editorRunning?: boolean;
    additionalArgs?: string[];
  },
): UBTCommandLine {
  const args = [
    resolveTargetName(project, options.targetType),
    options.platform,
    options.configuration,
    `-project=${project.uprojectPath}`,
    '-WaitMutex',
    ...(options.editorRunning ? [] : ['-FromMsBuild']),
    ...(options.additionalArgs ?? []),
  ];
  return { executable: engine.ubtPath, args };
}

export function cleanCommandLine(
  engine: UEInstallation,
  project: UEProject,
  options: { configuration: BuildConfiguration; targetType: BuildTargetType; platform: BuildPlatform },
): UBTCommandLine {
  return {
    executable: engine.ubtPath,
    args: [
      resolveTargetName(project, options.targetType),
      options.platform,
      options.configuration,
      `-project=${project.uprojectPath}`,
      '-clean',
    ],
  };
}

export function generateClangDatabaseCommandLine(
  engine: UEInstallation,
  project: UEProject,
  options: { configuration?: BuildConfiguration; platform?: BuildPlatform } = {},
): UBTCommandLine {
  return {
    executable: engine.ubtPath,
    args: [
      resolveTargetName(project, 'Editor'),
      options.platform ?? 'Win64',
      options.configuration ?? 'Development',
      `-project=${project.uprojectPath}`,
      '-mode=GenerateClangDatabase',
    ],
  };
}

export function generateProjectFilesCommandLine(
  engine: UEInstallation,
  project: UEProject,
): UBTCommandLine {
  return {
    executable: engine.ubtPath,
    args: ['-projectfiles', `-project=${project.uprojectPath}`, '-game', '-rocket', '-progress'],
  };
}

export function formatCommandLine(cmd: UBTCommandLine): string {
  return `"${cmd.executable}" ${cmd.args.join(' ')}`;
}
