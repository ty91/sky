import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SKY_DIR } from '../settings.js';
import type { NewScheduledJob, ScheduledJob, ScheduledJobStore } from './types.js';

const DEFAULT_DB_PATH = path.join(SKY_DIR, 'sky.db');

type ScheduledJobRow = {
  id: string;
  title: string;
  kind: ScheduledJob['kind'];
  next_run_at: number;
  cron_expr: string | null;
  timezone: string;
  target_channel: string;
  thread_strategy: ScheduledJob['threadStrategy'];
  delivery_mode: ScheduledJob['deliveryMode'];
  prompt: string;
  status: ScheduledJob['status'];
  created_at: number;
  last_run_at: number | null;
  run_count: number;
  last_error: string | null;
};

type StoreHandles = {
  db: DatabaseSync;
  createStmt: StatementSync;
  listStmt: StatementSync;
  cancelStmt: StatementSync;
};

function ensureSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
      next_run_at     INTEGER NOT NULL,
      cron_expr       TEXT,
      timezone        TEXT NOT NULL,
      target_channel  TEXT NOT NULL,
      thread_strategy TEXT NOT NULL CHECK (thread_strategy = 'new-root'),
      delivery_mode   TEXT NOT NULL CHECK (delivery_mode = 'agent'),
      prompt          TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
      created_at      INTEGER NOT NULL,
      last_run_at     INTEGER,
      run_count       INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
      ON scheduled_jobs (status, next_run_at);
  `);
}

function toScheduledJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    nextRunAt: row.next_run_at,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    targetChannel: row.target_channel,
    threadStrategy: row.thread_strategy,
    deliveryMode: row.delivery_mode,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    runCount: row.run_count,
    lastError: row.last_error,
  };
}

export function openScheduledJobStore(dbPath: string = DEFAULT_DB_PATH): ScheduledJobStore {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);

  const handles: StoreHandles = {
    db,
    createStmt: db.prepare(`
      INSERT INTO scheduled_jobs (
        id, title, kind, next_run_at, cron_expr, timezone, target_channel,
        thread_strategy, delivery_mode, prompt, status, created_at,
        last_run_at, run_count, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, NULL)
    `),
    listStmt: db.prepare('SELECT * FROM scheduled_jobs ORDER BY next_run_at, created_at, id'),
    cancelStmt: db.prepare(
      "UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    ),
  };

  return {
    create(job: NewScheduledJob): ScheduledJob {
      handles.createStmt.run(
        job.id,
        job.title,
        job.kind,
        job.nextRunAt,
        job.cronExpr ?? null,
        job.timezone,
        job.targetChannel,
        job.threadStrategy,
        job.deliveryMode,
        job.prompt,
        job.createdAt,
      );

      return {
        ...job,
        cronExpr: job.cronExpr ?? null,
        status: 'pending',
        lastRunAt: null,
        runCount: 0,
        lastError: null,
      };
    },

    list(): ScheduledJob[] {
      return (handles.listStmt.all() as ScheduledJobRow[]).map(toScheduledJob);
    },

    cancel(id: string): boolean {
      return handles.cancelStmt.run(id).changes === 1;
    },

    close(): void {
      handles.db.close();
    },
  };
}
