import { chmodSync, lstatSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { DaemonStatus } from './types.js';

export class DaemonAlreadyRunningError extends Error {
  constructor(socketFile: string) {
    super(`A skyd instance is already listening at ${socketFile}.`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export class ControlRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(`Control request failed with ${code}.`);
    this.name = 'ControlRequestError';
    this.code = code;
    this.statusCode = statusCode;
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

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  getStatus: () => DaemonStatus,
): void {
  if (request.url !== '/status') {
    writeJson(response, 404, { error: { code: 'not_found' } });
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    writeJson(response, 405, { error: { code: 'method_not_allowed' } });
    return;
  }
  writeJson(response, 200, getStatus());
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
): Promise<ControlServer> {
  await prepareSocket(socketFile);

  const server = http.createServer((request, response) => {
    try {
      handleRequest(request, response, getStatus);
    } catch {
      writeJson(response, 500, { error: { code: 'internal_error' } });
    }
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
      await closeHttpServer(server);
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

export function getDaemonStatus(socketFile: string): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: socketFile,
        path: '/status',
        method: 'GET',
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
            const parsed = JSON.parse(body) as DaemonStatus | { error?: { code?: string } };
            if (response.statusCode !== 200) {
              const code = 'error' in parsed ? parsed.error?.code : undefined;
              reject(new ControlRequestError(code ?? 'unknown_error', response.statusCode ?? 500));
              return;
            }
            resolve(parsed as DaemonStatus);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}
