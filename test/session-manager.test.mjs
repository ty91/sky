import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../dist/session/manager.js';

const AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'opus',
  tools: ['Read'],
};

function createMockProvider(overrides = {}) {
  return {
    send: async () => {},
    collect: async () => ({ text: 'reply', sessionId: 'session-1' }),
    interrupt: async () => {},
    close: async () => {},
    ...overrides,
  };
}

function createMockStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { get: [], put: [], remove: [] };
  return {
    store: {
      get: (key) => {
        calls.get.push(key);
        return data.get(key);
      },
      put: (key, session) => {
        calls.put.push({ key, session });
        data.set(key, session);
      },
      remove: (key) => {
        calls.remove.push(key);
        data.delete(key);
      },
      close: () => {},
    },
    calls,
    data,
  };
}

test('session manager creates sessions and persists new session ids via store', async () => {
  const { store, calls } = createMockStore();
  const sendCalls = [];
  const closeCalls = [];
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => createMockProvider({
        send: async (text) => {
          sendCalls.push({ text, config });
        },
        close: async () => {
          closeCalls.push(config.systemPrompt);
        },
      }),
    },
  });

  manager.open('thread-1', AGENT);

  const result = await manager.send('thread-1', 'hello');

  assert.deepEqual(result, { kind: 'ok', text: 'reply' });
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].config.sessionKey, 'thread-1');
  assert.equal(sendCalls[0].config.model, 'opus');
  assert.equal(sendCalls[0].config.cwd, '/tmp/workspace');
  // system_prompt snapshot is persisted alongside the session id
  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      session: { sessionId: 'session-1', model: 'opus', systemPrompt: 'system' },
    },
  ]);
  assert.equal(manager.getSessionId('thread-1'), 'session-1');

  await manager.close('thread-1');
  assert.deepEqual(closeCalls, ['system']);
  // close는 persist를 건드리지 않음
  assert.deepEqual(calls.remove, []);
});

test('session manager auto-resumes from store on open', async () => {
  const { store, calls } = createMockStore({
    'thread-1': { sessionId: 'resumed-session', model: 'opus', systemPrompt: 'frozen-S0' },
  });
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider();
      },
    },
  });

  manager.open('thread-1', AGENT);

  assert.equal(createdWith.resume, 'resumed-session');
  assert.equal(createdWith.systemPrompt, 'frozen-S0');
  assert.equal(manager.getSessionId('thread-1'), 'resumed-session');
  assert.deepEqual(calls.get, ['thread-1']);
  // A record with a non-empty stored prompt does not trigger self-healing.
  assert.deepEqual(calls.put, []);
});

test('new sessions call systemPromptLoader; loader output is passed to provider and persisted', async () => {
  const { store, calls } = createMockStore();
  let loaderCallCount = 0;
  const loaderAgent = {
    ...AGENT,
    systemPrompt: 'stale-baseline',
    systemPromptLoader: () => {
      loaderCallCount++;
      return 'fresh-prompt-v' + loaderCallCount;
    },
  };
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider({
          collect: async () => ({ text: 'reply', sessionId: 'new-session' }),
        });
      },
    },
  });

  manager.open('thread-new', loaderAgent);
  assert.equal(loaderCallCount, 1);
  assert.equal(createdWith.systemPrompt, 'fresh-prompt-v1');

  await manager.send('thread-new', 'hi');
  // The freshly-loaded prompt is frozen into the store for future resumes.
  assert.deepEqual(calls.put, [
    {
      key: 'thread-new',
      session: { sessionId: 'new-session', model: 'opus', systemPrompt: 'fresh-prompt-v1' },
    },
  ]);
});

test('resumed sessions skip systemPromptLoader and replay the stored snapshot', async () => {
  const { store } = createMockStore({
    'thread-1': { sessionId: 'resumed', model: 'opus', systemPrompt: 'frozen-S0' },
  });
  let loaderCallCount = 0;
  const loaderAgent = {
    ...AGENT,
    systemPrompt: 'current-file-S2',
    systemPromptLoader: () => {
      loaderCallCount++;
      return 'current-file-S2';
    },
  };
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider();
      },
    },
  });

  manager.open('thread-1', loaderAgent);

  assert.equal(loaderCallCount, 0, 'loader must not run on resume');
  assert.equal(createdWith.resume, 'resumed');
  assert.equal(
    createdWith.systemPrompt,
    'frozen-S0',
    'provider must receive the frozen snapshot, not the current file contents',
  );
});

test('matching model records with empty stored prompt fall back to agent.systemPrompt and self-heal', async () => {
  const { store, calls } = createMockStore({
    'thread-1': { sessionId: 'legacy', model: 'opus', systemPrompt: '' },
  });
  let loaderCallCount = 0;
  const loaderAgent = {
    ...AGENT,
    systemPrompt: 'baseline',
    systemPromptLoader: () => {
      loaderCallCount++;
      return 'loader-result';
    },
  };
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider();
      },
    },
  });

  manager.open('thread-1', loaderAgent);

  assert.equal(loaderCallCount, 0, 'loader must not run on resume, even for legacy records');
  assert.equal(createdWith.systemPrompt, 'baseline', 'legacy fallback uses agent.systemPrompt');
  // open() should backfill the store synchronously so the next resume gets a
  // matching snapshot and hits Anthropic's prompt cache.
  assert.deepEqual(calls.put, [
    { key: 'thread-1', session: { sessionId: 'legacy', model: 'opus', systemPrompt: 'baseline' } },
  ]);
});

test('stored sessions with a different model are ignored', async () => {
  const { store, calls } = createMockStore({
    'thread-1': {
      sessionId: 'old-model-session',
      model: 'anthropic/claude-sonnet-4-6',
      systemPrompt: 'old-prompt',
    },
  });
  let loaderCallCount = 0;
  const loaderAgent = {
    ...AGENT,
    model: 'opus',
    systemPrompt: 'baseline',
    systemPromptLoader: () => {
      loaderCallCount++;
      return 'fresh-current-model';
    },
  };
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider({
          collect: async () => ({ text: 'reply', sessionId: 'new-model-session' }),
        });
      },
    },
  });

  manager.open('thread-1', loaderAgent);
  assert.equal(loaderCallCount, 1);
  assert.equal(createdWith.resume, undefined);
  assert.equal(createdWith.systemPrompt, 'fresh-current-model');

  await manager.send('thread-1', 'hi');

  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      session: {
        sessionId: 'new-model-session',
        model: 'opus',
        systemPrompt: 'fresh-current-model',
      },
    },
  ]);
});

test('stored sessions without model ownership are ignored', () => {
  const { store } = createMockStore({
    'thread-1': {
      sessionId: 'legacy-sdk-session',
      model: '',
      systemPrompt: 'legacy-prompt',
    },
  });
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider();
      },
    },
  });

  manager.open('thread-1', AGENT);

  assert.equal(createdWith.resume, undefined);
  assert.equal(createdWith.systemPrompt, 'system');
});

test('session manager works without a store (ephemeral mode)', async () => {
  let createdWith;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: (config) => {
        createdWith = config;
        return createMockProvider();
      },
    },
  });

  manager.open('memory:run', AGENT);
  assert.equal(createdWith.resume, undefined);

  const result = await manager.send('memory:run', 'hi');
  assert.equal(result.kind, 'ok');
});

test('session manager has reports open and persisted sessions without opening providers', () => {
  const { store, calls } = createMockStore({
    persisted: { sessionId: 'stored-session', model: 'opus', systemPrompt: 'system' },
    'old-model': {
      sessionId: 'old-model-session',
      model: 'anthropic/claude-sonnet-4-6',
      systemPrompt: 'old-prompt',
    },
  });
  let createCalls = 0;
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: () => {
        createCalls += 1;
        return createMockProvider();
      },
    },
  });

  assert.equal(manager.has('missing'), false);
  assert.equal(manager.has('persisted', AGENT), true);
  assert.equal(manager.has('old-model', AGENT), false);
  assert.equal(manager.has('old-model'), true, 'agent-less checks only report store presence');

  manager.open('open', AGENT);
  const getCallsAfterOpen = calls.get.length;

  assert.equal(manager.has('open'), true);
  assert.equal(createCalls, 1);
  assert.deepEqual(calls.get, ['missing', 'persisted', 'old-model', 'old-model', 'open']);
  assert.equal(calls.get.length, getCallsAfterOpen, 'open in-memory sessions do not re-read store');
});

test('purge removes persisted record and closes session', async () => {
  const { store, calls } = createMockStore({
    'thread-1': { sessionId: 'old', model: 'opus', systemPrompt: '' },
  });
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    store,
    providerFactory: {
      create: () => createMockProvider(),
    },
  });

  manager.open('thread-1', AGENT);
  await manager.purge('thread-1');

  assert.deepEqual(calls.remove, ['thread-1']);
  assert.equal(manager.getSessionId('thread-1'), undefined);
});

test('session manager returns error for missing sessions', async () => {
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => createMockProvider(),
    },
  });

  const missing = await manager.send('missing', 'hello');
  assert.equal(missing.kind, 'error');
});

test('session manager interrupts previous request on new message', async () => {
  let collectResolve;
  let interruptCalled = false;
  let collectCallCount = 0;

  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => createMockProvider({
        collect: async () => {
          collectCallCount++;
          if (collectCallCount === 1) {
            // 첫 번째 collect는 interrupt될 때까지 대기
            return new Promise((resolve) => {
              collectResolve = resolve;
            });
          }
          // 두 번째 collect는 즉시 응답
          return { text: 'second reply' };
        },
        interrupt: async () => {
          interruptCalled = true;
          // interrupt 시 pending collect를 resolve
          collectResolve?.({ text: '(interrupted)' });
        },
      }),
    },
  });

  manager.open('t1', AGENT);

  const first = manager.send('t1', 'hello');

  // 첫 번째 collect가 블록된 상태에서 microtask가 돌 수 있게 양보
  await new Promise((r) => setTimeout(r, 10));

  const second = manager.send('t1', 'world');

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.kind, 'interrupted');
  assert.equal(interruptCalled, true);
  assert.equal(secondResult.kind, 'ok');
  assert.equal(secondResult.text, 'second reply');
});

test('rapid messages resolve intermediate ones as interrupted immediately', async () => {
  let collectResolve;
  let collectCallCount = 0;

  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => createMockProvider({
        collect: async () => {
          collectCallCount++;
          if (collectCallCount === 1) {
            return new Promise((resolve) => {
              collectResolve = resolve;
            });
          }
          return { text: 'final reply' };
        },
        interrupt: async () => {
          collectResolve?.({ text: '(interrupted)' });
        },
      }),
    },
  });

  manager.open('t1', AGENT);

  const first = manager.send('t1', 'A');
  await new Promise((r) => setTimeout(r, 10));

  // B와 C가 연속 도착 — B는 pending에 들어갔다가 C에 의해 즉시 교체
  const second = manager.send('t1', 'B');
  const third = manager.send('t1', 'C');

  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

  assert.equal(firstResult.kind, 'interrupted');
  assert.equal(secondResult.kind, 'interrupted');  // B는 pending 교체로 즉시 interrupted
  assert.equal(thirdResult.kind, 'ok');
  assert.equal(thirdResult.text, 'final reply');
});

test('onMessage callback is guarded by turnId', async () => {
  let collectResolve;
  let collectCallCount = 0;
  const messagesReceived = [];

  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => createMockProvider({
        collect: async (options) => {
          collectCallCount++;
          if (collectCallCount === 1) {
            // 첫 번째 turn: onMessage 한 번 호출 후 interrupt 대기
            if (options?.onMessage) {
              await options.onMessage('partial from turn 1');
            }
            return new Promise((resolve) => {
              collectResolve = resolve;
            });
          }
          // 두 번째 turn
          if (options?.onMessage) {
            await options.onMessage('from turn 2');
          }
          return { text: 'done' };
        },
        interrupt: async () => {
          collectResolve?.({ text: '(interrupted)' });
        },
      }),
    },
  });

  manager.open('t1', AGENT);

  const first = manager.send('t1', 'hello', {
    onMessage: async (msg) => {
      messagesReceived.push({ turn: 1, msg });
    },
  });

  await new Promise((r) => setTimeout(r, 10));

  const second = manager.send('t1', 'world', {
    onMessage: async (msg) => {
      messagesReceived.push({ turn: 2, msg });
    },
  });

  await Promise.all([first, second]);

  // turn 1의 onMessage는 interrupt 전에 호출됨 (이건 이미 나간 것이므로 ok)
  // turn 2의 onMessage는 정상 호출
  assert.ok(messagesReceived.some((m) => m.turn === 2 && m.msg === 'from turn 2'));
});

test('close resolves pending requests as interrupted', async () => {
  let collectResolve;

  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => createMockProvider({
        collect: async () => {
          return new Promise((resolve) => {
            collectResolve = resolve;
          });
        },
        interrupt: async () => {
          collectResolve?.({ text: '(interrupted)' });
        },
      }),
    },
  });

  manager.open('t1', AGENT);

  const sendPromise = manager.send('t1', 'hello');
  await new Promise((r) => setTimeout(r, 10));

  await manager.close('t1');

  const result = await sendPromise;
  assert.equal(result.kind, 'interrupted');
});
