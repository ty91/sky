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
