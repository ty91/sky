import { nextCronRun } from './cron.js';
import { ScheduledDeliveryError, type ScheduledJobDispatcher } from './dispatcher.js';
import type { ScheduledJob, ScheduledJobStore } from './types.js';
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
  refreshAvailability(): void;
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
  runtimeController?: Pick<RuntimeController, 'lease' | 'isAccepting'>;
};

export function createScheduledJobScheduler(options: ScheduledJobSchedulerOptions): ScheduledJobScheduler {
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const runningTimeoutMs = options.runningTimeoutMs ?? DEFAULT_RUNNING_TIMEOUT_MS;
  const setSchedulerInterval = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearSchedulerInterval = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let activeTick: Promise<void> | undefined;
  let intervalHandle: IntervalHandle | undefined;

  async function notifyFailure(job: ScheduledJob, error: Error, attempts: number): Promise<void> {
    try {
      await options.dispatcher.notifyFailure(job, error, attempts);
    } catch (cause) {
      console.error(`[scheduler] failed to report job=${job.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function recoverStaleJobs(currentTime: number): Promise<void> {
    const error = new Error('Reminder execution became stale after a Sky restart or crash and was not retried to avoid duplicate delivery.');
    const interrupted = options.store.failRunningBefore(currentTime - runningTimeoutMs, error.message);
    for (const job of interrupted) await notifyFailure(job, error, job.runCount);
  }

  function advanceMissedCron(starting = false): void {
    const currentTime = now();
    for (const job of options.store.list()) {
      if (job.status !== 'pending' || job.kind !== 'cron' || job.nextRunAt > currentTime) continue;
      if (starting ? job.nextRunAt >= currentTime : options.dispatcher.isAvailable(job)) continue;
      options.store.advancePendingCron(job.id, nextCronRun(job.cronExpr ?? '', job.timezone, currentTime));
    }
  }

  async function runTick(): Promise<void> {
    const lease = options.runtimeController?.lease('scheduler_dispatch');
    if (options.runtimeController && !lease) return;
    try {
      await recoverStaleJobs(now());
      advanceMissedCron();
      for (const candidate of options.store.list()) {
        if (options.runtimeController && !options.runtimeController.isAccepting()) return;
        if (candidate.status !== 'pending' || candidate.nextRunAt > now()) continue;
        if (!options.dispatcher.isAvailable(candidate)) {
          advanceMissedCron();
          continue;
        }
        const job = options.store.claim(candidate.id, now());
        if (!job) continue;
        let failure: Error | undefined;
        try {
          await options.dispatcher.dispatch(job);
        } catch (cause) {
          failure = cause instanceof Error ? cause : new Error(String(cause));
        }
        if (job.kind === 'cron') {
          if (failure) await notifyFailure(job, failure, job.runCount);
          try {
            options.store.rearmCron(job.id, nextCronRun(job.cronExpr ?? '', job.timezone, now()), failure?.message ?? null);
          } catch (cause) {
            options.store.recordFailure(job.id, `cron re-arm failed: ${String(cause)}`, now(), 0);
          }
        } else if (failure) {
          const outcome = options.store.recordFailure(
            job.id, failure.message, now() + retryDelayMs,
            failure instanceof ScheduledDeliveryError ? 0 : maxAttempts,
          );
          if (outcome === 'failed') await notifyFailure(job, failure, job.runCount);
        } else {
          options.store.markDone(job.id);
        }
      }
    } finally {
      lease?.release();
    }
  }

  const scheduler: ScheduledJobScheduler = {
    async start() {
      if (intervalHandle !== undefined) return;
      await recoverStaleJobs(now());
      advanceMissedCron(true);
      intervalHandle = setSchedulerInterval(() => {
        void scheduler.tick().catch((error) => {
          console.error(`[scheduler] tick failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, tickIntervalMs);
    },
    async stop() {
      if (intervalHandle !== undefined) {
        clearSchedulerInterval(intervalHandle);
        intervalHandle = undefined;
      }
      await activeTick;
    },
    tick() {
      activeTick ??= runTick().finally(() => { activeTick = undefined; });
      return activeTick;
    },
    refreshAvailability() {
      advanceMissedCron();
    },
  };
  return scheduler;
}
