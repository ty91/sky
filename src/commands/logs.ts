import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getServiceStatus } from '../service/launch-agent.js';
import {
  ControlRequestError,
  getLogHistory,
  streamLogRecords,
} from '../skyd/control-uds.js';
import {
  LogCursorNotFoundError,
  readLogRecords,
  selectLogHistory,
  type LogRecord,
} from '../skyd/logger.js';
import {
  createSkyHome,
  inspectPrivateFile,
  type SkyHome,
} from '../sky-home.js';

type LogsOptions = {
  follow?: boolean;
  json?: boolean;
  limit?: string;
  cursor?: string;
};

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('--limit must be an integer between 1 and 1000.');
  }
  return limit;
}

function printRecord(record: LogRecord, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(record));
    return;
  }
  const operation = record.operationId ? ` operation=${record.operationId}` : '';
  console.log(
    `${record.timestamp} ${record.level.toUpperCase().padEnd(5)} [${record.scope}]${operation} ${record.message}`,
  );
}

function stderrRecords(filePath: string, limit: number): LogRecord[] {
  if (!inspectPrivateFile(filePath)) return [];
  const allLines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const lines = allLines.slice(-limit);
  const offset = allLines.length - lines.length;
  return lines.map((message, index) => ({
    cursor: `launchd-stderr:${offset + index + 1}`,
    timestamp: 'unknown',
    level: 'error',
    scope: 'launchd',
    message,
  }));
}

function fallbackRecords(home: SkyHome, cursor: string | undefined, limit: number): LogRecord[] {
  const records = readLogRecords(home.logFile);
  try {
    return selectLogHistory(records, cursor, limit).records;
  } catch (error) {
    if (error instanceof LogCursorNotFoundError) return records.slice(-limit);
    throw error;
  }
}

function printFallback(
  home: SkyHome,
  cursor: string | undefined,
  limit: number,
  json: boolean,
  includeLaunchdStderr: boolean,
): string | undefined {
  const appRecords = fallbackRecords(home, cursor, limit);
  for (const record of appRecords) printRecord(record, json);
  if (includeLaunchdStderr) {
    for (const record of stderrRecords(home.launchdStderrFile, limit)) printRecord(record, json);
  }
  return appRecords.at(-1)?.cursor ?? cursor;
}

async function launchAgentLoaded(): Promise<boolean> {
  try {
    return (await getServiceStatus()).launchd.loaded;
  } catch {
    return false;
  }
}

function abortableBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function followLogs(
  cursor: string | undefined,
  json: boolean,
  limit: number,
): Promise<void> {
  const home = createSkyHome();
  const socketFile = home.socketFile;
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  let lastCursor = cursor;
  let delayMs = 100;
  let printedFallback = false;

  try {
    while (!abortController.signal.aborted) {
      try {
        for await (const record of streamLogRecords(socketFile, {
          cursor: lastCursor,
          signal: abortController.signal,
        })) {
          printRecord(record, json);
          lastCursor = record.cursor;
          delayMs = 100;
        }
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (error instanceof ControlRequestError && error.code === 'log_cursor_expired') {
          lastCursor = undefined;
        }
      }

      if (abortController.signal.aborted) return;
      if (!(await launchAgentLoaded())) {
        printFallback(home, lastCursor, limit, json, !printedFallback);
        return;
      }
      if (!printedFallback) {
        lastCursor = printFallback(home, lastCursor, limit, json, true);
        printedFallback = true;
      }
      await abortableBackoff(delayMs, abortController.signal);
      delayMs = Math.min(2_000, delayMs * 2);
    }
  } finally {
    process.removeListener('SIGINT', stop);
  }
}

async function showLogs(options: LogsOptions): Promise<void> {
  const home = createSkyHome();
  const json = options.json === true;
  const limit = parseLimit(options.limit ?? '200');
  if (options.follow) {
    await followLogs(options.cursor, json, limit);
    return;
  }

  try {
    const history = await getLogHistory(home.socketFile, {
      cursor: options.cursor,
      limit,
    });
    for (const record of history.records) printRecord(record, json);
  } catch {
    const records = fallbackRecords(home, options.cursor, limit);
    for (const record of records) printRecord(record, json);
    for (const record of stderrRecords(home.launchdStderrFile, limit)) {
      printRecord(record, json);
    }
    if (records.length === 0 && !existsSync(home.launchdStderrFile) && !json) {
      console.log('No logs found yet.');
    }
  }
}

export const logsCommand = new Command('logs')
  .description('Show structured daemon logs')
  .option('-f, --follow', 'follow logs and reconnect across daemon restarts')
  .option('--json', 'Print structured records as JSONL')
  .option('--limit <count>', 'maximum history records (1-1000)', '200')
  .option('--cursor <cursor>', 'show records after a cursor')
  .action(showLogs);
