import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUDECLAW_DIR } from '../settings.js';

export type BotLifecycleState = 'idle' | 'initializing' | 'polling' | 'degraded' | 'stopping' | 'stopped' | 'fatal';
export type RuntimeErrorKind = 'auth' | 'config' | 'network_transient' | 'rate_limit' | 'conflict' | 'fatal_unknown';
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

export type RuntimeHealth = {
  pid: number;
  state: BotLifecycleState;
  ready: boolean;
  recoverable: boolean;
  startedAt: string;
  updatedAt: string;
  lastStateChangedAt: string;
  botUsername?: string;
  botUserId?: number;
  lastInitSuccessAt?: string;
  lastPollingStartedAt?: string;
  lastPollingStoppedAt?: string;
  lastUpdateReceivedAt?: string;
  lastOutboundSuccessAt?: string;
  lastOutboundFailureAt?: string;
  consecutiveFailures: number;
  currentBackoffMs?: number;
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
    ready: false,
    recoverable: true,
    startedAt: now,
    updatedAt: now,
    lastStateChangedAt: now,
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
    return JSON.parse(readFileSync(HEALTH_FILE, 'utf8')) as RuntimeHealth;
  } catch {
    return null;
  }
}
