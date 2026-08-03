import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { openScheduledJobStore } from '../dist/scheduler/store.js';

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

function firstSseEvent(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: requestPath,
        headers: options.headers,
      },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          for (const block of body.split('\n\n')) {
            if (!block.includes('event: log')) continue;
            const id = block.match(/^id: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (!id || !data) continue;
            resolve({ statusCode: response.statusCode, headers: response.headers, id, data });
            request.destroy();
            return;
          }
        });
        response.on('end', () => reject(new Error(`SSE ended before a log event: ${body}`)));
      },
    );
    request.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.end();
  });
}

test('admin login exchanges a UDS-issued token for an authenticated TCP session', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-gateway-'));
  const daemon = await startSkyd({
    homeDir,
    productVersion: 'admin-test',
    admin: { host: '127.0.0.1', port: 0 },
    inspectLaunchAgent: async () => ({
      label: 'com.ty91.skyd',
      plistFile: '/Users/test/Library/LaunchAgents/com.ty91.skyd.plist',
      installed: true,
      loaded: true,
      autostart: true,
      state: 'running',
      pid: process.pid,
      lastExitStatus: 0,
    }),
  });
  try {
    const scheduler = openScheduledJobStore(daemon.paths);
    scheduler.create({
      id: 'admin-overview-job',
      title: 'Admin overview job',
      kind: 'once',
      nextRunAt: Date.parse('2026-08-04T02:00:00.000Z'),
      timezone: 'Asia/Seoul',
      targetChannel: 'D123',
      threadStrategy: 'new-root',
      deliveryMode: 'agent',
      prompt: 'Run from the scheduler.',
      createdAt: Date.parse('2026-08-03T00:00:00.000Z'),
    });
    scheduler.close();

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
    const assetPath = shell.body.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(assetPath, shell.body);

    const asset = await tcpRequest(daemonStatus.admin.port, 'GET', assetPath);
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'], /^text\/javascript/);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const spaFallback = await tcpRequest(daemonStatus.admin.port, 'GET', '/connections');
    assert.equal(spaFallback.statusCode, 200);
    assert.equal(spaFallback.body, shell.body);

    const missingApi = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/not-real');
    assert.equal(missingApi.statusCode, 401);

    const anonymous = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/status');
    assert.equal(anonymous.statusCode, 401);
    const anonymousOverview = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/overview');
    assert.equal(anonymousOverview.statusCode, 401);

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

    const overviewResponse = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/overview', {
      headers: { cookie },
    });
    assert.equal(overviewResponse.statusCode, 200, overviewResponse.body);
    const overview = JSON.parse(overviewResponse.body);
    assert.equal(overview.schemaVersion, 1);
    assert.equal(overview.host.hostname, os.hostname());
    assert.equal(overview.host.platform, process.platform);
    assert.equal(overview.host.architecture, process.arch);
    assert.equal(overview.daemon.instanceId, daemonStatus.instanceId);
    assert.equal(overview.diagnostics.overall, 'fail');
    assert.ok(overview.diagnostics.checks.some(({ id }) => id === 'workspace.path'));
    assert.deepEqual(overview.scheduler, {
      total: 1,
      pending: 1,
      running: 0,
      failed: 0,
      nextRunAt: '2026-08-04T02:00:00.000Z',
    });

    const systemResponse = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/system', {
      headers: { cookie },
    });
    assert.equal(systemResponse.statusCode, 200, systemResponse.body);
    const system = JSON.parse(systemResponse.body);
    assert.equal(system.schemaVersion, 1);
    assert.equal(system.daemon.productVersion, 'admin-test');
    assert.deepEqual(
      {
        installed: system.launchAgent.installed,
        loaded: system.launchAgent.loaded,
        autostart: system.launchAgent.autostart,
      },
      { installed: true, loaded: true, autostart: true },
    );
    assert.deepEqual(system.capabilities, {
      update: 'unsupported',
      rollback: 'unsupported',
    });

    const logHistoryResponse = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/logs?limit=100',
      { headers: { cookie } },
    );
    assert.equal(logHistoryResponse.statusCode, 200, logHistoryResponse.body);
    const logHistory = JSON.parse(logHistoryResponse.body);
    assert.ok(logHistory.records.length >= 2);
    const firstCursor = logHistory.records[0].cursor;
    const nextHistoryResponse = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      `/api/logs?cursor=${encodeURIComponent(firstCursor)}&limit=100`,
      { headers: { cookie } },
    );
    const nextHistory = JSON.parse(nextHistoryResponse.body);
    assert.equal(nextHistoryResponse.statusCode, 200, nextHistoryResponse.body);
    assert.deepEqual(nextHistory.records, logHistory.records.slice(1));

    const streamEvent = await firstSseEvent(daemonStatus.admin.port, '/api/logs/stream', {
      headers: { cookie, 'last-event-id': firstCursor },
    });
    assert.equal(streamEvent.statusCode, 200);
    assert.match(streamEvent.headers['content-type'], /^text\/event-stream/);
    assert.equal(streamEvent.id, logHistory.records[1].cursor);
    assert.equal(JSON.parse(streamEvent.data).cursor, streamEvent.id);

    const expiredCursor = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/logs?cursor=rotated-away&limit=100',
      { headers: { cookie } },
    );
    assert.equal(expiredCursor.statusCode, 410, expiredCursor.body);
    assert.deepEqual(JSON.parse(expiredCursor.body), { error: { code: 'log_cursor_expired' } });
    const expiredStreamCursor = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/logs/stream?cursor=rotated-away',
      { headers: { cookie } },
    );
    assert.equal(expiredStreamCursor.statusCode, 410, expiredStreamCursor.body);

    const authenticatedMissingApi = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/not-real',
      { headers: { cookie } },
    );
    assert.equal(authenticatedMissingApi.statusCode, 404);
    assert.deepEqual(JSON.parse(authenticatedMissingApi.body), { error: { code: 'not_found' } });

    const configuration = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/configuration',
      { headers: { cookie } },
    );
    assert.equal(configuration.statusCode, 200, configuration.body);
    assert.equal(JSON.parse(configuration.body).revision, 0);

    const emptyPromptsResponse = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/prompts',
      { headers: { cookie } },
    );
    assert.equal(emptyPromptsResponse.statusCode, 200, emptyPromptsResponse.body);
    assert.equal(emptyPromptsResponse.headers['cache-control'], 'no-store');
    const emptyPrompts = JSON.parse(emptyPromptsResponse.body);
    assert.equal(emptyPrompts.maxContentBytes, 256 * 1024);
    assert.deepEqual(
      emptyPrompts.prompts.map(({ role, status }) => [role, status]),
      [
        ['soul', 'missing'],
        ['agents', 'missing'],
        ['user', 'missing'],
        ['memory', 'missing'],
      ],
    );

    const linkedPrompt = path.join(daemon.paths.workspaceDir, 'shared-agents.md');
    await writeFile(path.join(daemon.paths.workspaceDir, 'SOUL.md'), '# Soul\n', 'utf8');
    await writeFile(linkedPrompt, '# Shared agents\n', 'utf8');
    await symlink(linkedPrompt, path.join(daemon.paths.workspaceDir, 'AGENTS.md'));
    await symlink(
      path.join(daemon.paths.workspaceDir, 'missing-user.md'),
      path.join(daemon.paths.workspaceDir, 'USER.md'),
    );
    await writeFile(
      path.join(daemon.paths.workspaceDir, 'MEMORY.md'),
      Buffer.alloc(256 * 1024 + 1, 'm'),
    );

    const promptsResponse = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/prompts',
      { headers: { cookie } },
    );
    assert.equal(promptsResponse.statusCode, 200, promptsResponse.body);
    const prompts = JSON.parse(promptsResponse.body).prompts;
    assert.deepEqual(
      prompts.map(({ role, status }) => [role, status]),
      [
        ['soul', 'available'],
        ['agents', 'available'],
        ['user', 'broken_symlink'],
        ['memory', 'too_large'],
      ],
    );
    assert.equal(prompts[0].content, '# Soul\n');
    assert.equal(prompts[0].target.sizeBytes, Buffer.byteLength('# Soul\n'));
    assert.match(prompts[0].target.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(prompts[1].entry.type, 'symlink');
    assert.equal(prompts[1].target.state, 'file');
    assert.equal(prompts[1].content, '# Shared agents\n');
    assert.equal(prompts[2].entry.exists, true);
    assert.equal(prompts[2].entry.type, 'symlink');
    assert.equal(prompts[2].target.state, 'missing');
    assert.equal(prompts[2].content, null);
    assert.equal(prompts[3].target.sizeBytes, 256 * 1024 + 1);
    assert.equal(prompts[3].content, null);

    const promptQuery = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/prompts?path=/etc/passwd',
      { headers: { cookie } },
    );
    assert.equal(promptQuery.statusCode, 400);
    const promptPath = await tcpRequest(
      daemonStatus.admin.port,
      'GET',
      '/api/prompts/SOUL.md',
      { headers: { cookie } },
    );
    assert.equal(promptPath.statusCode, 404);

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

test('authenticated configuration flow reports conflicts and keeps runtime changes behind restart', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-configuration-'));
  const skyRoot = path.join(homeDir, '.sky');
  const workspace = path.join(skyRoot, 'workspace');
  await mkdir(skyRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(skyRoot, 'settings.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'pi',
      model: 'anthropic/active-model',
      effort: 'high',
      workspace,
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(skyRoot, 'secrets.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      secrets: {
        'slack.botToken': {
          value: 'xoxb-admin-test',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
        'slack.appToken': {
          value: 'xapp-admin-test',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
      },
    })}\n`,
    { mode: 0o600 },
  );

  const daemon = await startSkyd({
    homeDir,
    supervisionMode: 'launchd',
    admin: { host: '127.0.0.1', port: 0 },
    startRuntime: async () => ({ close: async () => {} }),
  });
  try {
    const daemonStatus = await getDaemonStatus(daemon.paths.socketFile);
    const origin = `http://127.0.0.1:${daemonStatus.admin.port}`;
    const login = await issueAdminLogin(daemon.paths.socketFile);
    const exchange = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/auth/exchange', {
      body: { token: login.token },
      headers: { origin },
    });
    const session = JSON.parse(exchange.body);
    const cookie = exchange.headers['set-cookie'][0].split(';', 1)[0];
    const mutationHeaders = {
      cookie,
      origin,
      'x-sky-csrf-token': session.csrfToken,
    };

    const active = await tcpRequest(daemonStatus.admin.port, 'GET', '/api/configuration', {
      headers: { cookie },
    });
    assert.deepEqual(
      {
        revision: JSON.parse(active.body).revision,
        activeRevision: JSON.parse(active.body).activeRevision,
        restartRequired: JSON.parse(active.body).restartRequired,
      },
      { revision: 1, activeRevision: 1, restartRequired: false },
    );

    const saved = await tcpRequest(daemonStatus.admin.port, 'PATCH', '/api/configuration', {
      headers: mutationHeaders,
      body: {
        expectedRevision: 1,
        patch: { model: 'anthropic/saved-model' },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(
      {
        revision: JSON.parse(saved.body).revision,
        activeRevision: JSON.parse(saved.body).activeRevision,
        restartRequired: JSON.parse(saved.body).restartRequired,
        model: JSON.parse(saved.body).settings.model,
      },
      {
        revision: 2,
        activeRevision: 1,
        restartRequired: true,
        model: 'anthropic/saved-model',
      },
    );
    assert.equal((await getDaemonStatus(daemon.paths.socketFile)).agent.model, 'anthropic/active-model');

    const conflict = await tcpRequest(daemonStatus.admin.port, 'PATCH', '/api/configuration', {
      headers: mutationHeaders,
      body: {
        expectedRevision: 1,
        patch: { model: 'anthropic/stale-model' },
      },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    const conflictBody = JSON.parse(conflict.body);
    assert.equal(conflictBody.error.code, 'revision_conflict');
    assert.equal(conflictBody.error.current.revision, 2);
    assert.equal(conflictBody.error.current.settings.model, 'anthropic/saved-model');
    assert.equal(conflictBody.error.current.restartRequired, true);

    const invalidClaude = await tcpRequest(
      daemonStatus.admin.port,
      'PATCH',
      '/api/configuration',
      {
        headers: mutationHeaders,
        body: {
          expectedRevision: 2,
          patch: { agentBackend: 'claude-agent-sdk', model: 'openai/not-allowed' },
        },
      },
    );
    assert.equal(invalidClaude.statusCode, 400, invalidClaude.body);
    assert.equal(JSON.parse(invalidClaude.body).error.code, 'invalid_value');

    const restart = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/restart', {
      headers: mutationHeaders,
    });
    assert.equal(restart.statusCode, 202, restart.body);
    assert.equal(JSON.parse(restart.body).accepted, true);
    await daemon.finished;
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
