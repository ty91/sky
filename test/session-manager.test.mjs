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
  assert.equal(sendCalls[0].config.cwd, '/tmp/workspace');
  assert.deepEqual(calls.put, [
    { key: 'thread-1', session: { sessionId: 'session-1', systemPrompt: '' } },
  ]);
  assert.equal(manager.getSessionId('thread-1'), 'session-1');

  await manager.close('thread-1');
  assert.deepEqual(closeCalls, ['system']);
  // close는 persist를 건드리지 않음
  assert.deepEqual(calls.remove, []);
});

test('session manager auto-resumes from store on open', async () => {
  const { store, calls } = createMockStore({
    'thread-1': { sessionId: 'resumed-session', systemPrompt: '' },
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
  assert.equal(manager.getSessionId('thread-1'), 'resumed-session');
  assert.deepEqual(calls.get, ['thread-1']);
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

test('purge removes persisted record and closes session', async () => {
  const { store, calls } = createMockStore({
    'thread-1': { sessionId: 'old', systemPrompt: '' },
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
