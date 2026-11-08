import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { newConversationId } from '../conversation/store.js';
import {
  createSkyHome,
  prepareSqliteDatabase,
  secureSqliteFiles,
  type SkyHome,
} from '../sky-home.js';
import type {
  ClaimedScheduledJob,
  NewScheduledJob,
  ScheduledJob,
  ScheduledJobFailureOutcome,
  ScheduledJobRun,
  ScheduledJobRunStatus,
  ScheduledJobStore,
} from './types.js';

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

type ScheduledJobRunRow = {
  id: string;
  job_id: string;
  conversation_id: string;
  scheduled_for: number;
  status: ScheduledJobRunStatus;
  attempts: number;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  last_error: string | null;
};

type StoreHandles = {
  db: DatabaseSync;
  createStmt: StatementSync;
  getStmt: StatementSync;
  listStmt: StatementSync;
  cancelStmt: StatementSync;
  rearmCronStmt: StatementSync;
  markDoneStmt: StatementSync;
  recordFailureStmt: StatementSync;
  claimStmt: StatementSync;
  advancePendingCronStmt: StatementSync;
  failRunningBeforeStmt: StatementSync;
  openRunStmt: StatementSync;
  getRunStmt: StatementSync;
  listRunsStmt: StatementSync;
  insertRunStmt: StatementSync;
  resumeRunStmt: StatementSync;
  retryOpenRunStmt: StatementSync;
  finishOpenRunStmt: StatementSync;
};

export type OpenScheduledJobStoreOptions = {
  createRunId?: () => string;
  createConversationId?: () => string;
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
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id              TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES scheduled_jobs (id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL UNIQUE,
      scheduled_for   INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('running', 'retrying', 'succeeded', 'failed', 'cancelled')),
      attempts        INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      finished_at     INTEGER,
      last_error      TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_open_idx
      ON scheduled_job_runs (job_id) WHERE finished_at IS NULL;
  `);
}

function toScheduledJobRun(row: ScheduledJobRunRow): ScheduledJobRun {
  return {
    id: row.id,
    jobId: row.job_id,
    conversationId: row.conversation_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
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

export function openScheduledJobStore(
  location: string | SkyHome = createSkyHome(),
  options: OpenScheduledJobStoreOptions = {},
): ScheduledJobStore {
  const createRunId = options.createRunId ?? randomUUID;
  const createConversationId = options.createConversationId ?? newConversationId;
  const dbPath = prepareSqliteDatabase(location);

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  if (dbPath !== ':memory:') secureSqliteFiles(dbPath);

  const handles: StoreHandles = {
    db,
    createStmt: db.prepare(`
      INSERT INTO scheduled_jobs (
        id, title, kind, next_run_at, cron_expr, timezone, target_channel,
        thread_strategy, delivery_mode, prompt, status, created_at,
        last_run_at, run_count, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, NULL)
    `),
    getStmt: db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?'),
    listStmt: db.prepare('SELECT * FROM scheduled_jobs ORDER BY next_run_at, created_at, id'),
    cancelStmt: db.prepare(
      "UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    ),
    rearmCronStmt: db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'pending', next_run_at = ?, last_error = ?
      WHERE id = ? AND status = 'running'
    `),
    markDoneStmt: db.prepare(
      "UPDATE scheduled_jobs SET status = 'done', last_error = NULL WHERE id = ? AND status = 'running'",
    ),
    recordFailureStmt: db.prepare(`
      UPDATE scheduled_jobs
      SET
        status = CASE WHEN run_count >= ? THEN 'failed' ELSE 'pending' END,
        next_run_at = CASE WHEN run_count >= ? THEN next_run_at ELSE ? END,
        last_error = ?
      WHERE id = ? AND status = 'running'
      RETURNING status
    `),
    claimStmt: db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'running', last_run_at = ?, run_count = run_count + 1
      WHERE id = ? AND status = 'pending' AND next_run_at <= ?
      RETURNING *
    `),
    advancePendingCronStmt: db.prepare(`
      UPDATE scheduled_jobs SET next_run_at = ?
      WHERE id = ? AND kind = 'cron' AND status = 'pending'
    `),
    failRunningBeforeStmt: db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'failed', last_error = ?
      WHERE status = 'running' AND last_run_at < ?
      RETURNING *
    `),
    openRunStmt: db.prepare(
      'SELECT * FROM scheduled_job_runs WHERE job_id = ? AND finished_at IS NULL',
    ),
    getRunStmt: db.prepare('SELECT * FROM scheduled_job_runs WHERE id = ?'),
    listRunsStmt: db.prepare(
      'SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at, id',
    ),
    insertRunStmt: db.prepare(`
      INSERT INTO scheduled_job_runs (
        id, job_id, conversation_id, scheduled_for, status, attempts,
        started_at, updated_at, finished_at, last_error
      ) VALUES (?, ?, ?, ?, 'running', 1, ?, ?, NULL, NULL)
    `),
    resumeRunStmt: db.prepare(`
      UPDATE scheduled_job_runs
      SET status = 'running', attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `),
    retryOpenRunStmt: db.prepare(`
      UPDATE scheduled_job_runs
      SET status = 'retrying', last_error = ?, updated_at = ?
      WHERE job_id = ? AND finished_at IS NULL
    `),
    finishOpenRunStmt: db.prepare(`
      UPDATE scheduled_job_runs
      SET status = ?, last_error = ?, updated_at = ?, finished_at = ?
      WHERE job_id = ? AND finished_at IS NULL
    `),
  };

  function inTransaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function finishOpenRun(
    jobId: string,
    status: Exclude<ScheduledJobRunStatus, 'running' | 'retrying'>,
    error: string | null,
  ): void {
    const now = Date.now();
    handles.finishOpenRunStmt.run(status, error, now, now, jobId);
  }

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

    get(id: string): ScheduledJob | undefined {
      const row = handles.getStmt.get(id) as ScheduledJobRow | undefined;
      return row ? toScheduledJob(row) : undefined;
    },

    list(): ScheduledJob[] {
      return (handles.listStmt.all() as ScheduledJobRow[]).map(toScheduledJob);
    },

    cancel(id: string): boolean {
      return inTransaction(() => {
        if (handles.cancelStmt.run(id).changes !== 1) return false;
        finishOpenRun(id, 'cancelled', null);
        return true;
      });
    },

    rearmCron(id: string, nextRunAt: number, lastError: string | null = null): boolean {
      return inTransaction(() => {
        if (handles.rearmCronStmt.run(nextRunAt, lastError, id).changes !== 1) return false;
        finishOpenRun(id, lastError === null ? 'succeeded' : 'failed', lastError);
        return true;
      });
    },

    markDone(id: string): boolean {
      return inTransaction(() => {
        if (handles.markDoneStmt.run(id).changes !== 1) return false;
        finishOpenRun(id, 'succeeded', null);
        return true;
      });
    },

    recordFailure(
      id: string,
      error: string,
      retryAt: number,
      maxAttempts: number,
    ): ScheduledJobFailureOutcome | undefined {
      return inTransaction(() => {
        const row = handles.recordFailureStmt.get(
          maxAttempts,
          maxAttempts,
          retryAt,
          error,
          id,
        ) as { status: 'pending' | 'failed' } | undefined;
        if (!row) {
          return undefined;
        }
        if (row.status === 'failed') {
          finishOpenRun(id, 'failed', error);
          return 'failed';
        }
        handles.retryOpenRunStmt.run(error, Date.now(), id);
        return 'retrying';
      });
    },

    claim(id: string, now: number): ClaimedScheduledJob | undefined {
      return inTransaction(() => {
        const row = handles.claimStmt.get(now, id, now) as ScheduledJobRow | undefined;
        if (!row) return undefined;
        const open = handles.openRunStmt.get(id) as ScheduledJobRunRow | undefined;
        let runId: string;
        if (open) {
          runId = open.id;
          handles.resumeRunStmt.run(now, runId);
        } else {
          runId = createRunId();
          handles.insertRunStmt.run(runId, id, createConversationId(), row.next_run_at, now, now);
        }
        const run = handles.getRunStmt.get(runId) as ScheduledJobRunRow;
        return { ...toScheduledJob(row), run: toScheduledJobRun(run) };
      });
    },

    listRuns(jobId: string): ScheduledJobRun[] {
      return (handles.listRunsStmt.all(jobId) as ScheduledJobRunRow[]).map(toScheduledJobRun);
    },

    advancePendingCron(id: string, nextRunAt: number): boolean {
      return handles.advancePendingCronStmt.run(nextRunAt, id).changes === 1;
    },

    failRunningBefore(before: number, error: string): ScheduledJob[] {
      return inTransaction(() => {
        const rows = handles.failRunningBeforeStmt.all(error, before) as ScheduledJobRow[];
        for (const row of rows) finishOpenRun(row.id, 'failed', error);
        return rows.map(toScheduledJob);
      });
    },

    close(): void {
      handles.db.close();
    },
  };
}
