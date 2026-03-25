export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
};

export function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}, random = Math.random): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const raw = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), maxMs);
  const jitter = raw * jitterRatio;
  const min = Math.max(0, raw - jitter);
  const max = raw + jitter;
  return Math.round(min + (max - min) * random());
}
