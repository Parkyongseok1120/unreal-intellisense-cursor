import * as fs from 'fs';
import * as path from 'path';
import type { UEProject } from '../types';
import type { UClassReflection } from '../uht/generatedHeaderParser';
import {
  buildSemanticGraph,
  loadSemanticGraph,
  saveSemanticGraph,
  type CompileAction,
  type SemanticGraph,
} from '../projectModel/projectModelService';
import {
  buildCompileSnapshot,
  loadBuildSnapshot,
  saveBuildSnapshot,
  snapshotFreshness,
  type BuildSnapshot,
} from '../projectModel/buildSnapshot';

let cachedGraph: SemanticGraph | undefined;
let cachedProjectRoot: string | undefined;
let cachedSnapshot: BuildSnapshot | undefined;

export async function getOrBuildSemanticGraph(project: UEProject): Promise<SemanticGraph> {
  if (cachedGraph && cachedProjectRoot === project.projectRoot) {
    return cachedGraph;
  }

  const loaded = await loadSemanticGraph(project.projectRoot);
  const snap = await loadBuildSnapshot(project.projectRoot);
  if (loaded && snap && loaded.fingerprint === snap.fingerprint) {
    cachedGraph = loaded;
    cachedProjectRoot = project.projectRoot;
    cachedSnapshot = snap;
    return loaded;
  }

  return refreshSemanticGraph(project);
}

export async function refreshSemanticGraph(project: UEProject): Promise<SemanticGraph> {
  const snapshot = await buildCompileSnapshot(project);
  await saveBuildSnapshot(project.projectRoot, snapshot);
  cachedSnapshot = snapshot;

  const graph = await buildSemanticGraph(project);
  graph.fingerprint = snapshot.fingerprint;
  graph.generation = Date.now();
  graph.engineId = project.engineAssociation;
  graph.provenance = snapshot.provenance;
  graph.synthetic = snapshot.synthetic;

  await saveSemanticGraph(project.projectRoot, graph);
  cachedGraph = graph;
  cachedProjectRoot = project.projectRoot;
  return graph;
}

export function getCachedSemanticGraph(): SemanticGraph | undefined {
  return cachedGraph;
}

export function invalidateSemanticGraph(projectRoot?: string): void {
  if (!projectRoot || cachedProjectRoot === projectRoot) {
    cachedGraph = undefined;
    cachedProjectRoot = undefined;
    cachedSnapshot = undefined;
  }
}

export function querySymbol(graph: SemanticGraph, name: string): UClassReflection | undefined {
  const key = name.toLowerCase();
  return graph.reflection.find((c) => c.className.toLowerCase() === key);
}

export function queryModule(graph: SemanticGraph, moduleName: string): SemanticGraph['modules'][0] | undefined {
  const key = moduleName.toLowerCase();
  return graph.modules.find((m) => m.name.toLowerCase() === key);
}

export function findGeneratedPair(graph: SemanticGraph, filePath: string): { header?: string; generated?: string } | undefined {
  const norm = path.normalize(filePath).toLowerCase();
  for (const art of graph.generatedArtifacts) {
    if (art.headerPath.toLowerCase() === norm) return { header: art.headerPath, generated: art.generatedPath };
    if (art.generatedPath.toLowerCase() === norm) return { header: art.headerPath, generated: art.generatedPath };
  }
  return undefined;
}

export async function getReflectionClasses(projectRoot: string): Promise<UClassReflection[]> {
  if (cachedGraph && cachedProjectRoot === projectRoot) {
    return cachedGraph.reflection;
  }
  const loaded = await loadSemanticGraph(projectRoot);
  return loaded?.reflection ?? [];
}

export type IntelliSenseStatus = 'ready' | 'partial' | 'stale' | 'missing';

export async function computeCompileParity(project: UEProject): Promise<{
  matched: number;
  total: number;
  parity: number;
  synthetic: boolean;
  status: IntelliSenseStatus;
  provenance: string;
}> {
  const snapshot = cachedSnapshot ?? (await loadBuildSnapshot(project.projectRoot)) ?? (await buildCompileSnapshot(project));
  const result = snapshot.parity ?? {
    matched: 0,
    total: snapshot.ideActions?.length ?? 0,
    parity: snapshot.synthetic ? 0 : 1,
  };

  const graph = cachedGraph ?? (await loadSemanticGraph(project.projectRoot));
  const status = await snapshotFreshness(project.projectRoot, graph?.fingerprint);

  return {
    ...result,
    synthetic: snapshot.synthetic,
    status,
    provenance: snapshot.provenance,
  };
}

export type { SemanticGraph, CompileAction, BuildSnapshot };
