import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startSkyd } from '../dist/skyd/app.js';
import { getDaemonStatus, issueAdminLogin } from '../dist/skyd/control-uds.js';
import { REQUIRED_SLACK_BOT_SCOPES } from '../dist/connections.js';

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
          resolve({ statusCode: response.statusCode, headers: response.headers, body: responseBody }),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function authenticatedAdmin(daemon) {
  const daemonStatus = await getDaemonStatus(daemon.paths.socketFile);
  const origin = `http://127.0.0.1:${daemonStatus.admin.port}`;
  const login = await issueAdminLogin(daemon.paths.socketFile);
  const exchange = await tcpRequest(daemonStatus.admin.port, 'POST', '/api/auth/exchange', {
    body: { token: login.token },
    headers: { origin },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const session = JSON.parse(exchange.body);
  return {
    port: daemonStatus.admin.port,
    readHeaders: { cookie: exchange.headers['set-cookie'][0].split(';', 1)[0] },
    mutationHeaders: {
      cookie: exchange.headers['set-cookie'][0].split(';', 1)[0],
      origin,
      'x-sky-csrf-token': session.csrfToken,
    },
  };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
}

function timeoutResponse(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Timed out', 'AbortError')),
      { once: true },
    );
  });
}

test('admin connection flow keeps secrets write-only and normalizes external checks', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-connections-admin-'));
  const skyRoot = path.join(homeDir, '.sky');
  const workspace = path.join(skyRoot, 'workspace');
  const socketUrl = 'wss://socket-secret.example/link?ticket=must-never-escape';
  const secrets = {
    goodBot: 'xoxb-good-secret-1111',
    missingBot: 'xoxb-missing-secret-2222',
    invalidBot: 'xoxb-invalid-secret-3333',
    timeoutBot: 'xoxb-timeout-secret-4444',
    rateLimitedBot: 'xoxb-rate-secret-4445',
    app: 'xapp-good-secret-5555',
    claude: 'claude-good-secret-6666',
    invalidClaude: 'claude-invalid-secret-7777',
  };
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(skyRoot, 'settings.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'claude-agent-sdk',
      model: 'anthropic/claude-test',
      effort: 'high',
      workspace,
    })}\n`,
    { mode: 0o600 },
  );

  const seenAuthorization = [];
  const daemon = await startSkyd({
    homeDir,
    configurationEnv: {},
    admin: { host: '127.0.0.1', port: 0 },
    connections: {
      timeoutMs: 20,
      now: () => new Date('2026-08-03T01:02:03.000Z'),
      fetch: async (input, init) => {
        const token = String(init.headers.authorization).slice('Bearer '.length);
        seenAuthorization.push(token);
        if (token === secrets.timeoutBot) return timeoutResponse(init.signal);
        if (token === secrets.rateLimitedBot) {
          return jsonResponse(
            { ok: false, error: 'ratelimited' },
            { status: 429, headers: { 'retry-after': '30' } },
          );
        }
        if (token === secrets.invalidBot) {
          return jsonResponse({ ok: false, error: 'invalid_auth' });
        }
        if (String(input).endsWith('/apps.connections.open')) {
          return jsonResponse({ ok: true, url: socketUrl });
        }
        const granted =
          token === secrets.missingBot
            ? REQUIRED_SLACK_BOT_SCOPES.filter((scope) => scope !== 'files:write')
            : REQUIRED_SLACK_BOT_SCOPES;
        return jsonResponse(
          {
            ok: true,
            team: 'Sky Workspace',
            team_id: 'T123',
            user: 'sky-bot',
            user_id: 'U123',
            bot_id: 'B123',
          },
          { headers: { 'x-oauth-scopes': granted.join(',') } },
        );
      },
      claudeAccountInfo: async ({ token }) => {
        if (token === secrets.invalidClaude) throw new Error('authentication failed');
        return {
          email: 'sky@example.com',
          organization: 'Sky',
          subscriptionType: 'max',
          tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
          apiProvider: 'firstParty',
        };
      },
    },
  });

  try {
    const admin = await authenticatedAdmin(daemon);
    const responseBodies = [];
    const request = async (method, requestPath, options = {}) => {
      const response = await tcpRequest(admin.port, method, requestPath, options);
      responseBodies.push(response.body);
      return response;
    };
    const putSecret = async (name, value) => {
      const response = await request('PUT', `/api/secrets/${encodeURIComponent(name)}`, {
        headers: admin.mutationHeaders,
        body: { value },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body.includes(value), false);
      return JSON.parse(response.body);
    };
    const check = async (target) => {
      const response = await request('POST', '/api/connections/check', {
        headers: admin.mutationHeaders,
        body: { target },
      });
      assert.equal(response.statusCode, 200, response.body);
      return JSON.parse(response.body).checks[target];
    };

    const initial = await request('GET', '/api/configuration', { headers: admin.readHeaders });
    assert.equal(JSON.parse(initial.body).secrets['slack.botToken'].configured, false);
    assert.equal(JSON.parse(initial.body).restartRequired, false);

    const unprotectedSecret = await request('PUT', '/api/secrets/slack.botToken', {
      headers: admin.readHeaders,
      body: { value: secrets.goodBot },
    });
    assert.equal(unprotectedSecret.statusCode, 403);
    const unprotectedCheck = await request('POST', '/api/connections/check', {
      headers: admin.readHeaders,
      body: { target: 'slack.bot' },
    });
    assert.equal(unprotectedCheck.statusCode, 403);

    await putSecret('slack.botToken', secrets.goodBot);
    await putSecret('slack.appToken', secrets.app);
    const registered = await putSecret('claudeAgentSdk.oauthToken', secrets.claude);
    assert.equal(registered.complete, true);
    assert.equal(registered.restartRequired, true);
    assert.deepEqual(Object.keys(registered.secrets['slack.botToken']).toSorted(), [
      'configured',
      'displayHint',
      'source',
      'updatedAt',
    ]);

    const botSuccess = await check('slack.bot');
    assert.equal(botSuccess.status, 'ok');
    assert.deepEqual(botSuccess.details.workspace, { id: 'T123', name: 'Sky Workspace' });
    assert.deepEqual(botSuccess.details.missingScopes, []);

    const appSuccess = await check('slack.app');
    assert.equal(appSuccess.status, 'ok');
    assert.equal(JSON.stringify(appSuccess).includes(socketUrl), false);

    const claudeSuccess = await check('agent');
    assert.equal(claudeSuccess.status, 'ok');
    assert.equal(claudeSuccess.details.account.email, 'sky@example.com');

    await putSecret('slack.botToken', secrets.missingBot);
    const invalidated = await request('GET', '/api/connections', { headers: admin.readHeaders });
    assert.equal(JSON.parse(invalidated.body).checks['slack.bot'], null);
    const missingScope = await check('slack.bot');
    assert.equal(missingScope.status, 'missing_scope');
    assert.deepEqual(missingScope.details.missingScopes, ['files:write']);

    await putSecret('slack.botToken', secrets.invalidBot);
    assert.equal((await check('slack.bot')).status, 'invalid_credential');

    await putSecret('slack.botToken', secrets.timeoutBot);
    assert.equal((await check('slack.bot')).status, 'timeout');

    await putSecret('slack.botToken', secrets.rateLimitedBot);
    const rateLimited = await check('slack.bot');
    assert.equal(rateLimited.status, 'rate_limited');
    assert.equal(rateLimited.details.retryAfterSeconds, 30);

    await putSecret('claudeAgentSdk.oauthToken', secrets.invalidClaude);
    assert.equal((await check('agent')).status, 'invalid_credential');

    const deleted = await request('DELETE', '/api/secrets/slack.botToken', {
      headers: admin.mutationHeaders,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(JSON.parse(deleted.body).secrets['slack.botToken'].configured, false);
    assert.equal((await check('slack.bot')).status, 'not_configured');

    assert.ok(seenAuthorization.includes(secrets.goodBot));
    const combinedOutput = `${responseBodies.join('\n')}\n${await readFile(daemon.paths.logFile, 'utf8')}`;
    for (const value of [...Object.values(secrets), socketUrl]) {
      assert.equal(combinedOutput.includes(value), false, `sensitive value escaped: ${value}`);
    }
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('environment Claude token stays effective after stored replacement and deletion', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-connections-environment-'));
  const skyRoot = path.join(homeDir, '.sky');
  const workspace = path.join(skyRoot, 'workspace');
  const environmentToken = 'environment-claude-secret';
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(skyRoot, 'settings.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'claude-agent-sdk',
      model: 'anthropic/claude-test',
      workspace,
    })}\n`,
    { mode: 0o600 },
  );
  const daemon = await startSkyd({
    homeDir,
    configurationEnv: { CLAUDE_CODE_OAUTH_TOKEN: environmentToken },
    admin: { host: '127.0.0.1', port: 0 },
    connections: {
      claudeAccountInfo: async ({ token }) => {
        assert.equal(token, environmentToken);
        return { email: 'environment@example.com', apiProvider: 'firstParty' };
      },
    },
  });
  try {
    const admin = await authenticatedAdmin(daemon);
    const replace = await tcpRequest(
      admin.port,
      'PUT',
      '/api/secrets/claudeAgentSdk.oauthToken',
      { headers: admin.mutationHeaders, body: { value: 'stored-claude-secret' } },
    );
    const replaced = JSON.parse(replace.body).secrets['claudeAgentSdk.oauthToken'];
    assert.deepEqual(replaced, {
      configured: true,
      source: 'environment',
      updatedAt: null,
      displayHint: null,
    });

    const checked = await tcpRequest(admin.port, 'POST', '/api/connections/check', {
      headers: admin.mutationHeaders,
      body: { target: 'agent' },
    });
    assert.equal(JSON.parse(checked.body).checks.agent.status, 'ok');

    const deleted = await tcpRequest(
      admin.port,
      'DELETE',
      '/api/secrets/claudeAgentSdk.oauthToken',
      { headers: admin.mutationHeaders },
    );
    assert.deepEqual(JSON.parse(deleted.body).secrets['claudeAgentSdk.oauthToken'], replaced);
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
