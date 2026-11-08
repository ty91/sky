import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  createSkyHome,
  prepareSqliteDatabase,
  secureSqliteFiles,
  type SkyHome,
} from '../sky-home.js';
import type {
  ConversationLink,
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
  CreateConversationOptions,
  PersistedSession,
} from './types.js';

const CONVERSATION_SCHEMA_VERSION = '5';
export const LEGACY_SLACK_PROVIDER = 'slack';
const LEGACY_SLACK_THREAD_KEY = /^[A-Z0-9]+:\d+\.\d+$/;

export class ConversationLinkConflictError extends Error {
  constructor(link: ConversationLink) {
    super(`Conversation link ${link.provider}:${link.externalId} conflicts with an existing link.`);
    this.name = 'ConversationLinkConflictError';
  }
}

export class UnknownConversationError extends Error {
  constructor(id: string) {
    super(`Conversation ${id} does not exist.`);
    this.name = 'UnknownConversationError';
  }
}

export function newConversationId(): string {
  return randomUUID();
}

type ConversationRow = {
  id: string;
  model: string | null;
  created_at: number;
  updated_at: number;
};

type LinkRow = {
  conversation_id: string;
  provider: string;
  external_id: string;
};

type SessionRow = {
  conversation_id: string;
  session_id: string;
  backend: string;
  resume_ref: string | null;
  model: string;
  agent_name: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
};

type LegacyConversationRow = {
  key: string;
  session_id: string;
  backend: string;
  resume_ref: string | null;
  model: string;
  agent_name: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
};

type LegacyThreadModelRow = {
  key: string;
  model: string;
  created_at: number;
  updated_at: number;
};

function createLegacyConversationsTable(db: DatabaseSync, tableName: string): void {
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

function createConversationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE conversations (
      id         TEXT PRIMARY KEY,
      model      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversation_links (
      provider        TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (provider, external_id),
      UNIQUE (conversation_id, provider)
    );
    CREATE TABLE conversation_sessions (
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      backend         TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      resume_ref      TEXT,
      model           TEXT NOT NULL,
      agent_name      TEXT NOT NULL,
      system_prompt   TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, backend)
    );
  `);
}

function getSchemaVersion(db: DatabaseSync): string | undefined {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE name = ?')
    .get('conversation_schema_version') as { value: string } | undefined;
  return row?.value;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | null | undefined;
  return row != null;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function setSchemaVersion(db: DatabaseSync, version: string): void {
  db.prepare('INSERT OR REPLACE INTO schema_meta (name, value) VALUES (?, ?)').run(
    'conversation_schema_version',
    version,
  );
}

function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateConversationsV1ToV4(db: DatabaseSync): void {
  inTransaction(db, () => {
    createLegacyConversationsTable(db, 'conversations_v4');
    db.exec(`
      INSERT INTO conversations_v4
        (key, session_id, backend, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      SELECT
        key, session_id, 'pi', session_file, model, agent_name, NULL, created_at, updated_at
      FROM conversations
    `);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_v4 RENAME TO conversations');
    setSchemaVersion(db, '4');
  });
}

function migrateConversationsV2OrV3ToV4(db: DatabaseSync): void {
  inTransaction(db, () => {
    createLegacyConversationsTable(db, 'conversations_v4');
    db.exec(`
      INSERT INTO conversations_v4
        (key, session_id, backend, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      SELECT
        key, session_id, backend, resume_ref, model, agent_name, NULL, created_at, updated_at
      FROM conversations
    `);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_v4 RENAME TO conversations');
    setSchemaVersion(db, '4');
  });
}

type LegacyConversation = {
  createdAt: number;
  updatedAt: number;
  model?: string;
};

function migrateConversationsV4ToV5(db: DatabaseSync, createId: () => string): void {
  inTransaction(db, () => {
    db.exec('ALTER TABLE conversations RENAME TO legacy_conversations_v4');
    createConversationTables(db);

    const sessions = db
      .prepare('SELECT * FROM legacy_conversations_v4 ORDER BY key, backend')
      .all() as LegacyConversationRow[];
    const threadModels = hasTable(db, 'thread_models')
      ? (db.prepare('SELECT key, model, created_at, updated_at FROM thread_models ORDER BY key').all() as LegacyThreadModelRow[])
      : [];

    const legacy = new Map<string, LegacyConversation>();
    const remember = (key: string, createdAt: number, updatedAt: number, model?: string) => {
      const current = legacy.get(key);
      legacy.set(key, {
        createdAt: Math.min(current?.createdAt ?? createdAt, createdAt),
        updatedAt: Math.max(current?.updatedAt ?? updatedAt, updatedAt),
        ...(model !== undefined ? { model } : current?.model !== undefined ? { model: current.model } : {}),
      });
    };
    for (const session of sessions) remember(session.key, session.created_at, session.updated_at);
    for (const threadModel of threadModels) {
      remember(threadModel.key, threadModel.created_at, threadModel.updated_at, threadModel.model);
    }

    const insertConversation = db.prepare(
      'INSERT INTO conversations (id, model, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    const insertLink = db.prepare(
      'INSERT INTO conversation_links (provider, external_id, conversation_id, created_at) VALUES (?, ?, ?, ?)',
    );
    const insertSession = db.prepare(`
      INSERT INTO conversation_sessions
        (conversation_id, backend, session_id, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ids = new Map<string, string>();
    for (const [key, conversation] of legacy) {
      const id = createId();
      ids.set(key, id);
      insertConversation.run(id, conversation.model ?? null, conversation.createdAt, conversation.updatedAt);
      if (LEGACY_SLACK_THREAD_KEY.test(key)) {
        insertLink.run(LEGACY_SLACK_PROVIDER, key, id, conversation.createdAt);
      }
    }
    for (const session of sessions) {
      insertSession.run(
        ids.get(session.key)!,
        session.backend,
        session.session_id,
        session.resume_ref,
        session.model,
        session.agent_name,
        session.system_prompt,
        session.created_at,
        session.updated_at,
      );
    }

    db.exec('DROP TABLE legacy_conversations_v4');
    db.exec('DROP TABLE IF EXISTS thread_models');
    setSchemaVersion(db, CONVERSATION_SCHEMA_VERSION);
  });
}

function ensureSchema(db: DatabaseSync, createId: () => string): void {
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

  let version = getSchemaVersion(db);
  if (!version) {
    if (!hasTable(db, 'conversations')) {
      inTransaction(db, () => {
        createConversationTables(db);
        setSchemaVersion(db, CONVERSATION_SCHEMA_VERSION);
      });
      return;
    }
    if (!hasColumn(db, 'conversations', 'system_prompt')) {
      db.exec('ALTER TABLE conversations ADD COLUMN system_prompt TEXT');
    }
    setSchemaVersion(db, '4');
    version = '4';
  }
  if (version === '1') {
    migrateConversationsV1ToV4(db);
    version = '4';
  }
  if (version === '2' || version === '3') {
    migrateConversationsV2OrV3ToV4(db);
    version = '4';
  }
  if (version === '4') {
    migrateConversationsV4ToV5(db, createId);
    version = CONVERSATION_SCHEMA_VERSION;
  }
  if (version !== CONVERSATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported conversation schema version: ${version}`);
  }
}

type StoreStatements = {
  getConversation: StatementSync;
  insertConversation: StatementSync;
  touchConversation: StatementSync;
  setModel: StatementSync;
  linksFor: StatementSync;
  allLinks: StatementSync;
  findLink: StatementSync;
  insertLink: StatementSync;
  getSession: StatementSync;
  listSessions: StatementSync;
  putSession: StatementSync;
  removeSession: StatementSync;
};

export type OpenConversationStoreOptions = {
  createId?: () => string;
};

function linkFromRow(row: LinkRow): ConversationLink {
  return { provider: row.provider, externalId: row.external_id };
}

function linkKey(link: ConversationLink): string {
  return `${link.provider}\u0000${link.externalId}`;
}

function sessionKey(id: string, backend: string): string {
  return `${id}\u0000${backend}`;
}

export function openConversationStore(
  location: string | SkyHome = createSkyHome(),
  options: OpenConversationStoreOptions = {},
): ConversationStore {
  const createId = options.createId ?? newConversationId;
  const dbPath = prepareSqliteDatabase(location);

  const db = new DatabaseSync(dbPath);
  ensureSchema(db, createId);
  if (dbPath !== ':memory:') secureSqliteFiles(dbPath);

  const statements: StoreStatements = {
    getConversation: db.prepare('SELECT id, model, created_at, updated_at FROM conversations WHERE id = ?'),
    insertConversation: db.prepare(
      'INSERT INTO conversations (id, model, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
    ),
    touchConversation: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
    setModel: db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?'),
    linksFor: db.prepare(
      'SELECT conversation_id, provider, external_id FROM conversation_links WHERE conversation_id = ? ORDER BY provider, external_id',
    ),
    allLinks: db.prepare(
      'SELECT conversation_id, provider, external_id FROM conversation_links ORDER BY provider, external_id',
    ),
    findLink: db.prepare(
      'SELECT conversation_id FROM conversation_links WHERE provider = ? AND external_id = ?',
    ),
    insertLink: db.prepare(
      'INSERT INTO conversation_links (provider, external_id, conversation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ),
    getSession: db.prepare(
      'SELECT * FROM conversation_sessions WHERE conversation_id = ? AND backend = ?',
    ),
    listSessions: db.prepare(
      'SELECT * FROM conversation_sessions WHERE backend = ? ORDER BY updated_at DESC, conversation_id',
    ),
    putSession: db.prepare(`
      INSERT INTO conversation_sessions
        (conversation_id, backend, session_id, resume_ref, model, agent_name, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id, backend) DO UPDATE SET
        session_id = excluded.session_id,
        resume_ref = excluded.resume_ref,
        model = excluded.model,
        agent_name = excluded.agent_name,
        system_prompt = excluded.system_prompt,
        updated_at = excluded.updated_at
    `),
    removeSession: db.prepare(
      'DELETE FROM conversation_sessions WHERE conversation_id = ? AND backend = ?',
    ),
  };

  function readConversation(id: string): ConversationRecord | undefined {
    const row = statements.getConversation.get(id) as ConversationRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      ...(row.model !== null ? { model: row.model } : {}),
      links: (statements.linksFor.all(id) as LinkRow[]).map(linkFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function requireConversation(id: string): void {
    if (!statements.getConversation.get(id)) throw new UnknownConversationError(id);
  }

  function attachLink(id: string, link: ConversationLink): void {
    statements.insertLink.run(link.provider, link.externalId, id, Date.now());
    const owner = statements.findLink.get(link.provider, link.externalId) as
      | { conversation_id: string }
      | undefined;
    if (owner?.conversation_id !== id) throw new ConversationLinkConflictError(link);
  }

  const store: ConversationStore = {
    create(createOptions: CreateConversationOptions = {}): ConversationRecord {
      const id = createOptions.id ?? createId();
      inTransaction(db, () => {
        const now = Date.now();
        statements.insertConversation.run(id, createOptions.model ?? null, now, now);
        if (createOptions.link) attachLink(id, createOptions.link);
      });
      return readConversation(id)!;
    },

    get(id: string): ConversationRecord | undefined {
      return readConversation(id);
    },

    findByLink(link: ConversationLink): ConversationRecord | undefined {
      const row = statements.findLink.get(link.provider, link.externalId) as
        | { conversation_id: string }
        | undefined;
      return row ? readConversation(row.conversation_id) : undefined;
    },

    link(id: string, link: ConversationLink): void {
      requireConversation(id);
      attachLink(id, link);
      statements.touchConversation.run(Date.now(), id);
    },

    setModel(id: string, model: string): void {
      requireConversation(id);
      statements.setModel.run(model, Date.now(), id);
    },

    getSession(id: string, backend: string): PersistedSession | undefined {
      const row = statements.getSession.get(id, backend) as SessionRow | undefined;
      if (!row) return undefined;
      return {
        sessionId: row.session_id,
        backend: row.backend,
        model: row.model,
        agentName: row.agent_name,
        ...(row.resume_ref !== null ? { resumeRef: row.resume_ref } : {}),
        ...(row.system_prompt !== null ? { systemPrompt: row.system_prompt } : {}),
      };
    },

    putSession(id: string, session: PersistedSession): void {
      requireConversation(id);
      const now = Date.now();
      inTransaction(db, () => {
        statements.putSession.run(
          id,
          session.backend,
          session.sessionId,
          session.resumeRef ?? null,
          session.model,
          session.agentName,
          session.systemPrompt ?? null,
          now,
          now,
        );
        statements.touchConversation.run(now, id);
      });
    },

    removeSession(id: string, backend: string): void {
      statements.removeSession.run(id, backend);
    },

    listSessions(backend: string): ConversationSummary[] {
      const links = new Map<string, ConversationLink[]>();
      for (const row of statements.allLinks.all() as LinkRow[]) {
        const current = links.get(row.conversation_id) ?? [];
        current.push(linkFromRow(row));
        links.set(row.conversation_id, current);
      }
      return (statements.listSessions.all(backend) as SessionRow[]).map((row) => ({
        conversationId: row.conversation_id,
        links: links.get(row.conversation_id) ?? [],
        sessionId: row.session_id,
        backend: row.backend,
        model: row.model,
        agentName: row.agent_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    close(): void {
      db.close();
    },
  };
  return store;
}

export function createInMemoryConversationStore(
  options: OpenConversationStoreOptions = {},
): ConversationStore {
  const createId = options.createId ?? newConversationId;
  const conversations = new Map<string, Omit<ConversationRecord, 'links'>>();
  const links = new Map<string, { id: string; link: ConversationLink }>();
  const sessions = new Map<
    string,
    { conversationId: string; session: PersistedSession; createdAt: number; updatedAt: number }
  >();
  const linksFor = (id: string) =>
    [...links.values()].filter((entry) => entry.id === id).map((entry) => ({ ...entry.link }));
  const read = (id: string): ConversationRecord | undefined => {
    const conversation = conversations.get(id);
    return conversation ? { ...conversation, links: linksFor(id) } : undefined;
  };
  const requireConversation = (id: string) => {
    if (!conversations.has(id)) throw new UnknownConversationError(id);
  };
  const attachLink = (id: string, link: ConversationLink) => {
    const existing = links.get(linkKey(link));
    if (existing) {
      if (existing.id !== id) throw new ConversationLinkConflictError(link);
      return;
    }
    if (linksFor(id).some((current) => current.provider === link.provider)) {
      throw new ConversationLinkConflictError(link);
    }
    links.set(linkKey(link), { id, link: { ...link } });
  };

  return {
    create(createOptions = {}) {
      const id = createOptions.id ?? createId();
      if (!conversations.has(id)) {
        if (createOptions.link) {
          const existing = links.get(linkKey(createOptions.link));
          if (existing) throw new ConversationLinkConflictError(createOptions.link);
        }
        const now = Date.now();
        conversations.set(id, {
          id,
          ...(createOptions.model !== undefined ? { model: createOptions.model } : {}),
          createdAt: now,
          updatedAt: now,
        });
      }
      if (createOptions.link) attachLink(id, createOptions.link);
      return read(id)!;
    },
    get: read,
    findByLink(link) {
      const entry = links.get(linkKey(link));
      return entry ? read(entry.id) : undefined;
    },
    link(id, link) {
      requireConversation(id);
      attachLink(id, link);
      conversations.get(id)!.updatedAt = Date.now();
    },
    setModel(id, model) {
      requireConversation(id);
      const conversation = conversations.get(id)!;
      conversation.model = model;
      conversation.updatedAt = Date.now();
    },
    getSession(id, backend) {
      const entry = sessions.get(sessionKey(id, backend));
      return entry ? { ...entry.session } : undefined;
    },
    putSession(id, session) {
      requireConversation(id);
      const now = Date.now();
      const key = sessionKey(id, session.backend);
      sessions.set(key, {
        conversationId: id,
        session: { ...session },
        createdAt: sessions.get(key)?.createdAt ?? now,
        updatedAt: now,
      });
      conversations.get(id)!.updatedAt = now;
    },
    removeSession(id, backend) {
      sessions.delete(sessionKey(id, backend));
    },
    listSessions(backend) {
      return [...sessions.values()]
        .filter((entry) => entry.session.backend === backend)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.conversationId.localeCompare(right.conversationId))
        .map((entry) => ({
          conversationId: entry.conversationId,
          links: linksFor(entry.conversationId),
          sessionId: entry.session.sessionId,
          backend: entry.session.backend,
          model: entry.session.model,
          agentName: entry.session.agentName,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }));
    },
    close() {},
  };
}
