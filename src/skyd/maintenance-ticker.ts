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

export type MaintenanceTicker = {
  start(): void;
  stop(): Promise<void>;
};

export type MaintenanceTickerOptions = {
  submitOperation(
    request:
      | Extract<OperationRequest, { type: 'memory' }>
      | { type: 'dream'; date: string },
  ): CreateOperationResult | Promise<CreateOperationResult>;
  getOperation(operationId: string): OperationRecord | undefined;
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
  let scheduledDream: { operationId: string; targetDate: string } | undefined;
  let intervalHandle: IntervalHandle | undefined;
  let activeTick: Promise<void> | undefined;

  const delayDreamRetry = (currentTime: number) => {
    dreamRetryAt = currentTime + dreamRetryCooldownMs;
  };

  const reconcileScheduledDream = async (currentTime: number): Promise<boolean> => {
    if (!scheduledDream) return false;
    const currentDream = scheduledDream;
    const operation = options.getOperation(currentDream.operationId);
    if (operation?.state === 'queued' || operation?.state === 'running') return true;
    if (operation?.state === 'succeeded') {
      if (currentTime < dreamRetryAt) return false;
      try {
        await options.recordDreamSuccess(currentDream.targetDate);
        options.logger.log('info', 'maintenance', 'Dream maintenance watermark advanced.', {
          operationId: currentDream.operationId,
          targetDate: currentDream.targetDate,
        });
        scheduledDream = undefined;
        dreamRetryAt = 0;
      } catch (error) {
        delayDreamRetry(currentTime);
        options.logger.log(
          'error',
          'maintenance',
          `Dream maintenance watermark update failed (${error instanceof Error ? error.name : 'unknown_error'}).`,
          {
            operationId: currentDream.operationId,
            targetDate: currentDream.targetDate,
          },
        );
      }
      return false;
    }

    const operationId = currentDream.operationId;
    const targetDate = currentDream.targetDate;
    scheduledDream = undefined;
    delayDreamRetry(currentTime);
    options.logger.log('warn', 'maintenance', 'Scheduled dream operation did not succeed.', {
      operationId,
      targetDate,
      retryAt: new Date(dreamRetryAt).toISOString(),
    });
    return false;
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
    scheduledDream = { operationId: result.operation.id, targetDate };
    options.logger.log('info', 'maintenance', 'Scheduled dream operation submitted.', {
      operationId: result.operation.id,
      targetDate,
    });
    return true;
  };

  const runTick = async () => {
    const currentTime = now();
    if (!(await options.isConfigurationReady())) return;

    if (await reconcileScheduledDream(currentTime)) return;
    if (await submitDueDream(currentTime)) return;
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
  };
}
