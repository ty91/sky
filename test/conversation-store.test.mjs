import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openConversationStore } from '../dist/conversation/store.js';

test('conversation store round-trips backend resume references', () => {
  const store = openConversationStore(':memory:');

  assert.equal(store.get('missing', 'pi'), undefined);

  store.put('thread-1', {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });

  store.put('thread-1', {
    sessionId: 'claude-session-b',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'dream',
    systemPrompt: 'frozen prompt',
  });
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.deepEqual(store.get('thread-1', 'claude-agent-sdk'), {
    sessionId: 'claude-session-b',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'dream',
    systemPrompt: 'frozen prompt',
  });

  store.remove('thread-1', 'claude-agent-sdk');
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.equal(store.get('thread-1', 'claude-agent-sdk'), undefined);

  store.remove('thread-1', 'pi');
  assert.equal(store.get('thread-1', 'pi'), undefined);

  store.close();
});

test('conversation store migrates v1 session_file records to backend-scoped v4 records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sky-conversation-store-'));
  const dbPath = path.join(dir, 'sky.db');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '1');
    CREATE TABLE conversations (
      key           TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      session_file  TEXT NOT NULL,
      model         TEXT NOT NULL,
      agent_name    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    INSERT INTO conversations
      (key, session_id, session_file, model, agent_name, created_at, updated_at)
    VALUES
      ('thread-1', 'pi-session-a', '/tmp/pi-session-a.jsonl', 'anthropic/claude-opus-4-7', 'main', 100, 200);
  `);
  db.close();

  const store = openConversationStore(dbPath);
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(
    migrated
      .prepare("SELECT value FROM schema_meta WHERE name = 'conversation_schema_version'")
      .get().value,
    '4',
  );
  const migratedRow = migrated
    .prepare("SELECT backend, resume_ref, system_prompt FROM conversations WHERE key = 'thread-1'")
    .get();
  assert.deepEqual(
    { ...migratedRow },
    { backend: 'pi', resume_ref: '/tmp/pi-session-a.jsonl', system_prompt: null },
  );
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test('conversation store migrates v2 records to backend-scoped v4 records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sky-conversation-store-'));
  const dbPath = path.join(dir, 'sky.db');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '2');
    CREATE TABLE conversations (
      key           TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      backend       TEXT NOT NULL,
      resume_ref    TEXT,
      model         TEXT NOT NULL,
      agent_name    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    INSERT INTO conversations
      (key, session_id, backend, resume_ref, model, agent_name, created_at, updated_at)
    VALUES
      ('thread-1', 'pi-session-a', 'pi', '/tmp/pi-session-a.jsonl', 'anthropic/claude-opus-4-7', 'main', 100, 200);
  `);
  db.close();

  const store = openConversationStore(dbPath);
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.put('thread-1', {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.deepEqual(store.get('thread-1', 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  assert.equal(store.get('thread-1', 'claude-agent-sdk')?.sessionId, 'claude-session-a');
  store.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(
    migrated
      .prepare("SELECT value FROM schema_meta WHERE name = 'conversation_schema_version'")
      .get().value,
    '4',
  );
  assert.equal(
    migrated.prepare("SELECT COUNT(*) AS count FROM conversations WHERE key = 'thread-1'").get()
      .count,
    2,
  );
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test('conversation store migrates v3 records and preserves new system prompt snapshots', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sky-conversation-store-'));
  const dbPath = path.join(dir, 'sky.db');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '3');
    CREATE TABLE conversations (
      key           TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      backend       TEXT NOT NULL,
      resume_ref    TEXT,
      model         TEXT NOT NULL,
      agent_name    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (key, backend)
    );
    INSERT INTO conversations
      (key, session_id, backend, resume_ref, model, agent_name, created_at, updated_at)
    VALUES
      ('thread-1', 'claude-session-a', 'claude-agent-sdk', NULL, 'anthropic/claude-opus-4-7', 'main', 100, 200);
  `);
  db.close();

  const store = openConversationStore(dbPath);
  assert.deepEqual(store.get('thread-1', 'claude-agent-sdk'), {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.put('thread-1', {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  assert.equal(store.get('thread-1', 'claude-agent-sdk')?.systemPrompt, 'frozen prompt');
  store.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(
    migrated
      .prepare("SELECT value FROM schema_meta WHERE name = 'conversation_schema_version'")
      .get().value,
    '4',
  );
  assert.equal(
    migrated
      .prepare("SELECT system_prompt FROM conversations WHERE key = 'thread-1'")
      .get().system_prompt,
    'frozen prompt',
  );
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});
