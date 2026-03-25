import { computeBackoffMs, sleep } from '../runtime/retry.js';
import { classifyTelegramError, toRuntimeErrorInfo } from './error-classifier.js';
import type { RuntimeErrorInfo } from '../runtime/health-store.js';

export type TypingLoop = {
  stop(): Promise<void>;
};

export type TelegramApiClient = {
  sendMessage(chatId: number, text: string): Promise<unknown>;
  sendChatAction(chatId: number, action: 'typing'): Promise<unknown>;
};

export type TelegramSenderHooks = {
  onSuccess: (method: 'sendMessage' | 'sendChatAction') => void;
  onFailure: (error: RuntimeErrorInfo) => void;
};

async function ignoreFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // best-effort cleanup only
  }
}

export class TelegramSender {
  constructor(
    private readonly api: TelegramApiClient,
    private readonly hooks: TelegramSenderHooks,
  ) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.execute('sendMessage', true, () => this.api.sendMessage(chatId, text));
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    await this.execute('sendChatAction', false, () => this.api.sendChatAction(chatId, action));
  }

  createTypingLoop(chatId: number, intervalMs = 4000): TypingLoop {
    const controller = new AbortController();
    const task = (async () => {
      await this.sendChatAction(chatId, 'typing');
      while (!controller.signal.aborted) {
        await sleep(intervalMs, controller.signal);
        if (controller.signal.aborted) return;
        await this.sendChatAction(chatId, 'typing');
      }
    })();

    return {
      stop: async () => {
        controller.abort();
        await ignoreFailure(task);
      },
    };
  }

  private async execute(
    method: 'sendMessage' | 'sendChatAction',
    critical: boolean,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const maxAttempts = critical ? 4 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fn();
        this.hooks.onSuccess(method);
        return;
      } catch (error) {
        const runtimeError = toRuntimeErrorInfo(error, 'send');
        this.hooks.onFailure(runtimeError);
        const classified = classifyTelegramError(error);

        if (!classified.recoverable || attempt === maxAttempts) {
          if (critical) throw error;
          console.log(`[telegram] ${method} failed (${classified.kind}): ${classified.message}`);
          return;
        }

        const delay = classified.retryAfterMs ?? computeBackoffMs(attempt, { baseMs: 1000, maxMs: 10000 });
        console.log(`[telegram] ${method} failed (${classified.kind}), retrying in ${delay}ms (${attempt}/${maxAttempts})`);
        await sleep(delay);
      }
    }
  }
}
