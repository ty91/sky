import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getUnreadTranscripts } from '../dist/agents/memory/cursors.js';
import { prepareConversationStorage } from '../dist/conversation/storage-migration.js';
import { openConversationStore } from '../dist/conversation/store.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';

const THREAD = 'D123:1777901000.000100';
const TRANSCRIPT = '### user (2026-11-01T00:00:00.000Z)\n\nold\n\n';
const APPENDED = '### user (2026-11-02T00:00:00.000Z)\n\nnew\n\n';

function createLegacyHome() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'sky-storage-migration-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const db = new DatabaseSync(skyHome.databaseFile);
  db.exec(`
    CREATE TABLE schema_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('conversation_schema_version', '4');
    CREATE TABLE conversations (
      key TEXT NOT NULL, session_id TEXT NOT NULL, backend TEXT NOT NULL, resume_ref TEXT, model TEXT NOT NULL,
      agent_name TEXT NOT NULL, system_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, backend)
    );
    INSERT INTO conversations VALUES ('${THREAD}', 'pi-session-a', 'pi', NULL, 'anthropic/test', 'main', NULL, 100, 200);
  `);
  db.close();
  writeTranscript(skyHome, THREAD, 'pi-session-a.md', TRANSCRIPT);
  writeTranscript(skyHome, 'unmapped-chat', 'session-x.md', TRANSCRIPT);
  writeCursors(skyHome, {
    [`${THREAD}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
    'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
  });
  return { rootDir, skyHome };
}

function writeTranscript(skyHome, chat, file, content) {
  const directory = path.join(skyHome.transcriptsDir, chat);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, file), content, { mode: 0o600 });
}

function writeCursors(skyHome, cursors) {
  writeFileSync(skyHome.memoryCursorFile, JSON.stringify(cursors), { mode: 0o600 });
}

function readCursors(skyHome) {
  return JSON.parse(readFileSync(skyHome.memoryCursorFile, 'utf8'));
}

function conversationIdFor(skyHome) {
  const store = openConversationStore(skyHome);
  try {
    return store.findByLink({ provider: 'slack', externalId: THREAD }).id;
  } finally {
    store.close();
  }
}

test('startup migration moves Slack transcripts and memory cursors to the conversation id', () => {
  const { rootDir, skyHome } = createLegacyHome();
  try {
    prepareConversationStorage(skyHome);
    const conversationId = conversationIdFor(skyHome);

    assert.deepEqual(readdirSync(skyHome.transcriptsDir).toSorted(), [conversationId, 'unmapped-chat'].toSorted());
    assert.equal(readFileSync(path.join(skyHome.transcriptsDir, conversationId, 'pi-session-a.md'), 'utf8'), TRANSCRIPT);
    assert.deepEqual(readCursors(skyHome), {
      [`${conversationId}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
    });
    assert.deepEqual(getUnreadTranscripts(skyHome), []);

    writeFileSync(path.join(skyHome.transcriptsDir, conversationId, 'pi-session-a.md'), TRANSCRIPT + APPENDED);
    assert.deepEqual(getUnreadTranscripts(skyHome).map(({ relativePath, newContent }) => ({ relativePath, newContent })), [
      { relativePath: `${conversationId}/pi-session-a.md`, newContent: APPENDED },
    ]);

    prepareConversationStorage(skyHome);
    assert.equal(conversationIdFor(skyHome), conversationId);
    assert.deepEqual(readdirSync(skyHome.transcriptsDir).toSorted(), [conversationId, 'unmapped-chat'].toSorted());
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup migration finishes a transcript move interrupted after the cursor update', () => {
  const { rootDir, skyHome } = createLegacyHome();
  try {
    const conversationId = conversationIdFor(skyHome);
    writeCursors(skyHome, {
      [`${THREAD}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      [`${conversationId}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
    });

    prepareConversationStorage(skyHome);

    assert.equal(existsSync(path.join(skyHome.transcriptsDir, THREAD)), false);
    assert.deepEqual(readCursors(skyHome), {
      [`${conversationId}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
    });
    assert.deepEqual(getUnreadTranscripts(skyHome).map(({ relativePath }) => relativePath), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup migration prunes stale cursors after the directory moved and merges a partially moved directory', () => {
  const { rootDir, skyHome } = createLegacyHome();
  try {
    const conversationId = conversationIdFor(skyHome);
    writeTranscript(skyHome, conversationId, 'pi-session-b.md', TRANSCRIPT);
    writeCursors(skyHome, {
      [`${THREAD}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      [`${THREAD}/pi-session-b.md`]: Buffer.byteLength(TRANSCRIPT),
      [`${conversationId}/pi-session-b.md`]: Buffer.byteLength(TRANSCRIPT),
      'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
    });

    prepareConversationStorage(skyHome);

    assert.equal(existsSync(path.join(skyHome.transcriptsDir, THREAD)), false);
    assert.deepEqual(readdirSync(path.join(skyHome.transcriptsDir, conversationId)).toSorted(), ['pi-session-a.md', 'pi-session-b.md']);
    assert.deepEqual(readCursors(skyHome), {
      [`${conversationId}/pi-session-a.md`]: Buffer.byteLength(TRANSCRIPT),
      [`${conversationId}/pi-session-b.md`]: Buffer.byteLength(TRANSCRIPT),
      'unmapped-chat/session-x.md': Buffer.byteLength(TRANSCRIPT),
    });
    assert.deepEqual(getUnreadTranscripts(skyHome), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
