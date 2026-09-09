import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeQueryDiagnostics } from '../agents/backend/claude-observability.js';
import type { SupervisionMode } from '../runtime/controller.js';
import { ensurePrivateFile, type SkyHome } from '../sky-home.js';
import type { JsonlLogger } from './logger.js';

export const CLAUDE_DIAGNOSTICS_ENV = 'SKY_CLAUDE_DIAGNOSTICS';
export const CLAUDE_DEBUG_LOG_NAME = 'claude-agent-sdk.debug.log';
const MAX_DEBUG_BYTES = 10 * 1024 * 1024;

function createBoundedDebugWriter(filePath: string, maxBytes: number): (data: string) => void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer.');
  }
  ensurePrivateFile(filePath, true);
  writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(filePath);
  let writtenBytes = 0;
  let disabled = false;

  return (data: string) => {
    if (disabled) return;
    const remainingBytes = maxBytes - writtenBytes;
    if (remainingBytes <= 0 || data.length === 0) return;
    const bytes = Buffer.from(data);
    const selected = bytes.length <= remainingBytes ? bytes : bytes.subarray(0, remainingBytes);
    try {
      ensurePrivateFile(filePath);
      appendFileSync(filePath, selected, { mode: 0o600 });
      ensurePrivateFile(filePath);
      writtenBytes += selected.length;
    } catch {
      // A replaced or unwritable debug file disables optional diagnostics only.
      disabled = true;
    }
  };
}

export function createSkydClaudeDiagnostics(input: {
  paths: SkyHome;
  logger: JsonlLogger;
  supervisionMode: SupervisionMode;
  env?: NodeJS.ProcessEnv;
  maxDebugBytes?: number;
}): ClaudeQueryDiagnostics {
  const env = input.env ?? process.env;
  const debugStderr =
    env[CLAUDE_DIAGNOSTICS_ENV] === '1'
      ? createBoundedDebugWriter(
          path.join(input.paths.logsDir, CLAUDE_DEBUG_LOG_NAME),
          input.maxDebugBytes ?? MAX_DEBUG_BYTES,
        )
      : undefined;

  return {
    supervisionMode: input.supervisionMode,
    ...(debugStderr ? { debugStderr } : {}),
    sink(level, event, fields) {
      input.logger.log(level, 'claude-query', `${event} ${JSON.stringify(fields)}`);
    },
  };
}
