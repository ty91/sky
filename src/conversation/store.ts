import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SKY_DIR } from '../settings.js';
import type { ConversationStore, PersistedConversation } from './types.js';

const DEFAULT_DB_PATH = path.join(SKY_DIR, 'sky.db');

type StoreHandles = {
  db: DatabaseSync;
  getStmt: StatementSync;
  putStmt: StatementSync;
  removeStmt: StatementSync;
};

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      key           TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      session_file  TEXT NOT NULL,
      model         TEXT NOT NULL,
      agent_name    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `);

  db.prepare('INSERT OR REPLACE INTO schema_meta (name, value) VALUES (?, ?)').run(
    'conversation_schema_version',
    '1',
  );
}

export function openConversationStore(dbPath: string = DEFAULT_DB_PATH): ConversationStore {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);

  const handles: StoreHandles = {
    db,
    getStmt: db.prepare(
      'SELECT session_id, session_file, model, agent_name FROM conversations WHERE key = ?',
    ),
    putStmt: db.prepare(
      `INSERT INTO conversations (key, session_id, session_file, model, agent_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id,
         session_file = excluded.session_file,
         model = excluded.model,
         agent_name = excluded.agent_name,
         updated_at = excluded.updated_at`,
    ),
    removeStmt: db.prepare('DELETE FROM conversations WHERE key = ?'),
  };

  return {
    get(key: string): PersistedConversation | undefined {
      const row = handles.getStmt.get(key) as
        | { session_id: string; session_file: string; model: string; agent_name: string }
        | undefined;
      if (!row) {
        return undefined;
      }
      return {
        sessionId: row.session_id,
        sessionFile: row.session_file,
        model: row.model,
        agentName: row.agent_name,
      };
    },

    put(key: string, conversation: PersistedConversation): void {
      const now = Date.now();
      handles.putStmt.run(
        key,
        conversation.sessionId,
        conversation.sessionFile,
        conversation.model,
        conversation.agentName,
        now,
        now,
      );
    },

    remove(key: string): void {
      handles.removeStmt.run(key);
    },

    close(): void {
      handles.db.close();
    },
  };
}
