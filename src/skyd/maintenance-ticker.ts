import { nextCronRun } from '../scheduler/cron.js';
import type { JsonlLogger } from './logger.js';
import type { CreateOperationResult, OperationRequest } from './operations.js';

const MEMORY_CRON = '*/5 * * * *';
const MEMORY_TIMEZONE = 'Asia/Seoul';
const DEFAULT_TICK_INTERVAL_MS = 30_000;

type IntervalHandle = unknown;

export type MaintenanceTicker = {
  start(): void;
  stop(): Promise<void>;
};

export type MaintenanceTickerOptions = {
  submitOperation(
    request: Extract<OperationRequest, { type: 'memory' }>,
  ): CreateOperationResult | Promise<CreateOperationResult>;
  isConfigurationReady(): boolean | Promise<boolean>;
  logger: Pick<JsonlLogger, 'log'>;
  now?: () => number;
  tickIntervalMs?: number;
  setInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
};

export function createMaintenanceTicker(options: MaintenanceTickerOptions): MaintenanceTicker {
  const now = options.now ?? Date.now;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const setTickerInterval =
    options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearTickerInterval =
    options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let nextMemoryRunAt: number | undefined;
  let intervalHandle: IntervalHandle | undefined;
  let activeTick: Promise<void> | undefined;

  const runTick = async () => {
    const currentTime = now();
    if (nextMemoryRunAt === undefined || currentTime < nextMemoryRunAt) return;
    if (!(await options.isConfigurationReady())) return;

    const result = await options.submitOperation({ type: 'memory' });
    if (!result.ok) return;

    nextMemoryRunAt = nextCronRun(MEMORY_CRON, MEMORY_TIMEZONE, now());
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
      nextMemoryRunAt = nextCronRun(MEMORY_CRON, MEMORY_TIMEZONE, now());
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
