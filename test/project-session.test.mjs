import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

function vscodeMock() {
  class CancellationTokenSource {
    constructor() {
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  }
  return {
    CancellationTokenSource,
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose: () => {} });
      }
      fire() {}
      dispose() {}
    },
  };
}

const projectSession = loadTsModule('src/session/projectSession.ts', {
  vscode: vscodeMock,
  '../mcp/commandBridge': () => ({
    CommandBridge: class {
      async start() {
        return this;
      }
      dispose() {}
    },
  }),
});

describe('projectSession scheduler', () => {
  it('supersedes an in-flight runPipeline with a newer call', async () => {
    const session = new projectSession.ProjectSession();
    const order = [];
    let releaseFirst;
    const holdFirst = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = session.runPipeline(async (_options, token) => {
      order.push('first-start');
      await holdFirst;
      if (!token.isCancellationRequested) order.push('first-end');
    });

    await Promise.resolve();
    const second = session.runPipeline(async () => {
      order.push('second-start');
      order.push('second-end');
    });

    releaseFirst();
    await Promise.all([first, second]);
    assert.ok(order.indexOf('second-start') > order.indexOf('first-start'));
    assert.equal(order.at(-1), 'second-end');
    assert.ok(!order.includes('first-end'), 'cancelled pipeline should not commit first-end');
    session.dispose();
  });

  it('detects stale generation after bump', async () => {
    const session = new projectSession.ProjectSession();
    let capturedGen = 0;
    await session.runPipeline(async () => {
      capturedGen = session.getGeneration();
    });
    session.runPipeline(async () => {}).catch(() => {});
    assert.equal(session.isStale(capturedGen), true);
    session.dispose();
  });

  it('serializes write jobs through runJob', async () => {
    const session = new projectSession.ProjectSession();
    const order = [];
    const gen = session.getGeneration();
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };

    const a = session.runJob('compileRefresh', 'C:/P', gen, token, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const b = session.runJob('warmup', 'C:/P', gen, token, async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
    session.dispose();
  });
});
