import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../dist/session/manager.js';

test('session manager creates sessions and persists new session ids', async () => {
  const created = [];
  const sendCalls = [];
  const closeCalls = [];
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    onSessionCreated: (key, sessionId) => {
      created.push({ key, sessionId });
    },
    providerFactory: {
      create: (config) => ({
        send: async (text) => {
          sendCalls.push({ text, config });
        },
        collect: async () => ({ text: 'reply', sessionId: 'session-1' }),
        close: async () => {
          closeCalls.push(config.systemPrompt);
        },
      }),
    },
  });

  manager.open('thread-1', {
    name: 'main',
    systemPrompt: 'system',
    model: 'opus',
    tools: ['Read'],
  });

  const result = await manager.send('thread-1', 'hello');

  assert.deepEqual(result, { kind: 'ok', text: 'reply' });
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].config.cwd, '/tmp/workspace');
  assert.deepEqual(created, [{ key: 'thread-1', sessionId: 'session-1' }]);
  assert.equal(manager.getSessionId('thread-1'), 'session-1');

  await manager.close('thread-1');
  assert.deepEqual(closeCalls, ['system']);
});

test('session manager reports busy and missing sessions', async () => {
  const manager = createSessionManager({
    defaultCwd: '/tmp/workspace',
    providerFactory: {
      create: () => ({
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        collect: async () => ({ text: 'reply' }),
        close: async () => {},
      }),
    },
  });

  const missing = await manager.send('missing', 'hello');
  assert.equal(missing.kind, 'error');

  manager.open('thread-1', {
    name: 'main',
    systemPrompt: 'system',
  });

  const first = manager.send('thread-1', 'hello');
  const second = await manager.send('thread-1', 'again');

  assert.deepEqual(second, { kind: 'busy' });
  await first;
});
