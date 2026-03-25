import type { RuntimeErrorInfo, RuntimeErrorKind, RuntimeErrorPhase } from '../runtime/health-store.js';

export type ClassifiedTelegramError = {
  kind: RuntimeErrorKind;
  message: string;
  code?: string;
  statusCode?: number;
  retryAfterMs?: number;
  recoverable: boolean;
};

const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'fetch failed',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getNestedRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return asRecord(value?.[key]);
}

function getCode(value: Record<string, unknown> | null): string | undefined {
  const code = value?.code ?? value?.errno;
  return typeof code === 'string' ? code : undefined;
}

function getStatusCode(value: Record<string, unknown> | null): number | undefined {
  const statusCode = value?.error_code ?? value?.status ?? value?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function getRetryAfterMs(value: Record<string, unknown> | null): number | undefined {
  const parameters = asRecord(value?.parameters);
  const retryAfter = parameters?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  return undefined;
}

export function classifyTelegramError(error: unknown): ClassifiedTelegramError {
  const outer = asRecord(error);
  const inner = getNestedRecord(outer, 'error');
  const cause = getNestedRecord(outer, 'cause');
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = getStatusCode(outer) ?? getStatusCode(inner) ?? getStatusCode(cause);
  const code = getCode(outer) ?? getCode(inner) ?? getCode(cause);
  const retryAfterMs = getRetryAfterMs(outer) ?? getRetryAfterMs(inner) ?? getRetryAfterMs(cause);

  if (message.includes('Empty token')) {
    return { kind: 'config', message, code, statusCode, recoverable: false };
  }

  if (statusCode === 401) {
    return { kind: 'auth', message, code, statusCode, recoverable: false };
  }

  if (statusCode === 409) {
    return { kind: 'conflict', message, code, statusCode, recoverable: true };
  }

  if (statusCode === 429) {
    return { kind: 'rate_limit', message, code, statusCode, retryAfterMs, recoverable: true };
  }

  if (
    (code && NETWORK_CODES.has(code)) ||
    message.includes('Network request') ||
    message.includes('fetch failed') ||
    message.includes('timed out')
  ) {
    return { kind: 'network_transient', message, code, statusCode, retryAfterMs, recoverable: true };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return { kind: 'server_transient', message, code, statusCode, retryAfterMs, recoverable: true };
  }

  return { kind: 'fatal_unknown', message, code, statusCode, retryAfterMs, recoverable: false };
}

export function toRuntimeErrorInfo(error: unknown, phase: RuntimeErrorPhase): RuntimeErrorInfo {
  const classified = classifyTelegramError(error);
  return {
    ...classified,
    phase,
    at: new Date().toISOString(),
  };
}
