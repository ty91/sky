import { getYesterdayKey } from '../agents/dream/date.js';
import { nextCronRun, previousCronRun } from '../scheduler/cron.js';
import type { JsonlLogger } from './logger.js';
import type {
  CreateOperationResult,
  OperationRecord,
  OperationRequest,
} from './operations.js';

const MEMORY_CRON = '*/5 * * * *';
const DREAM_CRON = '0 2 * * *';
const MAINTENANCE_TIMEZONE = 'Asia/Seoul';
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_DREAM_RETRY_COOLDOWN_MS = 5 * 60 * 1_000;

type IntervalHandle = unknown;
type ScheduledDream = {
  operationId: string;
  targetDate: string;
  state: 'active' | 'persistence_pending';
  completion: Promise<void>;
  observer: AbortController;
};

export type MaintenanceTicker = {
  start(): void;
  stop(): Promise<void>;
  waitForScheduledDream(): Promise<void>;
  abandonScheduledDream(): void;
};

export type MaintenanceTickerOptions = {
  submitOperation(
    request:
      | Extract<OperationRequest, { type: 'memory' }>
      | { type: 'dream'; date: string },
  ): CreateOperationResult | Promise<CreateOperationResult>;
  waitForOperation(operationId: string, signal: AbortSignal): Promise<OperationRecord>;
  loadDreamWatermark(latestDueDate: string): string | null | Promise<string | null>;
  recordDreamSuccess(targetDate: string): void | Promise<void>;
  isConfigurationReady(): boolean | Promise<boolean>;
  logger: Pick<JsonlLogger, 'log'>;
  now?: () => number;
  tickIntervalMs?: number;
  dreamRetryCooldownMs?: number;
  setInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
};

function nextDateKey(dateKey: string): string {
  return new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function latestDueDreamDate(currentTime: number): string {
  const occurrence = previousCronRun(
    DREAM_CRON,
    MAINTENANCE_TIMEZONE,
    currentTime + 1,
  );
  return getYesterdayKey(new Date(occurrence));
}

export function createMaintenanceTicker(options: MaintenanceTickerOptions): MaintenanceTicker {
  const now = options.now ?? Date.now;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const dreamRetryCooldownMs =
    options.dreamRetryCooldownMs ?? DEFAULT_DREAM_RETRY_COOLDOWN_MS;
  const setTickerInterval =
    options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearTickerInterval =
    options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let nextMemoryRunAt: number | undefined;
  let dreamRetryAt = 0;
  let scheduledDream: ScheduledDream | undefined;
  let intervalHandle: IntervalHandle | undefined;
  let activeTick: Promise<void> | undefined;

  const delayDreamRetry = (currentTime: number) => {
    dreamRetryAt = currentTime + dreamRetryCooldownMs;
  };

  const persistDreamSuccess = async (dream: ScheduledDream) => {
    try {
      await options.recordDreamSuccess(dream.targetDate);
      options.logger.log('info', 'maintenance', 'Dream maintenance watermark advanced.', {
        operationId: dream.operationId,
        targetDate: dream.targetDate,
      });
      if (scheduledDream === dream) scheduledDream = undefined;
      dreamRetryAt = 0;
    } catch (error) {
      dream.state = 'persistence_pending';
      delayDreamRetry(now());
      options.logger.log(
        'error',
        'maintenance',
        `Dream maintenance watermark update failed (${error instanceof Error ? error.name : 'unknown_error'}).`,
        {
          operationId: dream.operationId,
          targetDate: dream.targetDate,
          retryAt: new Date(dreamRetryAt).toISOString(),
        },
      );
    }
  };

  const completeScheduledDream = async (dream: ScheduledDream) => {
    let operation: OperationRecord;
    try {
      operation = await options.waitForOperation(dream.operationId, dream.observer.signal);
    } catch (error) {
      if (scheduledDream !== dream) return;
      scheduledDream = undefined;
      delayDreamRetry(now());
      options.logger.log(
        'error',
        'maintenance',
        `Scheduled dream observation failed (${error instanceof Error ? error.name : 'unknown_error'}).`,
        {
          operationId: dream.operationId,
          targetDate: dream.targetDate,
          retryAt: new Date(dreamRetryAt).toISOString(),
        },
      );
      return;
    }
    if (scheduledDream !== dream) return;
    if (operation.state === 'succeeded') {
      await persistDreamSuccess(dream);
      return;
    }
    scheduledDream = undefined;
    delayDreamRetry(now());
    options.logger.log('warn', 'maintenance', 'Scheduled dream operation did not succeed.', {
      operationId: dream.operationId,
      targetDate: dream.targetDate,
      retryAt: new Date(dreamRetryAt).toISOString(),
    });
  };

  const submitDueDream = async (currentTime: number): Promise<boolean> => {
    if (currentTime < dreamRetryAt || scheduledDream) return false;
    const latestDueDate = latestDueDreamDate(currentTime);
    const watermark = await options.loadDreamWatermark(latestDueDate);
    if (watermark === latestDueDate) return false;
    const targetDate = watermark === null ? latestDueDate : nextDateKey(watermark);
    if (targetDate > latestDueDate) return false;

    const result = await options.submitOperation({ type: 'dream', date: targetDate });
    if (!result.ok) {
      if (result.code === 'operation_active') delayDreamRetry(currentTime);
      return true;
    }
    const dream: ScheduledDream = {
      operationId: result.operation.id,
      targetDate,
      state: 'active',
      completion: Promise.resolve(),
      observer: new AbortController(),
    };
    scheduledDream = dream;
    dream.completion = completeScheduledDream(dream);
    options.logger.log('info', 'maintenance', 'Scheduled dream operation submitted.', {
      operationId: result.operation.id,
      targetDate,
    });
    return true;
  };

  const runDream = async (currentTime: number): Promise<boolean> => {
    try {
      if (scheduledDream?.state === 'active') return true;
      if (scheduledDream?.state === 'persistence_pending') {
        if (currentTime < dreamRetryAt) return false;
        await persistDreamSuccess(scheduledDream);
        if (scheduledDream) return false;
      }
      return await submitDueDream(currentTime);
    } catch (error) {
      delayDreamRetry(currentTime);
      options.logger.log(
        'error',
        'maintenance',
        `Dream maintenance check failed (${error instanceof Error ? error.name : 'unknown_error'}).`,
        { retryAt: new Date(dreamRetryAt).toISOString() },
      );
      return false;
    }
  };

  const runTick = async () => {
    const currentTime = now();
    if (!(await options.isConfigurationReady())) return;

    if (await runDream(currentTime)) return;
    if (nextMemoryRunAt === undefined || currentTime < nextMemoryRunAt) return;

    const result = await options.submitOperation({ type: 'memory' });
    if (!result.ok) return;

    nextMemoryRunAt = nextCronRun(MEMORY_CRON, MAINTENANCE_TIMEZONE, now());
    options.logger.log('info', 'maintenance', 'Scheduled memory operation submitted.', {
      operationId: result.operation.id,
    });
  };

  const tick = () => {
    if (activeTick) return activeTick;
    activeTick = runTick()
      .catch((error) => {
        const reason = error instanceof Error ? error.name : 'unknown_error';
        options.logger.log('error', 'maintenance', `Maintenance tick failed (${reason}).`);
      })
      .finally(() => {
        activeTick = undefined;
      });
    return activeTick;
  };

  return {
    start() {
      if (intervalHandle !== undefined) return;
      nextMemoryRunAt = nextCronRun(MEMORY_CRON, MAINTENANCE_TIMEZONE, now());
      intervalHandle = setTickerInterval(() => {
        void tick();
      }, tickIntervalMs);
    },

    async stop() {
      if (intervalHandle !== undefined) {
        clearTickerInterval(intervalHandle);
        intervalHandle = undefined;
      }
      await activeTick;
    },

    async waitForScheduledDream() {
      await scheduledDream?.completion;
    },

    abandonScheduledDream() {
      const dream = scheduledDream;
      scheduledDream = undefined;
      dream?.observer.abort();
    },
  };
}
