import { lstatSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { SecretName, SettingsPatch } from '../configuration.js';
import type { DiagnosticsReport } from '../diagnostics.js';
import { ensurePrivateSocket } from '../sky-home.js';
import {
  ControlError,
  type ControlConfiguration,
  type DaemonControl,
} from './control.js';
import type { LogHistory, LogRecord } from './logger.js';
import type { OperationEvent, OperationRecord, OperationRequest } from './operations.js';
import type { DaemonStatus } from './types.js';

const CONTROL_REQUEST_TIMEOUT_MS = 2_000;
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 64 * 1024;

export class DaemonAlreadyRunningError extends Error {
  constructor(socketFile: string) {
    super(`A skyd instance is already listening at ${socketFile}.`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export class ControlRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`Control request failed with ${code}.`);
    this.name = 'ControlRequestError';
  }
}

export type ControlServer = {
  close(): Promise<void>;
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

function writeControlError(response: ServerResponse, error: unknown): void {
  const controlError = error instanceof ControlError ? error : new ControlError('internal_error');
  writeJson(response, controlError.statusCode, {
    error: { code: controlError.code, ...controlError.details },
  });
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader('allow', allow);
  writeControlError(response, new ControlError('method_not_allowed'));
}

async function readJsonBody(request: IncomingMessage, invalidCode: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) throw new Error('request_too_large');
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ControlError(invalidCode);
  }
}

async function streamResponse<T>(
  response: ServerResponse,
  createStream: (signal: AbortSignal) => AsyncIterable<T>,
): Promise<void> {
  const abortController = new AbortController();
  const close = () => abortController.abort();
  response.once('close', close);
  try {
    const stream = createStream(abortController.signal);
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    for await (const value of stream) {
      response.write(`${JSON.stringify(value)}\n`);
    }
    if (!response.destroyed) response.end();
  } finally {
    response.removeListener('close', close);
    abortController.abort();
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  control: DaemonControl,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/status') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeJson(response, 200, await control.execute({ type: 'status' }));
    return;
  }

  if (url.pathname === '/diagnostics') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeJson(response, 200, await control.execute({ type: 'diagnostics' }));
    return;
  }

  if (url.pathname === '/configuration') {
    if (request.method === 'GET') {
      writeJson(response, 200, await control.execute({ type: 'configuration.get' }));
      return;
    }
    if (request.method !== 'PATCH') return methodNotAllowed(response, 'GET, PATCH');
    const body = await readJsonBody(request, 'invalid_request');
    writeJson(
      response,
      200,
      await control.execute({
        type: 'configuration.patch',
        body: body as { expectedRevision: number; patch: SettingsPatch },
      }),
    );
    return;
  }

  const secretMatch = url.pathname.match(/^\/secrets\/([^/]+)$/);
  if (secretMatch) {
    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return methodNotAllowed(response, 'PUT, DELETE');
    }
    const name = decodeURIComponent(secretMatch[1]);
    if (request.method === 'DELETE') {
      writeJson(
        response,
        200,
        await control.execute({ type: 'secret.delete', name: name as SecretName }),
      );
      return;
    }
    const body = await readJsonBody(request, 'invalid_request');
    writeJson(
      response,
      200,
      await control.execute({
        type: 'secret.put',
        name: name as SecretName,
        body: body as { value: string },
      }),
    );
    return;
  }

  if (url.pathname === '/restart') {
    if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
    writeJson(response, 202, await control.execute({ type: 'restart' }));
    return;
  }

  if (url.pathname === '/operations') {
    if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
    const body = await readJsonBody(request, 'invalid_operation');
    writeJson(
      response,
      202,
      await control.execute({ type: 'operation.create', body: body as OperationRequest }),
    );
    return;
  }

  const operationMatch = url.pathname.match(/^\/operations\/([^/]+)(\/events)?$/);
  if (operationMatch) {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    const operationId = decodeURIComponent(operationMatch[1]);
    if (!operationMatch[2]) {
      writeJson(response, 200, await control.execute({ type: 'operation.get', operationId }));
      return;
    }
    const after = Number(url.searchParams.get('after') ?? '0');
    await streamResponse(response, (signal) =>
      control.subscribe({ type: 'operation.events', operationId, after, signal }),
    );
    return;
  }

  if (url.pathname === '/logs' || url.pathname === '/logs/stream') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (url.pathname === '/logs') {
      const limit = Number(url.searchParams.get('limit') ?? '200');
      writeJson(
        response,
        200,
        await control.execute({ type: 'logs.history', cursor, limit }),
      );
      return;
    }
    await streamResponse(response, (signal) =>
      control.subscribe({ type: 'logs.stream', cursor, signal }),
    );
    return;
  }

  writeControlError(response, new ControlError('not_found'));
}

async function prepareSocket(socketFile: string): Promise<void> {
  if (!ensurePrivateSocket(socketFile)) return;
  if (await probeSocket(socketFile)) throw new DaemonAlreadyRunningError(socketFile);
  rmSync(socketFile);
}

export async function startControlServer(
  socketFile: string,
  control: DaemonControl,
): Promise<ControlServer> {
  await prepareSocket(socketFile);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, control).catch((error) => {
      if (!response.headersSent) writeControlError(response, error);
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
    ensurePrivateSocket(socketFile);
    const listeningStats = lstatSync(socketFile);
    listeningIdentity = `${listeningStats.dev}:${listeningStats.ino}`;
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
        if (stats.isSocket() && `${stats.dev}:${stats.ino}` === listeningIdentity) rmSync(socketFile);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },
  };
}

function requestJson<T>(
  socketFile: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  requestPath: string,
  expectedStatus: number,
  bodyValue?: unknown,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const body = bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: socketFile,
        path: requestPath,
        method,
        agent: false,
        headers: {
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }),
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
              reject(
                new ControlRequestError(
                  code ?? 'unknown_error',
                  response.statusCode ?? 500,
                  details,
                ),
              );
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Daemon control request timed out after ${timeoutMs}ms.`));
    });
    request.once('error', reject);
    request.end(body);
  });
}

export function getDaemonStatus(socketFile: string): Promise<DaemonStatus> {
  return requestJson(socketFile, 'GET', '/status', 200);
}

export function getDaemonDiagnostics(socketFile: string): Promise<DiagnosticsReport> {
  return requestJson(
    socketFile,
    'GET',
    '/diagnostics',
    200,
    undefined,
    DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  );
}

export function requestDaemonRestart(
  socketFile: string,
): Promise<{ accepted: true; instanceId: string }> {
  return requestJson(socketFile, 'POST', '/restart', 202);
}

export function createOperation(
  socketFile: string,
  body: OperationRequest,
): Promise<{ operationId: string }> {
  return requestJson(socketFile, 'POST', '/operations', 202, body);
}

export function getOperation(socketFile: string, operationId: string): Promise<OperationRecord> {
  return requestJson(socketFile, 'GET', `/operations/${encodeURIComponent(operationId)}`, 200);
}

export function getConfiguration(socketFile: string): Promise<ControlConfiguration> {
  return requestJson(socketFile, 'GET', '/configuration', 200);
}

export function patchConfiguration(
  socketFile: string,
  expectedRevision: number,
  patch: SettingsPatch,
): Promise<ControlConfiguration> {
  return requestJson(socketFile, 'PATCH', '/configuration', 200, { expectedRevision, patch });
}

export function putSecret(
  socketFile: string,
  name: SecretName,
  value: string,
): Promise<ControlConfiguration> {
  return requestJson(socketFile, 'PUT', `/secrets/${encodeURIComponent(name)}`, 200, { value });
}

export function deleteSecret(
  socketFile: string,
  name: SecretName,
): Promise<ControlConfiguration> {
  return requestJson(socketFile, 'DELETE', `/secrets/${encodeURIComponent(name)}`, 200);
}

export function getLogHistory(
  socketFile: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<LogHistory> {
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
        { socketPath: socketFile, path: requestPath, method: 'GET', agent: false },
        (candidate) => {
          if (candidate.statusCode !== 200) {
            candidate.setEncoding('utf8');
            let body = '';
            candidate.on('data', (chunk: string) => (body += chunk));
            candidate.on('end', () => {
              try {
                const parsed = JSON.parse(body) as { error?: { code?: string; [key: string]: unknown } };
                const { code, ...details } = parsed.error ?? {};
                reject(
                  new ControlRequestError(
                    code ?? 'unknown_error',
                    candidate.statusCode ?? 500,
                    details,
                  ),
                );
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
