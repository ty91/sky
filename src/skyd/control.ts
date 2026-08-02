import { chmodSync, lstatSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { LogCursorNotFoundError, type JsonlLogger, type LogRecord } from './logger.js';
import type {
  OperationEvent,
  OperationRecord,
  OperationRegistry,
  OperationRequest,
} from './operations.js';
import type { DaemonStatus } from './types.js';

const CONTROL_REQUEST_TIMEOUT_MS = 2_000;

export class DaemonAlreadyRunningError extends Error {
  constructor(socketFile: string) {
    super(`A skyd instance is already listening at ${socketFile}.`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export class ControlRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, statusCode: number, details: Record<string, unknown> = {}) {
    super(`Control request failed with ${code}.`);
    this.name = 'ControlRequestError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export type ControlServer = {
  close(): Promise<void>;
};

export type ControlRestartResult =
  | { ok: true; instanceId: string }
  | { ok: false; code: string; message: string; statusCode: number };

export type ControlServerOptions = {
  requestRestart?: () => ControlRestartResult;
  operations?: OperationRegistry;
  logger?: JsonlLogger;
};

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function probeSocket(socketFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketFile);
    let settled = false;

    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function writeNdjson(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parseOperationRequest(value: unknown): OperationRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'memory' && Object.keys(candidate).length === 1) {
    return { type: 'memory' };
  }
  if (candidate.type !== 'dream') return undefined;
  if (
    candidate.date !== undefined &&
    (typeof candidate.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date))
  ) {
    return undefined;
  }
  if (
    candidate.step !== undefined &&
    candidate.step !== 'summarize' &&
    candidate.step !== 'knowledge'
  ) {
    return undefined;
  }
  if (Object.keys(candidate).some((key) => key !== 'type' && key !== 'date' && key !== 'step')) {
    return undefined;
  }
  return {
    type: 'dream',
    ...(typeof candidate.date === 'string' ? { date: candidate.date } : {}),
    ...(candidate.step === 'summarize' || candidate.step === 'knowledge'
      ? { step: candidate.step }
      : {}),
  };
}

function terminalOperation(state: OperationRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function streamOperationEvents(
  request: IncomingMessage,
  response: ServerResponse,
  registry: OperationRegistry,
  operationId: string,
  afterSequence: number,
): void {
  const source = registry.events(operationId, afterSequence);
  if (!source) {
    writeJson(response, 404, { error: { code: 'operation_not_found' } });
    return;
  }
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  for (const event of source.events) writeNdjson(response, event);
  if (terminalOperation(source.operation.state)) {
    response.end();
    return;
  }
  const unsubscribe = source.subscribe((event) => {
    writeNdjson(response, event);
    if (terminalOperation(event.type as OperationRecord['state'])) {
      unsubscribe();
      response.end();
    }
  });
  request.once('close', unsubscribe);
}

function streamLogs(
  request: IncomingMessage,
  response: ServerResponse,
  logger: JsonlLogger,
  cursor?: string,
): void {
  let history;
  try {
    history = logger.history(cursor, 1_000);
  } catch (error) {
    if (error instanceof LogCursorNotFoundError) {
      writeJson(response, 410, { error: { code: 'log_cursor_expired' } });
      return;
    }
    throw error;
  }
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  for (const record of history.records) writeNdjson(response, record);
  const unsubscribe = logger.subscribe((record) => writeNdjson(response, record));
  request.once('close', unsubscribe);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  getStatus: () => DaemonStatus,
  options: ControlServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/status') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      writeJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    writeJson(response, 200, getStatus());
    return;
  }

  if (url.pathname === '/restart') {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      writeJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if (!options.requestRestart) {
      writeJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    const result = options.requestRestart();
    if (!result.ok) {
      writeJson(response, result.statusCode, {
        error: { code: result.code, message: result.message },
      });
      return;
    }
    writeJson(response, 202, { accepted: true, instanceId: result.instanceId });
    return;
  }

  if (url.pathname === '/operations') {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      writeJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if (!options.operations) {
      writeJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    let input: OperationRequest | undefined;
    try {
      input = parseOperationRequest(await readJsonBody(request));
    } catch {
      input = undefined;
    }
    if (!input) {
      writeJson(response, 400, { error: { code: 'invalid_operation' } });
      return;
    }
    const result = options.operations.create(input);
    if (!result.ok) {
      if (result.code === 'operation_active') {
        writeJson(response, 409, {
          error: { code: result.code, activeOperationId: result.activeOperationId },
        });
      } else {
        writeJson(response, 503, { error: { code: result.code } });
      }
      return;
    }
    writeJson(response, 202, { operationId: result.operation.id });
    return;
  }

  const operationMatch = url.pathname.match(/^\/operations\/([^/]+)(\/events)?$/);
  if (operationMatch) {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      writeJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if (!options.operations) {
      writeJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    const operationId = decodeURIComponent(operationMatch[1]);
    if (operationMatch[2]) {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) {
        writeJson(response, 400, { error: { code: 'invalid_cursor' } });
        return;
      }
      streamOperationEvents(request, response, options.operations, operationId, after);
      return;
    }
    const operation = options.operations.get(operationId);
    if (!operation) {
      writeJson(response, 404, { error: { code: 'operation_not_found' } });
      return;
    }
    writeJson(response, 200, operation);
    return;
  }

  if (url.pathname === '/logs' || url.pathname === '/logs/stream') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      writeJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if (!options.logger) {
      writeJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (url.pathname === '/logs/stream') {
      streamLogs(request, response, options.logger, cursor);
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? '200');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      writeJson(response, 400, { error: { code: 'invalid_limit' } });
      return;
    }
    try {
      writeJson(response, 200, options.logger.history(cursor, limit));
    } catch (error) {
      if (error instanceof LogCursorNotFoundError) {
        writeJson(response, 410, { error: { code: 'log_cursor_expired' } });
        return;
      }
      throw error;
    }
    return;
  }

  writeJson(response, 404, { error: { code: 'not_found' } });
}

async function prepareSocket(socketFile: string): Promise<void> {
  let stats;
  try {
    stats = lstatSync(socketFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  if (!stats.isSocket()) {
    throw new Error(`Refusing to replace a non-socket path at ${socketFile}.`);
  }
  if (await probeSocket(socketFile)) {
    throw new DaemonAlreadyRunningError(socketFile);
  }
  rmSync(socketFile);
}

export async function startControlServer(
  socketFile: string,
  getStatus: () => DaemonStatus,
  options: ControlServerOptions = {},
): Promise<ControlServer> {
  await prepareSocket(socketFile);

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, getStatus, options).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: { code: 'internal_error' } });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketFile);
  });

  let listeningIdentity: string;
  try {
    const listeningStats = lstatSync(socketFile);
    listeningIdentity = `${listeningStats.dev}:${listeningStats.ino}`;
    chmodSync(socketFile, 0o600);
  } catch (error) {
    await closeHttpServer(server);
    rmSync(socketFile, { force: true });
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      const closing = closeHttpServer(server);
      server.closeAllConnections();
      await closing;
      try {
        const stats = lstatSync(socketFile);
        if (stats.isSocket() && `${stats.dev}:${stats.ino}` === listeningIdentity) {
          rmSync(socketFile);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    },
  };
}

function requestJson<T>(
  socketFile: string,
  method: 'GET' | 'POST',
  requestPath: string,
  expectedStatus: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: socketFile,
        path: requestPath,
        method,
        headers: { accept: 'application/json' },
      },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as T;
            if (response.statusCode !== expectedStatus) {
              const candidate = parsed as { error?: { code?: string; [key: string]: unknown } };
              const code = candidate.error?.code;
              const { code: _code, ...details } = candidate.error ?? {};
              reject(
                new ControlRequestError(code ?? 'unknown_error', response.statusCode ?? 500, details),
              );
              return;
            }
            resolve(parsed as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Daemon control request timed out after ${CONTROL_REQUEST_TIMEOUT_MS}ms.`),
      );
    });
    request.once('error', reject);
    request.end();
  });
}

export function getDaemonStatus(socketFile: string): Promise<DaemonStatus> {
  return requestJson<DaemonStatus>(socketFile, 'GET', '/status', 200);
}

export function requestDaemonRestart(
  socketFile: string,
): Promise<{ accepted: true; instanceId: string }> {
  return requestJson(socketFile, 'POST', '/restart', 202);
}

export function createOperation(
  socketFile: string,
  input: OperationRequest,
): Promise<{ operationId: string }> {
  return requestJsonWithBody(socketFile, 'POST', '/operations', 202, input);
}

function requestJsonWithBody<T>(
  socketFile: string,
  method: 'POST',
  requestPath: string,
  expectedStatus: number,
  bodyValue: unknown,
): Promise<T> {
  const body = JSON.stringify(bodyValue);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: socketFile,
        path: requestPath,
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.setEncoding('utf8');
        let responseBody = '';
        response.on('data', (chunk: string) => (responseBody += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody) as T & {
              error?: { code?: string; [key: string]: unknown };
            };
            if (response.statusCode !== expectedStatus) {
              const { code, ...details } = parsed.error ?? {};
              reject(new ControlRequestError(code ?? 'unknown_error', response.statusCode ?? 500, details));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Control request timed out.')));
    request.once('error', reject);
    request.end(body);
  });
}

export function getOperation(socketFile: string, operationId: string): Promise<OperationRecord> {
  return requestJson(socketFile, 'GET', `/operations/${encodeURIComponent(operationId)}`, 200);
}

export function getLogHistory(
  socketFile: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ records: LogRecord[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query}` : '';
  return requestJson(socketFile, 'GET', `/logs${suffix}`, 200);
}

function streamNdjson<T>(
  socketFile: string,
  requestPath: string,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const stream = async function* (): AsyncGenerator<T> {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        { socketPath: socketFile, path: requestPath, method: 'GET' },
        (candidate) => {
          if (candidate.statusCode !== 200) {
            candidate.setEncoding('utf8');
            let body = '';
            candidate.on('data', (chunk: string) => (body += chunk));
            candidate.on('end', () => {
              try {
                const parsed = JSON.parse(body) as { error?: { code?: string } };
                reject(new ControlRequestError(parsed.error?.code ?? 'unknown_error', candidate.statusCode ?? 500));
              } catch (error) {
                reject(error);
              }
            });
            return;
          }
          resolve(candidate);
        },
      );
      const abort = () => request.destroy(new Error('aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal?.removeEventListener('abort', abort));
      request.once('error', reject);
      request.end();
    });
    response.setEncoding('utf8');
    const abort = () => response.destroy(new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    let pending = '';
    try {
      for await (const chunk of response) {
        pending += chunk as string;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) yield JSON.parse(line) as T;
          newline = pending.indexOf('\n');
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      response.destroy();
    }
  };
  return { [Symbol.asyncIterator]: stream };
}

export function watchOperation(
  socketFile: string,
  operationId: string,
  options: { after?: number; signal?: AbortSignal } = {},
): AsyncIterable<OperationEvent> {
  const query = options.after ? `?after=${options.after}` : '';
  return streamNdjson(
    socketFile,
    `/operations/${encodeURIComponent(operationId)}/events${query}`,
    options.signal,
  );
}

export function streamLogRecords(
  socketFile: string,
  options: { cursor?: string; signal?: AbortSignal } = {},
): AsyncIterable<LogRecord> {
  const query = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : '';
  return streamNdjson(socketFile, `/logs/stream${query}`, options.signal);
}
