import {
  appendFileSync,
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  operationId?: string;
  sessionId?: string;
};

export type JsonlLogger = {
  protect(values: readonly string[]): void;
  log(level: LogLevel, scope: string, message: string, context?: LogContext): void;
};

export type JsonlLoggerOptions = {
  maxBytes?: number;
  archiveCount?: number;
  now?: () => Date;
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
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '', { mode: 0o600 });
  }
  chmodSync(filePath, 0o600);
}

function rotate(filePath: string, archiveCount: number): void {
  if (archiveCount <= 0) {
    writeFileSync(filePath, '', { mode: 0o600 });
    return;
  }

  rmSync(`${filePath}.${archiveCount}`, { force: true });
  for (let index = archiveCount - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (existsSync(source)) {
      renameSync(source, `${filePath}.${index + 1}`);
    }
  }
  if (existsSync(filePath)) {
    renameSync(filePath, `${filePath}.1`);
  }
  writeFileSync(filePath, '', { mode: 0o600 });
}

export function createJsonlLogger(
  filePath: string,
  options: JsonlLoggerOptions = {},
): JsonlLogger {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const archiveCount = options.archiveCount ?? 5;
  const now = options.now ?? (() => new Date());
  const protectedValues = new Set<string>();

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
      const record = {
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
      chmodSync(filePath, 0o600);
    },
  };
}
