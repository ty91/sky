import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startSkyd } from '../dist/skyd/app.js';
import {
  ControlRequestError,
  getDaemonStatus,
  issueAdminLogin,
} from '../dist/skyd/control-uds.js';

function tcpRequest(port, method, requestPath, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }),
          ...options.headers,
        },
      },
      (response) => {
        response.setEncoding('utf8');
        let responseBody = '';
        response.on('data', (chunk) => (responseBody += chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: responseBody,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

test('admin login exchanges a UDS-issued token for an authenticated TCP session', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-gateway-'));
  const daemon = await startSkyd({
    homeDir,
    productVersion: 'admin-test',
    admin: { host: '127.0.0.1', port: 0 },
  });
  try {
    const daemonStatus = await getDaemonStatus(daemon.paths.socketFile);
    assert.equal(daemonStatus.admin.state, 'listening');
    assert.equal(daemonStatus.admin.host, '127.0.0.1');
    assert.ok(daemonStatus.admin.port > 0);

    const shell = await tcpRequest(daemonStatus.admin.port, 'GET', '/');
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /Sky Admin/);
    assert.equal(shell.headers['cache-control'], 'no-store');
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    assert.equal(shell.headers['x-content-type-options'], 'nosniff');
    assert.equal(shell.headers['referrer-policy'], 'no-referrer');
    assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(shell.headers['access-control-allow-origin'], undefined);

    const anonymous = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/status');
    assert.equal(anonymous.statusCode, 401);

    const login = await issueAdminLogin(daemon.paths.socketFile);
    assert.match(login.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(login.port, daemonStatus.admin.port);

    const exchange = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/auth/exchange', {
      body: { token: login.token },
      headers: { origin: `http://127.0.0.1:${daemonStatus.admin.port}` },
    });
    assert.equal(exchange.statusCode, 200, exchange.body);
    const session = JSON.parse(exchange.body);
    assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const setCookie = exchange.headers['set-cookie']?.[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
    const cookie = setCookie?.split(';', 1)[0];
    assert.ok(cookie?.startsWith('sky_admin_session='));
    const sessionId = cookie.slice('sky_admin_session='.length);
    assert.doesNotMatch(exchange.body, new RegExp(`${login.token}|${sessionId}`));

    const reused = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/auth/exchange', {
      body: { token: login.token },
      headers: { origin: `http://127.0.0.1:${daemonStatus.admin.port}` },
    });
    assert.equal(reused.statusCode, 401);
    assert.doesNotMatch(reused.body, new RegExp(login.token));

    const wrong = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/auth/exchange', {
      body: { token: 'A'.repeat(43) },
      headers: { origin: `http://127.0.0.1:${daemonStatus.admin.port}` },
    });
    assert.equal(wrong.statusCode, 401);

    const authenticated = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/status', {
      headers: { cookie },
    });
    assert.equal(authenticated.statusCode, 200, authenticated.body);
    assert.equal(JSON.parse(authenticated.body).instanceId, daemonStatus.instanceId);

    const configuration = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/configuration',
      { headers: { cookie } },
    );
    assert.equal(configuration.statusCode, 200, configuration.body);
    assert.equal(JSON.parse(configuration.body).revision, 0);

    const patchBody = {
      expectedRevision: 0,
      patch: { model: 'anthropic/admin-test' },
    };
    const sessionlessMutation = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      { body: patchBody },
    );
    assert.equal(sessionlessMutation.statusCode, 401);

    const missingOrigin = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      { body: patchBody, headers: { cookie, 'x-sky-csrf-token': session.csrfToken } },
    );
    assert.equal(missingOrigin.statusCode, 403);
    assert.deepEqual(JSON.parse(missingOrigin.body), { error: { code: 'origin_forbidden' } });

    const missingCsrf = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      {
        body: patchBody,
        headers: { cookie, origin: `http://127.0.0.1:${daemonStatus.admin.port}` },
      },
    );
    assert.equal(missingCsrf.statusCode, 403);
    assert.deepEqual(JSON.parse(missingCsrf.body), { error: { code: 'csrf_invalid' } });

    const wrongOrigin = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      {
        body: patchBody,
        headers: {
          cookie,
          origin: 'http://attacker.invalid',
          'x-sky-csrf-token': session.csrfToken,
        },
      },
    );
    assert.equal(wrongOrigin.statusCode, 403);

    const mutation = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      {
        body: patchBody,
        headers: {
          cookie,
          origin: `http://127.0.0.1:${daemonStatus.admin.port}`,
          'x-sky-csrf-token': session.csrfToken,
        },
      },
    );
    assert.equal(mutation.statusCode, 200, mutation.body);
    assert.equal(JSON.parse(mutation.body).revision, 1);

    const logs = await readFile(daemon.paths.logFile, 'utf8');
    assert.doesNotMatch(logs, new RegExp(`${login.token}|${sessionId}|${session.csrfToken}`));
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('admin login tokens and sessions expire against the daemon clock', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-expiry-'));
  let now = new Date('2026-08-03T00:00:00.000Z');
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: 0, now: () => now },
  });
  try {
    const port = (await getDaemonStatus(daemon.paths.socketFile)).admin.port;
    const origin = `http://127.0.0.1:${port}`;
    const expiring = await issueAdminLogin(daemon.paths.socketFile);
    now = new Date('2026-08-03T00:05:00.000Z');
    const expiredExchange = await tcpRequest(port, 'POST', '/api/auth/exchange', {
      body: { token: expiring.token },
      headers: { origin },
    });
    assert.equal(expiredExchange.statusCode, 401);

    const fresh = await issueAdminLogin(daemon.paths.socketFile);
    const exchange = await tcpRequest(port, 'POST', '/api/auth/exchange', {
      body: { token: fresh.token },
      headers: { origin },
    });
    assert.equal(exchange.statusCode, 200, exchange.body);
    const cookie = exchange.headers['set-cookie'][0].split(';', 1)[0];
    now = new Date('2026-08-04T00:05:00.000Z');
    const expiredSession = await tcpRequest(port, 'GET', '/api/status', {
      headers: { cookie },
    });
    assert.equal(expiredSession.statusCode, 401);
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('admin bind failure is reported without stopping UDS or the runtime', async () => {
  const blocker = http.createServer((_request, response) => response.end());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-bind-failure-'));
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: address.port },
  });
  try {
    const status = await getDaemonStatus(daemon.paths.socketFile);
    assert.equal(status.runtime.state, 'needs_configuration');
    assert.deepEqual(status.admin, {
      state: 'failed',
      host: '127.0.0.1',
      port: address.port,
      error: { code: 'admin_bind_failed' },
    });
    assert.ok(status.recentErrors.some(({ code }) => code === 'admin_bind_failed'));
    await assert.rejects(
      issueAdminLogin(daemon.paths.socketFile),
      (error) =>
        error instanceof ControlRequestError &&
        error.code === 'admin_unavailable' &&
        error.statusCode === 503,
    );
    const records = (await readFile(daemon.paths.logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      records.some(
        (record) =>
          record.level === 'error' &&
          record.scope === 'admin' &&
          record.message.includes('admin_bind_failed'),
      ),
    );
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
  }
});
