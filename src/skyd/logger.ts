import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensurePrivateFile, inspectPrivateFile } from '../sky-home.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  operationId?: string;
  sessionId?: string;
};

export type LogCursor = string;

export type LogRecord = {
  cursor: LogCursor;
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  operationId?: string;
  sessionId?: string;
};

export type LogHistory = {
  records: LogRecord[];
  nextCursor: LogCursor | null;
};

export class LogCursorNotFoundError extends Error {
  constructor(readonly cursor: string) {
    super(`Log cursor was not found: ${cursor}`);
    this.name = 'LogCursorNotFoundError';
  }
}

export type JsonlLogger = {
  protect(values: readonly string[]): void;
  log(level: LogLevel, scope: string, message: string, context?: LogContext): void;
  history(cursor?: string, limit?: number): LogHistory;
  subscribe(listener: (record: LogRecord) => void): () => void;
};

export type JsonlLoggerOptions = {
  maxBytes?: number;
  archiveCount?: number;
  now?: () => Date;
  instanceId?: string;
};

const TOKEN_PATTERNS = [
  /\b(?:xox[baprs]|xapp)-[A-Za-z0-9-]+\b/g,
  /\bsk-ant-[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
];
const JSON_TOKEN_PATTERN = /("(?:oauthToken|botToken|appToken)"\s*:\s*")[^"]+(")/gi;

function replaceAll(value: string, needle: string): string {
  return needle ? value.split(needle).join('[REDACTED]') : value;
}

function sanitize(value: string, protectedValues: ReadonlySet<string>): string {
  let sanitized = value;
  for (const secret of protectedValues) {
    sanitized = replaceAll(sanitized, secret);
  }
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  sanitized = sanitized.replace(JSON_TOKEN_PATTERN, '$1[REDACTED]$2');
  return sanitized;
}

function ensureLogFile(filePath: string): void {
  ensurePrivateFile(filePath, true);
}

function rotate(filePath: string, archiveCount: number): void {
  if (archiveCount <= 0) {
    ensurePrivateFile(filePath);
    writeFileSync(filePath, '', { mode: 0o600 });
    ensurePrivateFile(filePath);
    return;
  }

  const oldestArchive = `${filePath}.${archiveCount}`;
  if (inspectPrivateFile(oldestArchive)) rmSync(oldestArchive);
  for (let index = archiveCount - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (existsSync(source)) {
      ensurePrivateFile(source);
      const destination = `${filePath}.${index + 1}`;
      renameSync(source, destination);
      ensurePrivateFile(destination);
    }
  }
  if (existsSync(filePath)) {
    ensurePrivateFile(filePath);
    renameSync(filePath, `${filePath}.1`);
    ensurePrivateFile(`${filePath}.1`);
  }
  ensurePrivateFile(filePath, true);
}

function isLogRecord(value: unknown): value is LogRecord {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<LogRecord>;
  return (
    typeof candidate.cursor === 'string' &&
    typeof candidate.timestamp === 'string' &&
    (candidate.level === 'debug' ||
      candidate.level === 'info' ||
      candidate.level === 'warn' ||
      candidate.level === 'error') &&
    typeof candidate.scope === 'string' &&
    typeof candidate.message === 'string'
  );
}

export function readLogRecords(filePath: string, archiveCount = 5): LogRecord[] {
  const files: string[] = [];
  for (let index = archiveCount; index >= 1; index -= 1) {
    const archive = `${filePath}.${index}`;
    if (inspectPrivateFile(archive)) files.push(archive);
  }
  if (inspectPrivateFile(filePath)) files.push(filePath);

  const records: LogRecord[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isLogRecord(parsed)) records.push(parsed);
      } catch {
        // A partial final line from a crashed writer is ignored.
      }
    }
  }
  return records;
}

export function selectLogHistory(
  records: readonly LogRecord[],
  cursor?: string,
  limit = 200,
): LogHistory {
  const boundedLimit = Math.max(1, Math.min(1_000, limit));
  let selected: LogRecord[];
  if (cursor) {
    const cursorIndex = records.findIndex((record) => record.cursor === cursor);
    if (cursorIndex === -1) throw new LogCursorNotFoundError(cursor);
    selected = records.slice(cursorIndex + 1, cursorIndex + 1 + boundedLimit);
  } else {
    selected = records.slice(-boundedLimit);
  }
  return {
    records: selected,
    nextCursor: selected.at(-1)?.cursor ?? cursor ?? null,
  };
}

export function createJsonlLogger(
  filePath: string,
  options: JsonlLoggerOptions = {},
): JsonlLogger {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const archiveCount = options.archiveCount ?? 5;
  const now = options.now ?? (() => new Date());
  const instanceId = options.instanceId ?? randomUUID();
  const protectedValues = new Set<string>();
  const listeners = new Set<(record: LogRecord) => void>();
  let sequence = 0;

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer.');
  }
  if (!Number.isSafeInteger(archiveCount) || archiveCount < 0) {
    throw new Error('archiveCount must be a non-negative integer.');
  }

  ensureLogFile(filePath);

  return {
    protect(values) {
      for (const value of values) {
        if (value) protectedValues.add(value);
      }
    },

    log(level, scope, message, context = {}) {
      ensureLogFile(filePath);
      sequence += 1;
      const record: LogRecord = {
        cursor: `${instanceId}:${sequence}`,
        timestamp: now().toISOString(),
        level,
        scope: sanitize(scope, protectedValues),
        message: sanitize(message, protectedValues),
        ...(context.operationId
          ? { operationId: sanitize(context.operationId, protectedValues) }
          : {}),
        ...(context.sessionId ? { sessionId: sanitize(context.sessionId, protectedValues) } : {}),
      };
      const line = `${JSON.stringify(record)}\n`;
      const currentBytes = statSync(filePath).size;
      if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > maxBytes) {
        rotate(filePath, archiveCount);
      }
      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      ensureLogFile(filePath);
      for (const listener of listeners) listener(record);
    },

    history(cursor, limit) {
      return selectLogHistory(readLogRecords(filePath, archiveCount), cursor, limit);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
