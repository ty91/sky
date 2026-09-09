import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-thread-model-'));
process.env.HOME = homeDir;

const { openThreadModelStore } = await import('../dist/conversation/thread-model-store.js');

test.after(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('thread model store persists, overwrites, and removes per-thread models', () => {
  const dbPath = path.join(homeDir, 'thread-models.db');
  const store = openThreadModelStore(dbPath);

  assert.equal(store.get('C1:1.0'), undefined);

  store.set('C1:1.0', 'anthropic/claude-fable-5');
  store.set('C2:2.0', 'anthropic/claude-opus-5');
  assert.equal(store.get('C1:1.0'), 'anthropic/claude-fable-5');
  assert.equal(store.get('C2:2.0'), 'anthropic/claude-opus-5');

  store.set('C1:1.0', 'anthropic/claude-sonnet-5');
  assert.equal(store.get('C1:1.0'), 'anthropic/claude-sonnet-5');

  store.remove('C1:1.0');
  assert.equal(store.get('C1:1.0'), undefined);
  assert.equal(store.get('C2:2.0'), 'anthropic/claude-opus-5');

  store.close();

  // Survives a restart: the model lives in sqlite, not in memory.
  const reopened = openThreadModelStore(dbPath);
  assert.equal(reopened.get('C2:2.0'), 'anthropic/claude-opus-5');
  reopened.close();
});

test('thread model store shares a database file with other sky stores', async () => {
  const dbPath = path.join(homeDir, 'shared.db');
  const { openConversationStore } = await import('../dist/conversation/store.js');

  const conversations = openConversationStore(dbPath);
  const models = openThreadModelStore(dbPath);

  models.set('C9:9.0', 'anthropic/claude-fable-5');
  conversations.put('C9:9.0', {
    sessionId: 'session-9',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-fable-5',
    agentName: 'main',
  });

  assert.equal(models.get('C9:9.0'), 'anthropic/claude-fable-5');
  assert.equal(conversations.get('C9:9.0', 'claude-agent-sdk').sessionId, 'session-9');

  models.close();
  conversations.close();
});
