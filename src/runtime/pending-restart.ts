import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { SKY_DIR } from '../settings.js';

const PENDING_PATH = path.join(SKY_DIR, 'pending-restart.json');
const HISTORY_PATH = path.join(SKY_DIR, 'restart-history.json');

/** Minimum interval between two accepted restart requests (ms). */
export const MIN_RESTART_INTERVAL_MS = 60_000;

/**
 * Payload written by the `restart_harness` tool and consumed by the next
 * daemon after boot. Contains everything needed to re-open the originating
 * session and post the post-restart trigger back to the right place.
 */
export type PendingRestart = {
  /** Session key used by the session manager (e.g. `"C123:1234.5678"`). */
  sessionKey: string;
  /** Slack channel id (duplicated so we do not have to re-parse sessionKey). */
  channelId: string;
  /** Slack thread ts (same duplication reasoning). */
  threadTs: string;
  /** Optional short reason shown back to Sky in the post-restart notice. */
  reason?: string;
  /** Unix millis when the tool was invoked (not when the restart actually occurs). */
  requestedAt: number;
};

export type RestartRequestResult =
  | { ok: true }
  | { ok: false; reason: 'rate-limited'; remainingMs: number };

type HistoryFile = {
  lastRestartAt?: number;
};

function readHistory(): HistoryFile {
  try {
    const raw = readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as HistoryFile;
    }
  } catch {
    // File missing or malformed — treat as empty.
  }
  return {};
}

function writeHistory(history: HistoryFile): void {
  mkdirSync(SKY_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Record a restart request. Returns `{ ok: false }` if called again within
 * {@link MIN_RESTART_INTERVAL_MS} of the previous accepted request — this is
 * the primary guard against restart loops.
 */
export function requestRestart(info: PendingRestart): RestartRequestResult {
  mkdirSync(SKY_DIR, { recursive: true });

  const history = readHistory();
  const last = history.lastRestartAt ?? 0;
  const elapsed = Date.now() - last;
  if (last > 0 && elapsed < MIN_RESTART_INTERVAL_MS) {
    return {
      ok: false,
      reason: 'rate-limited',
      remainingMs: MIN_RESTART_INTERVAL_MS - elapsed,
    };
  }

  writeFileSync(PENDING_PATH, JSON.stringify(info, null, 2));
  writeHistory({ ...history, lastRestartAt: Date.now() });
  return { ok: true };
}

/** True if a pending-restart file exists on disk. Read-only. */
export function isRestartPending(): boolean {
  return existsSync(PENDING_PATH);
}

/**
 * Read-and-delete. Rename the file first so a race between two daemons (e.g.
 * an accidental double-boot) only gives the payload to one of them. Returns
 * `null` if no pending restart is present or the file is malformed.
 */
export function consumePendingRestart(): PendingRestart | null {
  if (!existsSync(PENDING_PATH)) return null;

  const tmp = `${PENDING_PATH}.consuming`;
  try {
    renameSync(PENDING_PATH, tmp);
  } catch {
    // Another process already renamed it — treat as "not ours".
    return null;
  }

  try {
    const raw = readFileSync(tmp, 'utf8');
    const parsed = JSON.parse(raw) as PendingRestart;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessionKey !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore — the consumer already got the payload.
    }
  }
}

/**
 * Test-only helper: wipe both the pending file and the history so a test can
 * exercise rate-limiting deterministically. Not exposed via the daemon.
 */
export function _resetRestartStateForTests(): void {
  for (const p of [PENDING_PATH, HISTORY_PATH, `${PENDING_PATH}.consuming`]) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
