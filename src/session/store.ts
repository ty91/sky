import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { JOY_DIR } from '../settings.js';

const DEFAULT_DB_PATH = path.join(JOY_DIR, 'joy.db');
const LEGACY_JSON_PATH = path.join(JOY_DIR, 'sessions.json');

export type PersistedSession = {
  sessionId: string;
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
      system_prompt  TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `);

  const row = db
    .prepare('SELECT value FROM schema_meta WHERE name = ?')
    .get('schema_version') as { value: string } | undefined;

  if (!row) {
    db.prepare('INSERT INTO schema_meta (name, value) VALUES (?, ?)').run('schema_version', '1');
  }
}

/**
 * Import legacy `~/.joy/sessions.json` into the sqlite store.
 *
 * Only runs when:
 *   - The legacy file exists.
 *   - The sessions table is empty (first-time migration).
 *
 * After a successful import the JSON file is renamed to `sessions.json.bak`
 * so it can be restored manually if needed.
 */
function migrateLegacyJson(db: DatabaseSync): void {
  if (!existsSync(LEGACY_JSON_PATH)) {
    return;
  }

  const count = db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number };
  if (count.n > 0) {
    // Already migrated (or store populated by another path). Leave legacy file alone.
    return;
  }

  let legacy: Record<string, string>;
  try {
    legacy = JSON.parse(readFileSync(LEGACY_JSON_PATH, 'utf8')) as Record<string, string>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[session-store] failed to read legacy sessions.json: ${message}`);
    return;
  }

  const entries = Object.entries(legacy).filter(
    ([, sessionId]) => typeof sessionId === 'string' && sessionId.length > 0,
  );

  if (entries.length === 0) {
    // Still rename so we don't try again every boot.
    renameSync(LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.bak`);
    return;
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO sessions (key, session_id, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();

  db.exec('BEGIN');
  try {
    for (const [key, sessionId] of entries) {
      // systemPrompt stays empty — Commit 2 will fall back to the boot snapshot
      // on the first resume and then persist it for subsequent runs.
      insert.run(key, sessionId, '', now, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  renameSync(LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.bak`);
  console.log(`[session-store] migrated ${entries.length} session(s) from sessions.json`);
}

export function openSessionStore(dbPath: string = DEFAULT_DB_PATH): SessionStore {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  migrateLegacyJson(db);

  const handles: StoreHandles = {
    db,
    getStmt: db.prepare('SELECT session_id, system_prompt FROM sessions WHERE key = ?'),
    putStmt: db.prepare(
      `INSERT INTO sessions (key, session_id, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id,
         system_prompt = excluded.system_prompt,
         updated_at = excluded.updated_at`,
    ),
    removeStmt: db.prepare('DELETE FROM sessions WHERE key = ?'),
  };

  return {
    get(key: string): PersistedSession | undefined {
      const row = handles.getStmt.get(key) as
        | { session_id: string; system_prompt: string }
        | undefined;
      if (!row) return undefined;
      return {
        sessionId: row.session_id,
        systemPrompt: row.system_prompt,
      };
    },

    put(key: string, session: PersistedSession): void {
      const now = Date.now();
      handles.putStmt.run(key, session.sessionId, session.systemPrompt, now, now);
    },

    remove(key: string): void {
      handles.removeStmt.run(key);
    },

    close(): void {
      handles.db.close();
    },
  };
}
