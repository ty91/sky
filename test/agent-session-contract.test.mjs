import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createClaudeAgentSdkSessionFactory,
  createDefaultClaudeAgentSdkSessionFactory,
} from '../dist/agents/backend/claude.js';
import { createPiSessionFactory, createPiSessionFactoryWithDeps } from '../dist/agents/backend/pi.js';
import { loadSettings } from '../dist/settings.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const AGENT = {
  name: 'contract',
  systemPrompt: 'You are running an adapter contract test.',
  model: 'anthropic/claude-opus-4-7',
  tools: [],
};

function clearActiveTurn(state, turn) {
  if (state.activeTurn === turn) {
    state.activeTurn = undefined;
  }
}

function createControllablePiSession(state, { sessionId, sessionFile }) {
  const listeners = new Set();
  let active;
  let disposed = false;

  return {
    sessionId,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    async prompt(text) {
      if (disposed) {
        throw new Error('Pi session has been disposed');
      }
      if (active) {
        throw new Error('Pi session already has an active turn');
      }

      const deferredTurn = deferred();
      const turn = {
        text,
        emit: (delta) => {
          for (const listener of listeners) {
            listener({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta },
            });
          }
        },
        finish: () => deferredTurn.resolve(),
        fail: (error) => deferredTurn.reject(error),
      };
      active = turn;
      state.activeTurn = turn;

      try {
        await deferredTurn.promise;
      } finally {
        active = undefined;
        clearActiveTurn(state, turn);
      }
    },
    async abort() {
      state.abortCount += 1;
      active?.finish();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      active?.fail(new Error('Pi session disposed'));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createPiAdapterHarness() {
  const state = {
    activeTurn: undefined,
    abortCount: 0,
    currentOptions: undefined,
  };

  class FakeResourceLoader {
    constructor(options) {
      state.resourceLoaderOptions = options;
    }

    async reload() {
      state.resourceLoaderReloaded = true;
    }
  }

  const deps = {
    AuthStorage: { create: () => ({}) },
    ModelRegistry: {
      create: () => ({
        find: (provider, modelId) => ({ provider, modelId }),
      }),
    },
    getAgentDir: () => '/tmp/pi-agent',
    DefaultResourceLoader: FakeResourceLoader,
    SessionManager: {
      create: () => ({
        sessionId: 'pi-session-1',
        sessionFile: '/tmp/pi-session.jsonl',
      }),
      open: (sessionFile) => ({
        sessionId: state.currentOptions?.resume?.sessionId ?? 'pi-session-resumed',
        sessionFile,
      }),
    },
    createAgentSession: async (options) => {
      state.createAgentSessionOptions = options;
      return {
        session: createControllablePiSession(state, {
          sessionId: options.sessionManager.sessionId,
          sessionFile: options.sessionManager.sessionFile,
        }),
      };
    },
  };
  const actualFactory = createPiSessionFactoryWithDeps(deps);
  const factory = Object.assign(
    async (options) => {
      state.currentOptions = options;
      return actualFactory(options);
    },
    { backend: actualFactory.backend },
  );

  return { factory, state };
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let ended = false;
  let failure;

  function settle() {
    while (waiters.length > 0) {
      if (values.length === 0 && !ended && !failure) {
        return;
      }
      const waiter = waiters.shift();
      if (failure) {
        waiter.reject(failure);
      } else if (values.length > 0) {
        waiter.resolve({ value: values.shift(), done: false });
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }

  return {
    push(value) {
      values.push(value);
      settle();
    },
    end() {
      ended = true;
      settle();
    },
    fail(error) {
      failure = error;
      settle();
    },
    next() {
      if (failure) {
        return Promise.reject(failure);
      }
      if (values.length > 0) {
        return Promise.resolve({ value: values.shift(), done: false });
      }
      if (ended) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

function createQuery(run, methods = {}) {
  const iterator = run();
  return Object.assign(iterator, {
    interrupt: async () => {},
    close: () => {},
    ...methods,
  });
}

function initMessage(sessionId) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
  };
}

function textDelta(sessionId, text) {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text,
      },
    },
  };
}

function resultMessage(sessionId, subtype = 'success') {
  return {
    type: 'result',
    subtype,
    session_id: sessionId,
    is_error: subtype !== 'success',
  };
}

function createClaudeAdapterHarness() {
  const state = {
    activeTurn: undefined,
    abortCount: 0,
  };

  const deps = {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options) => ({ name: options.name, tools: options.tools }),
    query: (params) => {
      const queue = createAsyncQueue();
      const sessionId = params.options.resume ?? 'claude-agent-sdk-session-1';

      return createQuery(
        async function* () {
          const input = params.prompt[Symbol.asyncIterator]();
          const firstInput = await input.next();
          const turn = {
            text: firstInput.value.message.content,
            emit: (delta) => queue.push(textDelta(sessionId, delta)),
            finish: () => queue.push(resultMessage(sessionId)),
            fail: (error) => queue.fail(error),
          };
          state.activeTurn = turn;

          try {
            yield initMessage(sessionId);

            while (true) {
              const next = await queue.next();
              if (next.done) {
                return;
              }
              yield next.value;
              if (next.value.type === 'result') {
                await input.next();
                return;
              }
            }
          } finally {
            clearActiveTurn(state, turn);
          }
        },
        {
          interrupt: async () => {
            state.abortCount += 1;
            state.activeTurn?.finish();
          },
          close: () => {
            state.activeTurn?.fail(new Error('Claude Agent SDK query closed'));
          },
        },
      );
    },
  };

  return { factory: createClaudeAgentSdkSessionFactory(deps), state };
}

function defineAgentSessionContract(name, createHarness) {
  test(`${name}: prompt resolves only after the turn completes`, async () => {
    const { factory, state } = createHarness();
    const session = await factory({ key: 'thread-1', agent: AGENT, cwd: '/tmp/workspace' });

    let settled = false;
    const prompt = session.prompt('hello').then(() => {
      settled = true;
    });

    await waitFor(() => state.activeTurn?.text === 'hello', `${name} active turn`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(settled, false);
    state.activeTurn.finish();
    await prompt;
    assert.equal(settled, true);
  });

  test(`${name}: subscribe receives text deltas in turn order while prompt is active`, async () => {
    const { factory, state } = createHarness();
    const session = await factory({ key: 'thread-1', agent: AGENT, cwd: '/tmp/workspace' });
    const deltas = [];
    session.subscribe((event) => deltas.push(event.delta));

    const prompt = session.prompt('stream');
    await waitFor(() => state.activeTurn?.text === 'stream', `${name} streaming turn`);

    state.activeTurn.emit('first ');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(deltas, ['first ']);

    state.activeTurn.emit('second');
    state.activeTurn.finish();
    await prompt;

    assert.deepEqual(deltas, ['first ', 'second']);
  });

  test(`${name}: abort makes the active prompt return`, async () => {
    const { factory, state } = createHarness();
    const session = await factory({ key: 'thread-1', agent: AGENT, cwd: '/tmp/workspace' });

    const prompt = session.prompt('slow turn');
    await waitFor(() => state.activeTurn?.text === 'slow turn', `${name} abortable turn`);
    await session.abort();

    await assert.doesNotReject(
      prompt.catch(() => undefined),
      `${name} prompt may resolve or reject after abort, but it must settle`,
    );
    assert.equal(state.abortCount, 1);
  });

  test(`${name}: dispose makes the session unusable`, async () => {
    const { factory } = createHarness();
    const session = await factory({ key: 'thread-1', agent: AGENT, cwd: '/tmp/workspace' });

    session.dispose();

    await assert.rejects(() => session.prompt('after dispose'), /disposed/);
  });

  test(`${name}: resume preserves the provided session id`, async () => {
    const { factory, state } = createHarness();
    const session = await factory({
      key: 'thread-1',
      agent: AGENT,
      cwd: '/tmp/workspace',
      resume: { sessionId: `${factory.backend}-existing`, resumeRef: '/tmp/existing.jsonl' },
    });

    assert.equal(session.sessionId, `${factory.backend}-existing`);

    const prompt = session.prompt('resumed');
    await waitFor(() => state.activeTurn?.text === 'resumed', `${name} resumed turn`);
    state.activeTurn.finish();
    await prompt;

    assert.equal(session.sessionId, `${factory.backend}-existing`);
  });
}

defineAgentSessionContract('pi adapter with fake backend', createPiAdapterHarness);

defineAgentSessionContract('claude agent sdk adapter with fake backend', createClaudeAdapterHarness);

test('pi adapter passes configured effort as thinking level', async () => {
  const { factory, state } = createPiAdapterHarness();
  await factory({
    key: 'thread-1',
    agent: { ...AGENT, effort: 'high' },
    cwd: '/tmp/workspace',
  });

  assert.equal(state.createAgentSessionOptions.thinkingLevel, 'high');
});

test('pi adapter omits thinking level when effort is not configured', async () => {
  const { factory, state } = createPiAdapterHarness();
  await factory({ key: 'thread-1', agent: AGENT, cwd: '/tmp/workspace' });

  assert.equal(Object.hasOwn(state.createAgentSessionOptions, 'thinkingLevel'), false);
});

async function withTempWorkspace(fn) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sky-agent-backend-smoke-'));
  try {
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runRealBackendSmoke(t, factory) {
  let settings = {};
  try {
    settings = loadSettings({ silent: true });
  } catch {
    settings = {};
  }
  const model =
    factory.backend === 'claude-agent-sdk'
      ? (process.env.SKY_CLAUDE_AGENT_BACKEND_SMOKE_MODEL ??
        process.env.SKY_AGENT_BACKEND_SMOKE_MODEL ??
        settings.model)
      : (process.env.SKY_PI_AGENT_BACKEND_SMOKE_MODEL ??
        process.env.SKY_AGENT_BACKEND_SMOKE_MODEL ??
        settings.model);
  if (!model) {
    t.skip(`Set SKY_${factory.backend === 'pi' ? 'PI' : 'CLAUDE'}_AGENT_BACKEND_SMOKE_MODEL.`);
    return;
  }
  if (factory.backend === 'claude-agent-sdk' && !model.startsWith('anthropic/')) {
    t.skip('Set SKY_CLAUDE_AGENT_BACKEND_SMOKE_MODEL to an anthropic/... model for Claude Agent SDK smoke.');
    return;
  }

  await withTempWorkspace(async (workspace) => {
    const session = await factory({
      key: `manual-smoke-${factory.backend}-${Date.now()}`,
      cwd: process.env.SKY_AGENT_BACKEND_SMOKE_WORKSPACE ?? settings.workspace ?? workspace,
      agent: {
        name: 'manual-smoke',
        systemPrompt: 'Reply briefly. This is a manual Sky agent backend smoke test.',
        model,
        tools: [],
        maxTurns: 1,
      },
    });
    const deltas = [];
    const unsubscribe = session.subscribe((event) => deltas.push(event.delta));

    try {
      await session.prompt('Reply exactly: sky-smoke-ok');
      assert.ok(session.sessionId, `${factory.backend} should expose a session id`);
      assert.ok(deltas.join('').trim().length > 0, `${factory.backend} should stream text`);

      const sessionId = session.sessionId;
      await session.prompt('Reply with one short word.');
      assert.equal(session.sessionId, sessionId, `${factory.backend} should resume the same session id`);
    } finally {
      unsubscribe();
      session.dispose();
    }
  });
}

const smokeEnabled = process.env.SKY_RUN_AGENT_BACKEND_SMOKE === '1';

test('manual smoke: real pi backend streams and resumes', { skip: !smokeEnabled }, async (t) => {
  await runRealBackendSmoke(t, createPiSessionFactory);
});

test('manual smoke: real claude agent sdk backend streams and resumes', { skip: !smokeEnabled }, async (t) => {
  await runRealBackendSmoke(t, createDefaultClaudeAgentSdkSessionFactory);
});
