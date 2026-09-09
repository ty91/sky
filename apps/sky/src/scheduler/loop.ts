import { nextCronRun } from './cron.js';
import type { ScheduledJobDispatcher } from './dispatcher.js';
import type { ScheduledJobStore } from './types.js';
import type { RuntimeController } from '../runtime/controller.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_RUNNING_TIMEOUT_MS = 60 * 60 * 1_000;

type IntervalHandle = unknown;

export type ScheduledJobScheduler = {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
};

export type ScheduledJobSchedulerOptions = {
  store: ScheduledJobStore;
  dispatcher: ScheduledJobDispatcher;
  now?: () => number;
  maxAttempts?: number;
  retryDelayMs?: number;
  tickIntervalMs?: number;
  runningTimeoutMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
  runtimeController?: Pick<RuntimeController, 'lease'>;
};

export function createScheduledJobScheduler(
  options: ScheduledJobSchedulerOptions,
): ScheduledJobScheduler {
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const runningTimeoutMs = options.runningTimeoutMs ?? DEFAULT_RUNNING_TIMEOUT_MS;
  const setSchedulerInterval =
    options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearSchedulerInterval =
    options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let activeTick: Promise<void> | undefined;
  let intervalHandle: IntervalHandle | undefined;

  async function recoverStaleJobs(currentTime: number): Promise<void> {
    const restartError = new Error(
      'Reminder execution became stale after a Sky restart or crash and was not retried to avoid duplicate delivery.',
    );
    const interrupted = options.store.failRunningBefore(
      currentTime - runningTimeoutMs,
      restartError.message,
    );
    for (const job of interrupted) {
      try {
        await options.dispatcher.notifyFailure(job, restartError, job.runCount);
      } catch (notificationError) {
        const message =
          notificationError instanceof Error ? notificationError.message : String(notificationError);
        console.error(`[scheduler] failed to report interrupted job=${job.id}: ${message}`);
      }
    }
  }

  async function runTick(): Promise<void> {
    const lease = options.runtimeController?.lease('scheduler_dispatch');
    if (options.runtimeController && !lease) return;

    try {
      const currentTime = now();
      await recoverStaleJobs(currentTime);
      const jobs = options.store.claimDue(currentTime);
      for (const job of jobs) {
        try {
          await options.dispatcher.dispatch(job);
          options.store.markDone(job.id);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const outcome = options.store.recordFailure(
            job.id,
            error.message,
            now() + retryDelayMs,
            maxAttempts,
          );
          if (outcome === 'failed') {
            try {
              await options.dispatcher.notifyFailure(job, error, maxAttempts);
            } catch (notificationError) {
              const message =
                notificationError instanceof Error
                  ? notificationError.message
                  : String(notificationError);
              console.error(
                `[scheduler] failed to send failure notice for job=${job.id}: ${message}`,
              );
            }
          }
        }
      }

      const cronJobs = options.store.claimDueCron(currentTime);
      for (const job of cronJobs) {
        let lastError: string | null = null;
        try {
          await options.dispatcher.dispatch(job);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          lastError = error.message;
          console.error(`[scheduler] cron job=${job.id} dispatch failed: ${error.message}`);
          try {
            await options.dispatcher.notifyFailure(job, error, job.runCount);
          } catch (notificationError) {
            const message =
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError);
            console.error(
              `[scheduler] failed to send cron failure notice for job=${job.id}: ${message}`,
            );
          }
        }
        // Re-arm for the next occurrence regardless of success so a single failed
        // run never kills the recurring schedule.
        try {
          const nextRunAt = nextCronRun(job.cronExpr ?? '', job.timezone, now());
          options.store.rearmCron(job.id, nextRunAt, lastError);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          // An unparseable cron expression cannot be rescheduled; fail it so it
          // stops occupying a running slot.
          options.store.recordFailure(job.id, `cron re-arm failed: ${error.message}`, now(), 0);
          console.error(`[scheduler] cron job=${job.id} re-arm failed: ${error.message}`);
        }
      }
    } finally {
      lease?.release();
    }
  }

  const scheduler: ScheduledJobScheduler = {
    async start(): Promise<void> {
      if (intervalHandle !== undefined) {
        return;
      }
      const currentTime = now();
      await recoverStaleJobs(currentTime);
      const skipped = options.store.skipOverdue(currentTime);
      if (skipped > 0) {
        console.log(`[scheduler] skipped ${skipped} overdue job(s) at startup`);
      }
      intervalHandle = setSchedulerInterval(() => {
        void scheduler.tick().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[scheduler] tick failed: ${message}`);
        });
      }, tickIntervalMs);
    },

    async stop(): Promise<void> {
      if (intervalHandle !== undefined) {
        clearSchedulerInterval(intervalHandle);
        intervalHandle = undefined;
      }
      await activeTick;
    },

    tick(): Promise<void> {
      if (activeTick) {
        return activeTick;
      }
      activeTick = runTick().finally(() => {
        activeTick = undefined;
      });
      return activeTick;
    },
  };

  return scheduler;
}
