import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationManager } from '../dist/conversation/manager.js';

const AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'anthropic/claude-opus-4-7',
  tools: ['read', 'bash'],
};

function createFakeAgentSession({
  sessionId = 'agent-session-1',
  onPrompt,
  onAbort,
  ...options
} = {}) {
  const resumeRef = Object.hasOwn(options, 'resumeRef') ? options.resumeRef : '/tmp/pi-session-1.jsonl';
  const listeners = new Set();
  return {
    sessionId,
    ...(resumeRef !== undefined ? { resumeRef } : {}),
    prompt: async (text) => {
      if (onPrompt) {
        await onPrompt(text, (event) => {
          for (const listener of listeners) listener(event);
        });
        return;
      }
      for (const listener of listeners) {
        listener({
          type: 'text_delta',
          delta: `reply to ${text}`,
        });
      }
    },
    abort: async () => {
      await onAbort?.();
    },
    dispose: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function storeKey(key, backend) {
  return `${key}:${backend}`;
}

function createMockConversationStore(initial = {}) {
  const data = new Map(
    Object.entries(initial).map(([key, conversation]) => [
      `${key}:${conversation.backend}`,
      conversation,
    ]),
  );
  const calls = { get: [], put: [], remove: [] };
  return {
    store: {
      get: (key, backend) => {
        calls.get.push({ key, backend });
        return data.get(storeKey(key, backend));
      },
      put: (key, conversation) => {
        calls.put.push({ key, conversation });
        data.set(storeKey(key, conversation.backend), conversation);
      },
      remove: (key, backend) => {
        calls.remove.push({ key, backend });
        data.delete(storeKey(key, backend));
      },
      close: () => {},
    },
    calls,
    data,
  };
}

function createSessionFactory(createSession, backend = 'pi') {
  return Object.assign(createSession, { backend });
}

test('conversation manager creates an agent session for a new key and returns final text with handle', async () => {
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession();
    }),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.deepEqual(result, {
    kind: 'ok',
    text: 'reply to hello',
    handle: {
      sessionId: 'agent-session-1',
      sessionFile: '/tmp/pi-session-1.jsonl',
    },
  });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    key: 'thread-1',
    agent: AGENT,
    cwd: '/tmp/workspace',
  });
});

test('conversation manager persists successful agent conversation handles', async () => {
  const { store, calls } = createMockConversationStore();
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        sessionId: 'agent-session-persisted',
        resumeRef: '/tmp/pi-session-persisted.jsonl',
      }),
    ),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      conversation: {
        sessionId: 'agent-session-persisted',
        backend: 'pi',
        resumeRef: '/tmp/pi-session-persisted.jsonl',
        model: 'anthropic/claude-opus-4-7',
        agentName: 'main',
      },
    },
  ]);
});

test('conversation manager resumes a persisted session file after restart', async () => {
  const { store } = createMockConversationStore({
    'thread-1': {
      sessionId: 'pi-session-existing',
      backend: 'pi',
      resumeRef: '/tmp/pi-session-existing.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    },
  });
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async (config) => {
      created.push(config);
      return createFakeAgentSession({
        sessionId: 'pi-session-existing',
        resumeRef: '/tmp/pi-session-existing.jsonl',
      });
    }),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello again');

  assert.equal(result.kind, 'ok');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].resume, {
    sessionId: 'pi-session-existing',
    resumeRef: '/tmp/pi-session-existing.jsonl',
  });
});

test('conversation manager has/getHandle/purge cover in-memory and persisted conversations', async () => {
  const { store, data, calls } = createMockConversationStore({
    persisted: {
      sessionId: 'pi-session-persisted',
      backend: 'pi',
      resumeRef: '/tmp/pi-session-persisted.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    },
    otherAgent: {
      sessionId: 'pi-session-other',
      backend: 'pi',
      resumeRef: '/tmp/pi-session-other.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'memory',
    },
    otherBackend: {
      sessionId: 'claude-session-other',
      backend: 'claude-agent-sdk',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    },
  });
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({ sessionId: 'agent-session-open' }),
    ),
  });

  assert.equal(manager.has('missing', AGENT), false);
  assert.equal(manager.has('persisted', AGENT), true);
  assert.equal(manager.has('otherAgent', AGENT), false);
  assert.equal(manager.has('otherBackend', AGENT), false);
  assert.deepEqual(manager.getHandle('persisted', AGENT), {
    sessionId: 'pi-session-persisted',
    sessionFile: '/tmp/pi-session-persisted.jsonl',
  });

  const result = await manager.runTurn('open', AGENT, 'hello');
  assert.equal(result.kind, 'ok');
  assert.equal(manager.has('open', AGENT), true);
  assert.equal(manager.has('open', { ...AGENT, name: 'memory' }), false);
  assert.deepEqual(manager.getHandle('open', AGENT), {
    sessionId: 'agent-session-open',
    sessionFile: '/tmp/pi-session-1.jsonl',
  });

  await manager.purge('open');
  await manager.purge('persisted');

  assert.equal(manager.has('open', AGENT), false);
  assert.equal(manager.has('persisted', AGENT), false);
  assert.equal(data.has('open:pi'), false);
  assert.equal(data.has('persisted:pi'), false);
  assert.deepEqual(calls.remove, [
    { key: 'open', backend: 'pi' },
    { key: 'persisted', backend: 'pi' },
  ]);
});

test('conversation manager forwards agent text deltas to the caller callback', async () => {
  const deltas = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        onPrompt: async (_text, emit) => {
          emit({
            type: 'text_delta',
            delta: 'hello ',
          });
          emit({
            type: 'thinking_delta',
            delta: 'hidden',
          });
          emit({
            type: 'text_delta',
            delta: 'world',
          });
        },
      }),
    ),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello', {
    onTextDelta: async (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'hello world');
});

test('conversation manager interrupts an active turn and lets the latest turn complete', async () => {
  let promptCount = 0;
  let releaseFirstPrompt;
  let abortCount = 0;

  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        onPrompt: async (text, emit) => {
          promptCount += 1;
          if (promptCount === 1) {
            emit({
              type: 'text_delta',
              delta: `stale:${text}`,
            });
            await new Promise((resolve) => {
              releaseFirstPrompt = resolve;
            });
            return;
          }

          emit({
            type: 'text_delta',
            delta: `latest:${text}`,
          });
        },
        onAbort: async () => {
          abortCount += 1;
          releaseFirstPrompt?.();
        },
      }),
    ),
  });

  const first = manager.runTurn('thread-1', AGENT, 'first');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = manager.runTurn('thread-1', AGENT, 'second');
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { kind: 'interrupted' });
  assert.equal(secondResult.kind, 'ok');
  assert.equal(secondResult.text, 'latest:second');
  assert.equal(abortCount, 1);
});

test('conversation manager persists handles that only have a session id', async () => {
  const { store, calls } = createMockConversationStore();
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: createSessionFactory(async () =>
      createFakeAgentSession({
        sessionId: 'agent-session-without-resume-ref',
        resumeRef: undefined,
      }),
    ),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      conversation: {
        sessionId: 'agent-session-without-resume-ref',
        backend: 'pi',
        model: 'anthropic/claude-opus-4-7',
        agentName: 'main',
      },
    },
  ]);
});

test('conversation manager persists the injected session factory backend', async () => {
  const { store, calls } = createMockConversationStore();
  const createSession = Object.assign(
    async () =>
      createFakeAgentSession({
        sessionId: 'claude-session-1',
        resumeRef: undefined,
      }),
    { backend: 'claude-agent-sdk' },
  );
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession,
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      conversation: {
        sessionId: 'claude-session-1',
        backend: 'claude-agent-sdk',
        model: 'anthropic/claude-opus-4-7',
        agentName: 'main',
      },
    },
  ]);
});
