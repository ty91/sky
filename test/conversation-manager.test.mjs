import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationManager } from '../dist/conversation/manager.js';

const AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'anthropic/claude-opus-4-7',
  tools: ['read', 'bash'],
};

function createFakePiSession({
  sessionId = 'pi-session-1',
  sessionFile = '/tmp/pi-session-1.jsonl',
  onPrompt,
  onAbort,
} = {}) {
  const listeners = new Set();
  return {
    sessionId,
    sessionFile,
    prompt: async (text) => {
      if (onPrompt) {
        await onPrompt(text, (event) => {
          for (const listener of listeners) listener(event);
        });
        return;
      }
      for (const listener of listeners) {
        listener({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: `reply to ${text}` },
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

function createMockConversationStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { get: [], put: [], remove: [] };
  return {
    store: {
      get: (key) => {
        calls.get.push(key);
        return data.get(key);
      },
      put: (key, conversation) => {
        calls.put.push({ key, conversation });
        data.set(key, conversation);
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

test('conversation manager creates a Pi session for a new key and returns final text with handle', async () => {
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: async (config) => {
      created.push(config);
      return createFakePiSession();
    },
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.deepEqual(result, {
    kind: 'ok',
    text: 'reply to hello',
    handle: {
      sessionId: 'pi-session-1',
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

test('conversation manager persists successful Pi conversation handles', async () => {
  const { store, calls } = createMockConversationStore();
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: async () =>
      createFakePiSession({
        sessionId: 'pi-session-persisted',
        sessionFile: '/tmp/pi-session-persisted.jsonl',
      }),
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(calls.put, [
    {
      key: 'thread-1',
      conversation: {
        sessionId: 'pi-session-persisted',
        sessionFile: '/tmp/pi-session-persisted.jsonl',
        model: 'anthropic/claude-opus-4-7',
        agentName: 'main',
      },
    },
  ]);
});

test('conversation manager resumes a persisted Pi session file after restart', async () => {
  const { store } = createMockConversationStore({
    'thread-1': {
      sessionId: 'pi-session-existing',
      sessionFile: '/tmp/pi-session-existing.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    },
  });
  const created = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: async (config) => {
      created.push(config);
      return createFakePiSession({
        sessionId: 'pi-session-existing',
        sessionFile: '/tmp/pi-session-existing.jsonl',
      });
    },
  });

  const result = await manager.runTurn('thread-1', AGENT, 'hello again');

  assert.equal(result.kind, 'ok');
  assert.equal(created.length, 1);
  assert.equal(created[0].sessionFile, '/tmp/pi-session-existing.jsonl');
});

test('conversation manager has/getHandle/purge cover in-memory and persisted conversations', async () => {
  const { store, data, calls } = createMockConversationStore({
    persisted: {
      sessionId: 'pi-session-persisted',
      sessionFile: '/tmp/pi-session-persisted.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    },
    otherAgent: {
      sessionId: 'pi-session-other',
      sessionFile: '/tmp/pi-session-other.jsonl',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'memory',
    },
  });
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    store,
    createSession: async () => createFakePiSession({ sessionId: 'pi-session-open' }),
  });

  assert.equal(manager.has('missing', AGENT), false);
  assert.equal(manager.has('persisted', AGENT), true);
  assert.equal(manager.has('otherAgent', AGENT), false);
  assert.deepEqual(manager.getHandle('persisted', AGENT), {
    sessionId: 'pi-session-persisted',
    sessionFile: '/tmp/pi-session-persisted.jsonl',
  });

  const result = await manager.runTurn('open', AGENT, 'hello');
  assert.equal(result.kind, 'ok');
  assert.equal(manager.has('open', AGENT), true);
  assert.equal(manager.has('open', { ...AGENT, name: 'memory' }), false);
  assert.deepEqual(manager.getHandle('open', AGENT), {
    sessionId: 'pi-session-open',
    sessionFile: '/tmp/pi-session-1.jsonl',
  });

  await manager.purge('open');
  await manager.purge('persisted');

  assert.equal(manager.has('open', AGENT), false);
  assert.equal(manager.has('persisted', AGENT), false);
  assert.equal(data.has('open'), false);
  assert.equal(data.has('persisted'), false);
  assert.deepEqual(calls.remove, ['open', 'persisted']);
});

test('conversation manager forwards Pi text deltas to the caller callback', async () => {
  const deltas = [];
  const manager = createConversationManager({
    defaultCwd: '/tmp/workspace',
    createSession: async () =>
      createFakePiSession({
        onPrompt: async (_text, emit) => {
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'hello ' },
          });
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden' },
          });
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'world' },
          });
        },
      }),
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
    createSession: async () =>
      createFakePiSession({
        onPrompt: async (text, emit) => {
          promptCount += 1;
          if (promptCount === 1) {
            emit({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: `stale:${text}` },
            });
            await new Promise((resolve) => {
              releaseFirstPrompt = resolve;
            });
            return;
          }

          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: `latest:${text}` },
          });
        },
        onAbort: async () => {
          abortCount += 1;
          releaseFirstPrompt?.();
        },
      }),
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
