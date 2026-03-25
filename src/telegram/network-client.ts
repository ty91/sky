import { Agent, fetch as undiciFetch } from 'undici';
import { abortError, timeoutError } from '../runtime/retry.js';
import { probeTelegramGetMe, type DirectGetMeProbe } from './getme-diagnostics.js';
import type { TelegramBotIdentity } from './transport.js';

export type TelegramProbeResult = {
  identity: TelegramBotIdentity;
  probe: DirectGetMeProbe;
};

export type TelegramNetworkClientOptions = {
  botToken: string;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  getUpdatesTimeoutMs?: number;
  deleteWebhookTimeoutMs?: number;
};

type TelegramRequestMethod = 'getme' | 'deletewebhook' | 'getupdates' | 'sendmessage' | 'sendchataction' | 'unknown';

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_GET_UPDATES_TIMEOUT_MS = 45000;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && 'aborted' in value;
}

function readRequestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input !== null && 'url' in input) {
    const url = (input as { url?: unknown }).url;
    return typeof url === 'string' ? url : null;
  }
  return null;
}

function readTelegramMethod(input: RequestInfo | URL): TelegramRequestMethod {
  const url = readRequestUrl(input);
  if (!url) return 'unknown';

  try {
    const pathname = new URL(url).pathname;
    const method = pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
    switch (method) {
      case 'getme':
      case 'deletewebhook':
      case 'getupdates':
      case 'sendmessage':
      case 'sendchataction':
        return method;
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

function methodLabel(method: TelegramRequestMethod): string {
  return method === 'unknown' ? 'request' : method;
}

function mergeAbortSignals(controller: AbortController, signals: Array<AbortSignal | undefined>): () => void {
  const listeners: Array<() => void> = [];

  const abortWith = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason ?? abortError());
    }
  };

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abortWith(signal);
      continue;
    }
    const onAbort = () => abortWith(signal);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }

  return () => {
    for (const remove of listeners) {
      remove();
    }
  };
}

export class TelegramNetworkClient {
  private readonly dispatcher = new Agent({
    connect: { family: 4 },
  });

  constructor(private readonly options: TelegramNetworkClientOptions) {}

  async probeGetMe(signal?: AbortSignal): Promise<TelegramProbeResult> {
    const probe = await probeTelegramGetMe({
      botToken: this.options.botToken,
      timeoutMs: this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      signal,
    });

    if (!probe.userId || !probe.username) {
      const error = new Error('Telegram getMe returned incomplete bot identity') as Error & {
        code?: string;
        probe?: DirectGetMeProbe;
      };
      error.code = 'EBADRESP';
      error.probe = {
        ...probe,
        ok: false,
        errorCode: 'EBADRESP',
        errorMessage: error.message,
      };
      throw error;
    }

    return {
      identity: {
        id: probe.userId,
        username: probe.username,
      },
      probe,
    };
  }

  createFetch(runtimeSignal?: AbortSignal): typeof globalThis.fetch {
    return async (input, init) => {
      const method = readTelegramMethod(input);
      const timeoutMs = this.resolveTimeoutMs(method);
      const controller = new AbortController();
      const cleanupAbort = mergeAbortSignals(controller, [runtimeSignal, isAbortSignal(init?.signal) ? init.signal : undefined]);
      const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(timeoutError(`Telegram ${methodLabel(method)} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();

      try {
        return (await undiciFetch(input as never, {
          ...(init as RequestInit | undefined),
          dispatcher: this.dispatcher,
          signal: controller.signal,
        } as never)) as unknown as Response;
      } catch (error) {
        const finalError = controller.signal.aborted && controller.signal.reason instanceof Error
          ? controller.signal.reason
          : error;
        this.tagNetworkError(finalError, method);
        throw finalError;
      } finally {
        clearTimeout(timer);
        cleanupAbort();
      }
    };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private resolveTimeoutMs(method: TelegramRequestMethod): number {
    switch (method) {
      case 'getme':
        return this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      case 'deletewebhook':
        return this.options.deleteWebhookTimeoutMs ?? DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS;
      case 'getupdates':
        return this.options.getUpdatesTimeoutMs ?? DEFAULT_GET_UPDATES_TIMEOUT_MS;
      default:
        return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
  }

  private tagNetworkError(error: unknown, method: TelegramRequestMethod): void {
    if (typeof error !== 'object' || error === null) {
      return;
    }

    const tagged = error as Record<string, unknown>;
    tagged.telegramMethod = method;
    tagged.telegramNetwork = 'ipv4';
  }
}
