import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  createSkyHome,
  prepareSqliteDatabase,
  secureSqliteFiles,
  type SkyHome,
} from '../sky-home.js';
import type { ThreadModelReader } from './types.js';

/**
 * Per-thread model override, set by the `!model` chat command before the
 * conversation starts.
 *
 * Kept separate from the `conversations` table on purpose: a `!model` command
 * does not run an agent turn, so there is no session id to persist yet, and
 * `conversations.session_id` is NOT NULL.
 */
export interface ThreadModelStore extends ThreadModelReader {
  set(key: string, model: string): void;
  remove(key: string): void;
  close(): void;
}

type StoreHandles = {
  db: DatabaseSync;
  getStmt: StatementSync;
  setStmt: StatementSync;
  removeStmt: StatementSync;
};

function ensureSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_models (
      key        TEXT PRIMARY KEY,
      model      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function openThreadModelStore(
  location: string | SkyHome = createSkyHome(),
): ThreadModelStore {
  const dbPath = prepareSqliteDatabase(location);

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  if (dbPath !== ':memory:') secureSqliteFiles(dbPath);

  const handles: StoreHandles = {
    db,
    getStmt: db.prepare('SELECT model FROM thread_models WHERE key = ?'),
    setStmt: db.prepare(
      `INSERT INTO thread_models (key, model, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         model = excluded.model,
         updated_at = excluded.updated_at`,
    ),
    removeStmt: db.prepare('DELETE FROM thread_models WHERE key = ?'),
  };

  return {
    get(key: string): string | undefined {
      const row = handles.getStmt.get(key) as { model: string } | undefined;
      return row?.model;
    },

    set(key: string, model: string): void {
      const now = Date.now();
      handles.setStmt.run(key, model, now, now);
    },

    remove(key: string): void {
      handles.removeStmt.run(key);
    },

    close(): void {
      handles.db.close();
    },
  };
}
