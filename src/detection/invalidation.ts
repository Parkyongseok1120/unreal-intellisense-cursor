export type InvalidationScope =
  | 'translationUnit'
  | 'reflection'
  | 'uhtModule'
  | 'module'
  | 'projectModel'
  | 'targetModule';

export interface SourceChangeEvent {
  filePath: string;
  isCreate: boolean;
  scope: InvalidationScope;
  moduleName?: string;
}

export function classifySourceChange(filePath: string, isCreate: boolean, projectRoot: string): SourceChangeEvent {
  const normalized = filePath.replace(/\\/g, '/');
  const rel = normalized.startsWith(projectRoot.replace(/\\/g, '/'))
    ? normalized.slice(projectRoot.replace(/\\/g, '/').length).replace(/^\//, '')
    : normalized;

  if (rel.includes('Intermediate/') && rel.endsWith('.Shared.rsp')) {
    return { filePath, isCreate, scope: 'targetModule' };
  }

  if (rel.endsWith('.uproject') || rel.endsWith('.uplugin')) {
    return { filePath, isCreate, scope: 'projectModel' };
  }

  const buildCsMatch = rel.match(/^(?:Plugins\/.+\/)?Source\/([^/]+)\/[^/]+\.Build\.cs$/i);
  if (buildCsMatch || rel.endsWith('.Target.cs')) {
    return { filePath, isCreate, scope: 'module', moduleName: buildCsMatch?.[1] };
  }

  const sourceMatch = rel.match(/^(?:Plugins\/.+\/)?Source\/([^/]+)\//);
  const moduleName = sourceMatch?.[1];

  if (rel.endsWith('.h') || rel.endsWith('.hpp') || rel.endsWith('.inl')) {
    if (isCreate) {
      return { filePath, isCreate, scope: 'uhtModule', moduleName };
    }
    return { filePath, isCreate, scope: 'reflection', moduleName };
  }

  if (rel.endsWith('.cpp')) {
    return {
      filePath,
      isCreate,
      scope: isCreate ? 'translationUnit' : 'reflection',
      moduleName,
    };
  }

  return { filePath, isCreate, scope: 'module', moduleName };
}

export function shouldRefreshCompileDatabase(event: SourceChangeEvent): boolean {
  return ['translationUnit', 'uhtModule', 'module', 'projectModel', 'targetModule'].includes(event.scope);
}

export function shouldRefreshReflectionOnly(event: SourceChangeEvent): boolean {
  return event.scope === 'reflection' && !event.isCreate;
}

export function invalidationLabel(scope: InvalidationScope): string {
  switch (scope) {
    case 'translationUnit':
      return 'translation unit';
    case 'reflection':
      return 'reflection index';
    case 'uhtModule':
      return 'UHT module';
    case 'module':
      return 'module';
    case 'projectModel':
      return 'project model';
    case 'targetModule':
      return 'target/module RSP';
    default:
      return scope;
  }
}
