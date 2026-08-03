import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SettingsPatch } from '../configuration.js';
import type { AdminAuthentication, AuthenticatedAdminSession } from './admin-auth.js';
import { ControlError, type DaemonControl } from './control.js';

export const DEFAULT_ADMIN_HOST = '0.0.0.0';
export const DEFAULT_ADMIN_PORT = 4815;

const MAX_REQUEST_BYTES = 64 * 1024;
const SESSION_COOKIE = 'sky_admin_session';
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

const LOGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sky Admin</title>
  </head>
  <body>
    <main>
      <h1>Sky Admin</h1>
      <form id="login-form">
        <label for="login-token">Login token</label>
        <input id="login-token" name="token" autocomplete="off" required>
        <button type="submit">Sign in</button>
      </form>
      <p id="login-status" role="status"></p>
    </main>
    <script src="/login.js"></script>
  </body>
</html>
`;

const LOGIN_SCRIPT = `const form = document.querySelector('#login-form');
const input = document.querySelector('#login-token');
const status = document.querySelector('#login-status');
const params = new URLSearchParams(window.location.hash.slice(1));
const fragmentToken = params.get('token');
if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);

async function exchangeToken(token) {
  status.textContent = 'Signing in…';
  const response = await fetch('/api/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  status.textContent = response.ok ? 'Signed in.' : 'The login token is invalid or expired.';
  if (response.ok) form.hidden = true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void exchangeToken(input.value);
});
if (fragmentToken) void exchangeToken(fragmentToken);
`;

export type AdminHttpServer = {
  host: string;
  port: number;
  close(): Promise<void>;
};

export type StartAdminHttpServerOptions = {
  host?: string;
  port?: number;
  control: DaemonControl;
  authentication: AdminAuthentication;
};

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  );
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cache-control', 'no-store');
}

function writeBody(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  writeBody(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(value));
}

function writeError(response: ServerResponse, statusCode: number, code: string): void {
  writeJson(response, statusCode, { error: { code } });
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader('allow', allow);
  writeError(response, 405, 'method_not_allowed');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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
    throw new ControlError('invalid_request');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const pair of request.headers.cookie?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

function authenticate(
  request: IncomingMessage,
  authentication: AdminAuthentication,
): AuthenticatedAdminSession | undefined {
  const sessionId = cookieValue(request, SESSION_COOKIE);
  return sessionId ? authentication.authenticate(sessionId) : undefined;
}

function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return typeof host === 'string' && typeof origin === 'string' && origin === `http://${host}`;
}

function equalSecret(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireMutationProtection(
  request: IncomingMessage,
  response: ServerResponse,
  session: AuthenticatedAdminSession,
): boolean {
  if (!sameOrigin(request)) {
    writeError(response, 403, 'origin_forbidden');
    return false;
  }
  const csrf = request.headers['x-sky-csrf-token'];
  if (typeof csrf !== 'string' || !equalSecret(csrf, session.csrfToken)) {
    writeError(response, 403, 'csrf_invalid');
    return false;
  }
  return true;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  control: DaemonControl,
  authentication: AdminAuthentication,
): Promise<void> {
  applySecurityHeaders(response);
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeBody(response, 200, 'text/html; charset=utf-8', LOGIN_HTML);
    return;
  }

  if (url.pathname === '/login.js') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeBody(response, 200, 'text/javascript; charset=utf-8', LOGIN_SCRIPT);
    return;
  }

  if (url.pathname === '/api/auth/exchange') {
    if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
    if (!sameOrigin(request)) {
      writeError(response, 403, 'origin_forbidden');
      return;
    }
    const body = await readJsonBody(request);
    const token = isRecord(body) && typeof body.token === 'string' ? body.token : '';
    const session = authentication.exchangeLoginToken(token);
    if (!session) {
      writeError(response, 401, 'login_token_invalid');
      return;
    }
    response.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${session.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
    writeJson(response, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    return;
  }

  const session = authenticate(request, authentication);
  if (!session) {
    writeError(response, 401, 'session_required');
    return;
  }

  if (url.pathname === '/api/auth/session') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeJson(response, 200, session);
    return;
  }

  if (url.pathname === '/api/status') {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    writeJson(response, 200, await control.execute({ type: 'status' }));
    return;
  }

  if (url.pathname === '/api/configuration') {
    if (request.method === 'GET') {
      writeJson(response, 200, await control.execute({ type: 'configuration.get' }));
      return;
    }
    if (request.method !== 'PATCH') return methodNotAllowed(response, 'GET, PATCH');
    if (!requireMutationProtection(request, response, session)) return;
    const body = await readJsonBody(request);
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

  writeError(response, 404, 'not_found');
}

function writeUnexpectedError(response: ServerResponse, error: unknown): void {
  if (error instanceof ControlError) {
    writeJson(response, error.statusCode, { error: { code: error.code, ...error.details } });
    return;
  }
  writeError(response, 500, 'internal_error');
}

export async function startAdminHttpServer(
  options: StartAdminHttpServerOptions,
): Promise<AdminHttpServer> {
  const host = options.host ?? DEFAULT_ADMIN_HOST;
  const port = options.port ?? DEFAULT_ADMIN_PORT;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options.control, options.authentication).catch((error) => {
      if (!response.headersSent) {
        applySecurityHeaders(response);
        writeUnexpectedError(response, error);
      } else {
        response.destroy();
      }
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
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeHttpServer(server);
    throw new Error('Admin gateway did not expose a TCP address.');
  }

  let closed = false;
  return {
    host,
    port: address.port,
    async close() {
      if (closed) return;
      closed = true;
      const closing = closeHttpServer(server);
      server.closeAllConnections();
      await closing;
    },
  };
}
