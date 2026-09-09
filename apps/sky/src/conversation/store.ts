import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  createSkyHome,
  prepareSqliteDatabase,
  secureSqliteFiles,
  type SkyHome,
} from '../sky-home.js';
import type {
  ConversationStore,
  ConversationSummary,
  PersistedConversation,
} from './types.js';

const CONVERSATION_SCHEMA_VERSION = '4';

type StoreHandles = {
  db: DatabaseSync;
  getStmt: StatementSync;
  listStmt: StatementSync;
  putStmt: StatementSync;
  removeStmt: StatementSync;
};

function createConversationsTable(db: DatabaseSync, tableName = 'conversations'): void {
  db.exec(`
    CREATE TABLE ${tableName} (
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
    )
  `);
}

function getSchemaVersion(db: DatabaseSync): string | undefined {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE name = ?')
    .get('conversation_schema_version') as { value: string } | undefined;
  return row?.value;
}

function hasConversationsTable(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
    .get() as { name: string } | undefined;
  return row !== undefined;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function setSchemaVersion(db: DatabaseSync): void {
  db.prepare('INSERT OR REPLACE INTO schema_meta (name, value) VALUES (?, ?)').run(
    'conversation_schema_version',
    CONVERSATION_SCHEMA_VERSION,
  );
}

function migrateConversationsV1ToV4(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    createConversationsTable(db, 'conversations_v4');
    db.exec(`
      INSERT INTO conversations_v4
        (key, session_id, backend, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      SELECT
        key, session_id, 'pi', session_file, model, agent_name, NULL, created_at, updated_at
      FROM conversations
    `);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_v4 RENAME TO conversations');
    setSchemaVersion(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateConversationsV2OrV3ToV4(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    createConversationsTable(db, 'conversations_v4');
    db.exec(`
      INSERT INTO conversations_v4
        (key, session_id, backend, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      SELECT
        key, session_id, backend, resume_ref, model, agent_name, NULL, created_at, updated_at
      FROM conversations
    `);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_v4 RENAME TO conversations');
    setSchemaVersion(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureSchema(db: DatabaseSync): void {
  // WAL 모드: reader가 writer를 막지 않음 (멀티 프로세스 안전)
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const version = getSchemaVersion(db);
  if (!version) {
    if (!hasConversationsTable(db)) {
      createConversationsTable(db);
    } else if (!hasColumn(db, 'conversations', 'system_prompt')) {
      db.exec('ALTER TABLE conversations ADD COLUMN system_prompt TEXT');
    }
    setSchemaVersion(db);
    return;
  }
  if (version === '1') {
    migrateConversationsV1ToV4(db);
    return;
  }
  if (version === '2' || version === '3') {
    migrateConversationsV2OrV3ToV4(db);
    return;
  }
  if (version !== CONVERSATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported conversation schema version: ${version}`);
  }
}

export function openConversationStore(
  location: string | SkyHome = createSkyHome(),
): ConversationStore {
  const dbPath = prepareSqliteDatabase(location);

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  if (dbPath !== ':memory:') secureSqliteFiles(dbPath);

  const handles: StoreHandles = {
    db,
    getStmt: db.prepare(
      'SELECT session_id, backend, resume_ref, model, agent_name, system_prompt FROM conversations WHERE key = ? AND backend = ?',
    ),
    listStmt: db.prepare(
      `SELECT key, session_id, backend, model, agent_name, created_at, updated_at
       FROM conversations
       WHERE backend = ?
       ORDER BY updated_at DESC, key`,
    ),
    putStmt: db.prepare(
      `INSERT INTO conversations (key, session_id, backend, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, backend) DO UPDATE SET
         session_id = excluded.session_id,
         resume_ref = excluded.resume_ref,
         model = excluded.model,
         agent_name = excluded.agent_name,
         system_prompt = excluded.system_prompt,
         updated_at = excluded.updated_at`,
    ),
    removeStmt: db.prepare('DELETE FROM conversations WHERE key = ? AND backend = ?'),
  };

  return {
    get(key: string, backend: string): PersistedConversation | undefined {
      const row = handles.getStmt.get(key, backend) as
        | {
            session_id: string;
            backend: string;
            resume_ref: string | null;
            model: string;
            agent_name: string;
            system_prompt: string | null;
          }
        | undefined;
      if (!row) {
        return undefined;
      }
      return {
        sessionId: row.session_id,
        backend: row.backend,
        model: row.model,
        agentName: row.agent_name,
        ...(row.resume_ref !== null ? { resumeRef: row.resume_ref } : {}),
        ...(row.system_prompt !== null ? { systemPrompt: row.system_prompt } : {}),
      };
    },

    list(backend: string): ConversationSummary[] {
      const rows = handles.listStmt.all(backend) as Array<{
        key: string;
        session_id: string;
        backend: string;
        model: string;
        agent_name: string;
        created_at: number;
        updated_at: number;
      }>;
      return rows.map((row) => ({
        key: row.key,
        sessionId: row.session_id,
        backend: row.backend,
        model: row.model,
        agentName: row.agent_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    put(key: string, conversation: PersistedConversation): void {
      const now = Date.now();
      handles.putStmt.run(
        key,
        conversation.sessionId,
        conversation.backend,
        conversation.resumeRef ?? null,
        conversation.model,
        conversation.agentName,
        conversation.systemPrompt ?? null,
        now,
        now,
      );
    },

    remove(key: string, backend: string): void {
      handles.removeStmt.run(key, backend);
    },

    close(): void {
      handles.db.close();
    },
  };
}
