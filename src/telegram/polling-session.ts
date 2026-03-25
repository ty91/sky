import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Bot } from 'grammy';
import { createTelegramBot } from './bot-factory.js';
import { isAbortError, timeoutError } from '../runtime/retry.js';
import type { TelegramNetworkClient } from './network-client.js';
import type {
  TelegramBotIdentity,
  TelegramHandlers,
  TelegramLifecycleEvents,
  TelegramPollingSessionResult,
} from './transport.js';

export type TelegramPollingSessionOptions = {
  botToken: string;
  identity: TelegramBotIdentity;
  networkClient: TelegramNetworkClient;
  handlers: TelegramHandlers;
  events: TelegramLifecycleEvents;
  pollTimeoutSeconds?: number;
  stallThresholdMs?: number;
  watchdogIntervalMs?: number;
};

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_STALL_THRESHOLD_MS = 90000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15000;
const STOP_GRACE_MS = 15000;

async function waitForGracefulStop(task: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      task(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class TelegramPollingSession {
  constructor(private readonly options: TelegramPollingSessionOptions) {}

  async runUntilStop(signal?: AbortSignal): Promise<TelegramPollingSessionResult> {
    if (signal?.aborted) {
      return { kind: 'stopped' };
    }

    const bot = this.createBot(signal);
    let runner: RunnerHandle | undefined;
    let pollingStarted = false;
    let stallError: Error | undefined;
    let lastGetUpdatesAt = Date.now();

    const onAbort = () => {
      void runner?.stop();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });

      bot.api.config.use((prev, method, payload, requestSignal) => {
        if (method === 'getUpdates') {
          lastGetUpdatesAt = Date.now();
        }
        return prev(method, payload, requestSignal);
      });

      runner = run(bot, {
        runner: {
          fetch: {
            timeout: this.options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
          },
          maxRetryTime: 0,
          retryInterval: 100,
          silent: true,
        },
      });

      pollingStarted = true;
      this.options.events.onPollingStart();

      const watchdog = setInterval(() => {
        if (signal?.aborted || !runner?.isRunning()) {
          return;
        }

        const elapsed = Date.now() - lastGetUpdatesAt;
        if (elapsed <= (this.options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS)) {
          return;
        }

        stallError = timeoutError(`Telegram polling stalled for ${elapsed}ms`);
        void runner.stop();
      }, this.options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
      watchdog.unref?.();

      try {
        await runner.task();
      } finally {
        clearInterval(watchdog);
      }

      if (signal?.aborted) {
        return { kind: 'stopped' };
      }

      if (stallError) {
        return { kind: 'failed', phase: 'polling', error: stallError };
      }

      return {
        kind: 'stopped_unexpectedly',
        error: new Error('Telegram polling stopped unexpectedly'),
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return { kind: 'stopped' };
      }

      return {
        kind: 'failed',
        phase: pollingStarted ? 'polling' : 'initialize',
        error,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await this.stopRunnerAndBot(runner, bot);
      if (pollingStarted) {
        this.options.events.onPollingStop();
      }
    }
  }

  private createBot(signal?: AbortSignal): Bot {
    return createTelegramBot({
      botToken: this.options.botToken,
      identity: this.options.identity,
      fetch: this.options.networkClient.createFetch(signal),
      handlers: this.options.handlers,
      events: this.options.events,
    });
  }

  private async stopRunnerAndBot(runner: RunnerHandle | undefined, bot: Bot): Promise<void> {
    if (runner) {
      await waitForGracefulStop(async () => {
        await runner.stop();
      });
    }

    await waitForGracefulStop(async () => {
      try {
        await bot.stop();
      } catch {
        // bot.stop is best-effort after runner shutdown
      }
    });
  }
}
