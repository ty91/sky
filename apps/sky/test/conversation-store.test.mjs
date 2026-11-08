import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ConversationLinkConflictError,
  UnknownConversationError,
  openConversationStore,
} from '../dist/conversation/store.js';

const SLACK_THREAD = { provider: 'slack', externalId: 'D123:1777901000.000100' };

function tempDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sky-conversation-store-'));
  return { dir, dbPath: path.join(dir, 'sky.db') };
}

function sequentialIds(prefix = 'conversation') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function schemaVersion(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM schema_meta WHERE name = 'conversation_schema_version'").get().value;
  } finally {
    db.close();
  }
}

function tableNames(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
  } finally {
    db.close();
  }
}

function writeLegacyDatabase(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${sql}
  `);
  db.close();
}

const V4_CONVERSATIONS = `
  CREATE TABLE conversations (
    key           TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    backend       TEXT NOT NULL,
    resume_ref    TEXT,
    model         TEXT NOT NULL,
    agent_name    TEXT NOT NULL,
    system_prompt TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (key, backend)
  );
`;

test('conversation store keeps one session slot per backend for an unlinked conversation', () => {
  const store = openConversationStore(':memory:', { createId: sequentialIds() });

  const conversation = store.create();
  assert.deepEqual(conversation.links, []);
  assert.equal(conversation.model, undefined);
  assert.equal(store.getSession(conversation.id, 'pi'), undefined);

  store.putSession(conversation.id, {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.putSession(conversation.id, {
    sessionId: 'claude-session-b',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  store.putSession(conversation.id, {
    sessionId: 'pi-session-c',
    backend: 'pi',
    model: 'anthropic/claude-fable-5-1',
    agentName: 'main',
  });

  assert.deepEqual(store.getSession(conversation.id, 'pi'), {
    sessionId: 'pi-session-c',
    backend: 'pi',
    model: 'anthropic/claude-fable-5-1',
    agentName: 'main',
  });
  assert.deepEqual(store.getSession(conversation.id, 'claude-agent-sdk'), {
    sessionId: 'claude-session-b',
    backend: 'claude-agent-sdk',
    model: 'anthropic/claude-sonnet-4-6',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  assert.deepEqual(store.listSessions('pi').map(({ conversationId, sessionId }) => ({ conversationId, sessionId })), [
    { conversationId: 'conversation-1', sessionId: 'pi-session-c' },
  ]);

  store.removeSession(conversation.id, 'pi');
  assert.equal(store.getSession(conversation.id, 'pi'), undefined);
  assert.equal(store.getSession(conversation.id, 'claude-agent-sdk')?.sessionId, 'claude-session-b');
  assert.equal(store.get(conversation.id)?.id, conversation.id);

  assert.throws(
    () => store.putSession('missing', { sessionId: 's', backend: 'pi', model: '', agentName: 'main' }),
    UnknownConversationError,
  );
  store.close();
});

test('conversation store resolves external links and rejects a second conversation for the same thread', () => {
  const store = openConversationStore(':memory:', { createId: sequentialIds() });

  const linked = store.create({ link: SLACK_THREAD, model: 'anthropic/claude-fable-5-1' });
  assert.deepEqual(store.findByLink(SLACK_THREAD), linked);
  assert.equal(linked.model, 'anthropic/claude-fable-5-1');

  assert.throws(() => store.create({ link: SLACK_THREAD }), ConversationLinkConflictError);
  assert.equal(store.get('conversation-2'), undefined);

  const scheduled = store.create({ id: 'scheduled-run-conversation' });
  assert.deepEqual(store.create({ id: 'scheduled-run-conversation' }), scheduled);
  assert.throws(() => store.link(scheduled.id, SLACK_THREAD), ConversationLinkConflictError);

  const delivered = { provider: 'slack', externalId: 'C777:1777902000.000200' };
  store.link(scheduled.id, delivered);
  store.link(scheduled.id, delivered);
  assert.deepEqual(store.get(scheduled.id)?.links, [delivered]);
  assert.throws(
    () => store.link(scheduled.id, { provider: 'slack', externalId: 'C777:1777903000.000300' }),
    ConversationLinkConflictError,
  );
  assert.throws(() => store.link('missing', delivered), UnknownConversationError);

  store.setModel(linked.id, 'anthropic/claude-opus-5-5');
  assert.equal(store.get(linked.id)?.model, 'anthropic/claude-opus-5-5');
  store.close();
});

test('conversation store keeps conversations, links, and sessions across reopen', () => {
  const { dir, dbPath } = tempDatabase();
  const first = openConversationStore(dbPath);
  const conversation = first.create({ link: SLACK_THREAD });
  first.putSession(conversation.id, {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    resumeRef: 'claude-session-a',
    model: 'anthropic/test',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  first.close();

  const reopened = openConversationStore(dbPath);
  assert.equal(reopened.findByLink(SLACK_THREAD)?.id, conversation.id);
  assert.deepEqual(reopened.getSession(conversation.id, 'claude-agent-sdk'), {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    resumeRef: 'claude-session-a',
    model: 'anthropic/test',
    agentName: 'main',
    systemPrompt: 'frozen prompt',
  });
  reopened.close();
  assert.equal(schemaVersion(dbPath), '5');
  rmSync(dir, { recursive: true, force: true });
});

test('conversation store migrates v4 Slack threads, thread models, and scheduled keys into conversations', () => {
  const { dir, dbPath } = tempDatabase();
  writeLegacyDatabase(dbPath, `
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '4');
    ${V4_CONVERSATIONS}
    INSERT INTO conversations VALUES
      ('D123:1777901000.000100', 'pi-session-a', 'pi', '/tmp/pi-session-a.jsonl', 'anthropic/claude-opus-4-7', 'main', 'frozen pi prompt', 100, 200),
      ('D123:1777901000.000100', 'claude-session-a', 'claude-agent-sdk', 'claude-session-a', 'anthropic/claude-fable-5-1', 'main', 'frozen claude prompt', 150, 300),
      ('scheduled:job-1', 'pi-session-s', 'pi', NULL, 'anthropic/claude-opus-4-7', 'main', NULL, 400, 500);
    CREATE TABLE thread_models (
      key TEXT PRIMARY KEY, model TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO thread_models VALUES
      ('D123:1777901000.000100', 'anthropic/claude-fable-5-1', 50, 60),
      ('C456:1777904000.000400', 'anthropic/claude-opus-5-5', 700, 800);
  `);

  const store = openConversationStore(dbPath, { createId: sequentialIds('migrated') });
  const slack = store.findByLink(SLACK_THREAD);
  assert.ok(slack);
  assert.equal(slack.model, 'anthropic/claude-fable-5-1');
  assert.equal(slack.createdAt, 50);
  assert.equal(slack.updatedAt, 300);
  assert.deepEqual(store.getSession(slack.id, 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
    systemPrompt: 'frozen pi prompt',
  });
  assert.deepEqual(store.getSession(slack.id, 'claude-agent-sdk'), {
    sessionId: 'claude-session-a',
    backend: 'claude-agent-sdk',
    resumeRef: 'claude-session-a',
    model: 'anthropic/claude-fable-5-1',
    agentName: 'main',
    systemPrompt: 'frozen claude prompt',
  });

  const modelOnly = store.findByLink({ provider: 'slack', externalId: 'C456:1777904000.000400' });
  assert.equal(modelOnly?.model, 'anthropic/claude-opus-5-5');
  assert.equal(store.getSession(modelOnly.id, 'pi'), undefined);

  const pi = store.listSessions('pi');
  assert.equal(pi.length, 2);
  const scheduled = pi.find(({ sessionId }) => sessionId === 'pi-session-s');
  assert.deepEqual(scheduled.links, []);
  assert.equal(store.get(scheduled.conversationId)?.model, undefined);
  store.close();

  assert.equal(schemaVersion(dbPath), '5');
  assert.deepEqual(tableNames(dbPath), ['conversation_links', 'conversation_sessions', 'conversations', 'schema_meta']);

  const reopened = openConversationStore(dbPath, { createId: sequentialIds('duplicate') });
  assert.equal(reopened.findByLink(SLACK_THREAD)?.id, slack.id);
  assert.equal(reopened.listSessions('pi').length, 2);
  assert.equal(reopened.listSessions('claude-agent-sdk').length, 1);
  reopened.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_links').get().count, 2);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a failed v4 migration leaves the legacy records intact and succeeds when retried', () => {
  const { dir, dbPath } = tempDatabase();
  writeLegacyDatabase(dbPath, `
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '4');
    ${V4_CONVERSATIONS}
    INSERT INTO conversations VALUES
      ('D123:1777901000.000100', 'pi-session-a', 'pi', NULL, 'anthropic/test', 'main', NULL, 100, 200);
    CREATE TABLE conversation_sessions (blocker TEXT);
  `);

  assert.throws(() => openConversationStore(dbPath));
  assert.equal(schemaVersion(dbPath), '4');
  const legacy = new DatabaseSync(dbPath);
  assert.equal(legacy.prepare('SELECT session_id FROM conversations').get().session_id, 'pi-session-a');
  assert.ok(!tableNames(dbPath).includes('legacy_conversations_v4'));
  legacy.exec('DROP TABLE conversation_sessions');
  legacy.close();

  const store = openConversationStore(dbPath);
  const conversation = store.findByLink(SLACK_THREAD);
  assert.equal(store.getSession(conversation.id, 'pi')?.sessionId, 'pi-session-a');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('conversation store migrates v1 session_file records through v4 into conversations', () => {
  const { dir, dbPath } = tempDatabase();
  writeLegacyDatabase(dbPath, `
    INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '1');
    CREATE TABLE conversations (
      key TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_file TEXT NOT NULL, model TEXT NOT NULL,
      agent_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO conversations VALUES
      ('D123:1777901000.000100', 'pi-session-a', '/tmp/pi-session-a.jsonl', 'anthropic/claude-opus-4-7', 'main', 100, 200);
  `);

  const store = openConversationStore(dbPath);
  const conversation = store.findByLink(SLACK_THREAD);
  assert.deepEqual(store.getSession(conversation.id, 'pi'), {
    sessionId: 'pi-session-a',
    backend: 'pi',
    resumeRef: '/tmp/pi-session-a.jsonl',
    model: 'anthropic/claude-opus-4-7',
    agentName: 'main',
  });
  store.close();
  assert.equal(schemaVersion(dbPath), '5');
  rmSync(dir, { recursive: true, force: true });
});

for (const version of ['2', '3']) {
  test(`conversation store migrates v${version} backend records through v4 into conversations`, () => {
    const { dir, dbPath } = tempDatabase();
    writeLegacyDatabase(dbPath, `
      INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '${version}');
      CREATE TABLE conversations (
        key TEXT NOT NULL, session_id TEXT NOT NULL, backend TEXT NOT NULL, resume_ref TEXT, model TEXT NOT NULL,
        agent_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, backend)
      );
      INSERT INTO conversations VALUES
        ('D123:1777901000.000100', 'claude-session-a', 'claude-agent-sdk', NULL, 'anthropic/claude-opus-4-7', 'main', 100, 200);
    `);

    const store = openConversationStore(dbPath);
    const conversation = store.findByLink(SLACK_THREAD);
    assert.deepEqual(store.getSession(conversation.id, 'claude-agent-sdk'), {
      sessionId: 'claude-session-a',
      backend: 'claude-agent-sdk',
      model: 'anthropic/claude-opus-4-7',
      agentName: 'main',
    });
    store.close();
    assert.equal(schemaVersion(dbPath), '5');
    rmSync(dir, { recursive: true, force: true });
  });
}

test('conversation store refuses an unknown future schema version', () => {
  const { dir, dbPath } = tempDatabase();
  writeLegacyDatabase(dbPath, "INSERT INTO schema_meta (name, value) VALUES ('conversation_schema_version', '6');");
  assert.throws(() => openConversationStore(dbPath), /Unsupported conversation schema version: 6/);
  rmSync(dir, { recursive: true, force: true });
});
