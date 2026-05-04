import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SKY_DIR } from '../settings.js';

const DEFAULT_DB_PATH = path.join(SKY_DIR, 'sky.db');

export type PersistedSession = {
  sessionId: string;
  model: string;
  systemPrompt: string;
};

export interface SessionStore {
  get(key: string): PersistedSession | undefined;
  put(key: string, session: PersistedSession): void;
  remove(key: string): void;
  close(): void;
}

type StoreHandles = {
  db: DatabaseSync;
  getStmt: StatementSync;
  putStmt: StatementSync;
  removeStmt: StatementSync;
};

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      key            TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      model          TEXT NOT NULL DEFAULT '',
      system_prompt  TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `);

  if (!hasColumn(db, 'sessions', 'model')) {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }

  const row = db
    .prepare('SELECT value FROM schema_meta WHERE name = ?')
    .get('schema_version') as { value: string } | undefined;

  if (!row) {
    db.prepare('INSERT INTO schema_meta (name, value) VALUES (?, ?)').run('schema_version', '2');
    return;
  }

  if (row.value !== '2') {
    db.prepare('UPDATE schema_meta SET value = ? WHERE name = ?').run('2', 'schema_version');
  }
}

export function openSessionStore(dbPath: string = DEFAULT_DB_PATH): SessionStore {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);

  const handles: StoreHandles = {
    db,
    getStmt: db.prepare('SELECT session_id, model, system_prompt FROM sessions WHERE key = ?'),
    putStmt: db.prepare(
      `INSERT INTO sessions (key, session_id, model, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id,
         model = excluded.model,
         system_prompt = excluded.system_prompt,
         updated_at = excluded.updated_at`,
    ),
    removeStmt: db.prepare('DELETE FROM sessions WHERE key = ?'),
  };

  return {
    get(key: string): PersistedSession | undefined {
      const row = handles.getStmt.get(key) as
        | { session_id: string; model: string; system_prompt: string }
        | undefined;
      if (!row) return undefined;
      return {
        sessionId: row.session_id,
        model: row.model,
        systemPrompt: row.system_prompt,
      };
    },

    put(key: string, session: PersistedSession): void {
      const now = Date.now();
      handles.putStmt.run(key, session.sessionId, session.model, session.systemPrompt, now, now);
    },

    remove(key: string): void {
      handles.removeStmt.run(key);
    },

    close(): void {
      handles.db.close();
    },
  };
}
