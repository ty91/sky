import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUDECLAW_DIR } from '../settings.js';

export type BotLifecycleState = 'idle' | 'running' | 'stopping' | 'stopped' | 'fatal';
export type TelegramPhase =
  | 'idle'
  | 'probing'
  | 'connecting'
  | 'polling'
  | 'backoff'
  | 'stopping'
  | 'stopped'
  | 'fatal';
export type RuntimeErrorKind = 'auth' | 'config' | 'network_transient' | 'server_transient' | 'rate_limit' | 'conflict' | 'fatal_unknown';
export type RuntimeErrorPhase = 'initialize' | 'polling' | 'send' | 'shutdown' | 'middleware';

export type RuntimeErrorInfo = {
  kind: RuntimeErrorKind;
  phase: RuntimeErrorPhase;
  message: string;
  code?: string;
  statusCode?: number;
  retryAfterMs?: number;
  recoverable: boolean;
  at: string;
};

export type TelegramProbeSnapshot = {
  ok: boolean;
  at: string;
  networkFamily: 4;
  durationMs: number;
  statusCode?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  remoteAddress?: string;
  remoteFamily?: string | number;
  username?: string;
  userId?: number;
  errorCode?: string;
  errorMessage?: string;
};

export type RuntimeHealth = {
  pid: number;
  state: BotLifecycleState;
  telegramPhase: TelegramPhase;
  telegramNetwork: 'ipv4';
  ready: boolean;
  recoverable: boolean;
  startedAt: string;
  updatedAt: string;
  lastStateChangedAt: string;
  botUsername?: string;
  botUserId?: number;
  currentAttempt: number;
  lastInitSuccessAt?: string;
  lastPollingStartedAt?: string;
  lastPollingStoppedAt?: string;
  lastUpdateReceivedAt?: string;
  lastOutboundSuccessAt?: string;
  lastOutboundFailureAt?: string;
  consecutiveFailures: number;
  currentBackoffMs?: number;
  lastProbe?: TelegramProbeSnapshot;
  lastError?: RuntimeErrorInfo;
};

export const HEALTH_FILE = path.join(CLAUDECLAW_DIR, 'runtime-health.json');

function nowIso(): string {
  return new Date().toISOString();
}

export function createInitialHealth(pid = process.pid): RuntimeHealth {
  const now = nowIso();
  return {
    pid,
    state: 'idle',
    telegramPhase: 'idle',
    telegramNetwork: 'ipv4',
    ready: false,
    recoverable: true,
    startedAt: now,
    updatedAt: now,
    lastStateChangedAt: now,
    currentAttempt: 0,
    consecutiveFailures: 0,
  };
}

export function writeHealthSnapshot(snapshot: RuntimeHealth): void {
  mkdirSync(CLAUDECLAW_DIR, { recursive: true });
  const nextSnapshot: RuntimeHealth = {
    ...snapshot,
    updatedAt: nowIso(),
  };
  const tempFile = `${HEALTH_FILE}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
  renameSync(tempFile, HEALTH_FILE);
}

export function readHealthSnapshot(): RuntimeHealth | null {
  try {
    const raw = JSON.parse(readFileSync(HEALTH_FILE, 'utf8')) as Partial<RuntimeHealth> & {
      telegramPhase?: TelegramPhase;
      currentAttempt?: number;
      lastNetworkStrategy?: { mode?: unknown };
      lastProbe?: Partial<TelegramProbeSnapshot> & { strategyMode?: unknown };
    };
    return {
      ...createInitialHealth(typeof raw.pid === 'number' ? raw.pid : process.pid),
      ...raw,
      state: normalizeLifecycleState(raw.state),
      telegramPhase: raw.telegramPhase ?? (typeof raw.state === 'string' ? legacyTelegramPhase(raw.state) : 'idle'),
      telegramNetwork: 'ipv4',
      currentAttempt: raw.currentAttempt ?? 0,
      lastProbe: raw.lastProbe
        ? {
            ...raw.lastProbe,
            networkFamily: 4,
          }
        : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeLifecycleState(state: unknown): BotLifecycleState {
  switch (state) {
    case 'idle':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'fatal':
      return state;
    case 'initializing':
    case 'polling':
    case 'degraded':
      return 'running';
    default:
      return 'idle';
  }
}

function legacyTelegramPhase(state: string): TelegramPhase {
  switch (state) {
    case 'initializing':
      return 'probing';
    case 'polling':
      return 'polling';
    case 'degraded':
      return 'backoff';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'fatal':
      return 'fatal';
    default:
      return 'idle';
  }
}
