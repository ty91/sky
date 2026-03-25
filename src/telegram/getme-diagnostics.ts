import https from 'node:https';
import { abortError, isAbortError, timeoutError } from '../runtime/retry.js';

export type DirectGetMeProbe = {
  ok: boolean;
  networkFamily: 4;
  statusCode?: number;
  totalMs: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  remoteAddress?: string;
  remoteFamily?: string | number;
  userId?: number;
  username?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type ProbeGetMeOptions = {
  botToken: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

type ProbeError = Error & {
  code?: string;
  statusCode?: number;
  probe?: Omit<DirectGetMeProbe, 'ok'>;
};

function elapsedMs(start: number, end?: number): number | undefined {
  return end === undefined ? undefined : Math.round(end - start);
}

function phaseMs(start?: number, end?: number): number | undefined {
  return start === undefined || end === undefined ? undefined : Math.round(end - start);
}

function formatDuration(value?: number): string {
  return value === undefined ? 'n/a' : `${value}ms`;
}

function createProbeError(message: string, extra: Partial<ProbeError> = {}): ProbeError {
  const error = new Error(message) as ProbeError;
  Object.assign(error, extra);
  return error;
}

export function formatDirectGetMeProbe(probe: DirectGetMeProbe): string {
  return [
    `ok=${probe.ok ? 'yes' : 'no'}`,
    `status=${probe.statusCode ?? 'n/a'}`,
    `total=${formatDuration(probe.totalMs)}`,
    `dns=${formatDuration(probe.dnsMs)}`,
    `tcp=${formatDuration(probe.tcpMs)}`,
    `tls=${formatDuration(probe.tlsMs)}`,
    `ttfb=${formatDuration(probe.ttfbMs)}`,
    `remote=${probe.remoteAddress ?? 'n/a'}`,
    `family=${probe.remoteFamily ?? 'n/a'}`,
    'network=ipv4',
    `code=${probe.errorCode ?? 'n/a'}`,
  ].join(' ');
}

export async function probeTelegramGetMe(options: ProbeGetMeOptions): Promise<DirectGetMeProbe> {
  const { botToken, timeoutMs, signal } = options;

  if (signal?.aborted) {
    throw abortError();
  }

  const startedAt = performance.now();

  return await new Promise<DirectGetMeProbe>((resolve, reject) => {
    let lookupAt: number | undefined;
    let connectAt: number | undefined;
    let secureConnectAt: number | undefined;
    let firstByteAt: number | undefined;
    let remoteAddress: string | undefined;
    let remoteFamily: string | number | undefined;
    let finished = false;

    const snapshot = (endedAt: number): Omit<DirectGetMeProbe, 'ok'> => ({
      networkFamily: 4,
      statusCode: responseStatusCode,
      totalMs: Math.round(endedAt - startedAt),
      dnsMs: elapsedMs(startedAt, lookupAt),
      tcpMs: phaseMs(lookupAt ?? startedAt, connectAt),
      tlsMs: phaseMs(connectAt, secureConnectAt),
      ttfbMs: phaseMs(secureConnectAt ?? connectAt ?? startedAt, firstByteAt),
      remoteAddress,
      remoteFamily,
      userId,
      username,
    });

    let responseStatusCode: number | undefined;
    let userId: number | undefined;
    let username: string | undefined;

    const finalize = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      req.destroy(abortError());
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: 'api.telegram.org',
        method: 'GET',
        path: `/bot${botToken}/getMe`,
        family: 4,
      },
      (res) => {
        responseStatusCode = res.statusCode;
        firstByteAt = performance.now();
        remoteAddress = res.socket.remoteAddress ?? remoteAddress;
        remoteFamily = res.socket.remoteFamily ?? undefined;

        let rawBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          rawBody += chunk;
        });
        res.once('end', () => {
          const endedAt = performance.now();
          try {
            const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
            const result =
              payload && typeof payload.result === 'object' && payload.result !== null
                ? (payload.result as Record<string, unknown>)
                : null;
            if (result) {
              if (typeof result.id === 'number') userId = result.id;
              if (typeof result.username === 'string') username = result.username;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || payload?.ok !== true) {
              const description = typeof payload?.description === 'string' ? payload.description : `getMe failed (${res.statusCode ?? 'unknown'})`;
              finalize(() => {
                reject(
                  createProbeError(description, {
                    statusCode: res.statusCode,
                    code: typeof payload?.error_code === 'number' ? String(payload.error_code) : undefined,
                    probe: {
                      ...snapshot(endedAt),
                      errorMessage: description,
                    },
                  }),
                );
              });
              return;
            }

            finalize(() => {
              resolve({
                ok: true,
                ...snapshot(endedAt),
              });
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finalize(() => {
              reject(
                createProbeError(message, {
                  code: 'EBADRESP',
                  probe: {
                    ...snapshot(endedAt),
                    errorCode: 'EBADRESP',
                    errorMessage: message,
                  },
                }),
              );
            });
          }
        });
      },
    );

    req.once('socket', (socket) => {
      socket.once('lookup', (_error, address, resolvedFamily) => {
        lookupAt = performance.now();
        remoteAddress = address;
        remoteFamily = resolvedFamily ?? undefined;
      });
      socket.once('connect', () => {
        connectAt = performance.now();
        remoteAddress = socket.remoteAddress ?? remoteAddress;
        remoteFamily = socket.remoteFamily ?? undefined;
      });
      socket.once('secureConnect', () => {
        secureConnectAt = performance.now();
        remoteAddress = socket.remoteAddress ?? remoteAddress;
        remoteFamily = socket.remoteFamily ?? undefined;
      });
    });

    req.once('error', (error) => {
      const endedAt = performance.now();
      if (isAbortError(error)) {
        finalize(() => reject(error));
        return;
      }
      const probeError = error as ProbeError;
      probeError.probe = {
        ...snapshot(endedAt),
        errorCode: typeof probeError.code === 'string' ? probeError.code : undefined,
        errorMessage: probeError.message,
      };
      finalize(() => reject(probeError));
    });

    const timer = setTimeout(() => {
      req.destroy(timeoutError(`Direct getMe probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}
