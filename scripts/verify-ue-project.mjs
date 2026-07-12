#!/usr/bin/env node
/**
 * Verify a UE project path has expected extension artifacts.
 * Usage: node scripts/verify-ue-project.mjs [--project PATH] [--engine PATH]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');
const DEFAULT_PROJECT = path.join(EXT_ROOT, 'test', 'fixtures', 'synthetic-ue-project');

function parseArgs(argv) {
  const args = { project: DEFAULT_PROJECT, engine: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) {
      args.project = path.resolve(argv[++i]);
    } else if (argv[i] === '--engine' && argv[i + 1]) {
      args.engine = path.resolve(argv[++i]);
    }
  }
  return args;
}

function log(msg) {
  console.log(`[verify-ue-project] ${msg}`);
}

async function main() {
  const { project, engine } = parseArgs(process.argv);
  if (!(await exists(project))) {
    console.error(`Project root not found: ${project}`);
    process.exit(1);
  }

  const uprojects = await findFiles(project, '.uproject', 2);
  if (uprojects.length === 0) {
    console.error('No .uproject found under project root');
    process.exit(1);
  }

  const uprojectPath = uprojects[0];
  const data = JSON.parse(await fs.promises.readFile(uprojectPath, 'utf-8'));
  log(`Project: ${path.basename(uprojectPath)} (EngineAssociation ${data.EngineAssociation ?? 'unknown'})`);

  const sourceDir = path.join(project, 'Source');
  if (!(await exists(sourceDir))) {
    console.error('Missing Source/ directory');
    process.exit(1);
  }

  const buildCs = await findFiles(sourceDir, '.Build.cs', 6);
  log(`Build.cs files: ${buildCs.length}`);
  if (buildCs.length === 0) {
    process.exit(1);
  }

  if (engine) {
    if (!(await exists(engine))) {
      console.error(`Engine path not found: ${engine}`);
      process.exit(1);
    }
    log(`Engine root: ${engine}`);
  } else {
    log('Engine root: (not provided — structural check only)');
  }

  log('Verification passed.');
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findFiles(root, suffix, maxDepth) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
