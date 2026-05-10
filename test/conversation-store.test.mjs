import test from 'node:test';
import assert from 'node:assert/strict';
import { openConversationStore } from '../dist/conversation/store.js';

test('conversation store round-trips Pi session file records', () => {
  const store = openConversationStore(':memory:');

  assert.equal(store.get('missing'), undefined);

  store.put('thread-1', {
    sessionId: 'pi-session-a',
    sessionFile: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.deepEqual(store.get('thread-1'), {
    sessionId: 'pi-session-a',
    sessionFile: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });

  store.put('thread-1', {
    sessionId: 'pi-session-b',
    sessionFile: '/tmp/pi-session-b.jsonl',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'dream',
  });
  assert.deepEqual(store.get('thread-1'), {
    sessionId: 'pi-session-b',
    sessionFile: '/tmp/pi-session-b.jsonl',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'dream',
  });

  store.remove('thread-1');
  assert.equal(store.get('thread-1'), undefined);

  store.close();
});
