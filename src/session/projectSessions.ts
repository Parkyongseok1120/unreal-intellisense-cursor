import { ProjectSession } from './projectSession';

const sessions = new Map<string, ProjectSession>();

export function getProjectSession(projectRoot: string): ProjectSession {
  const key = projectRoot.toLowerCase();
  let session = sessions.get(key);
  if (!session) {
    session = new ProjectSession();
    sessions.set(key, session);
  }
  return session;
}

export function hasProjectSession(projectRoot: string): boolean {
  return sessions.has(projectRoot.toLowerCase());
}

export function disposeProjectSession(projectRoot: string): void {
  const key = projectRoot.toLowerCase();
  sessions.get(key)?.dispose();
  sessions.delete(key);
}

export function disposeAllProjectSessions(): void {
  for (const session of sessions.values()) {
    session.dispose();
  }
  sessions.clear();
}

export function listProjectSessionRoots(): string[] {
  return [...sessions.keys()];
}
