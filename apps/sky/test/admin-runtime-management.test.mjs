import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createConversationManager } from '../dist/conversation/manager.js';
import { openConversationStore } from '../dist/conversation/store.js';
import { createRuntimeAdmin } from '../dist/runtime/admin.js';
import { startSkyd } from '../dist/skyd/app.js';
import { getDaemonStatus, issueAdminLogin } from '../dist/skyd/control-uds.js';

const AGENT = {
  name: 'main',
  systemPrompt: 'stored-system-prompt-must-not-leak',
  model: 'anthropic/test-model',
};

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
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          body: responseBody,
          headers: response.headers,
        }));
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function writeRuntimeConfiguration(homeDir) {
  const root = path.join(homeDir, '.sky');
  const workspace = path.join(root, 'workspace');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(root, 'settings.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      agentBackend: 'pi',
      model: AGENT.model,
      effort: 'high',
      workspace,
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, 'secrets.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      secrets: {
        'slack.botToken': {
          value: 'xoxb-runtime-management',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
        'slack.appToken': {
          value: 'xapp-runtime-management',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
}

async function waitForReady(daemon) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(daemon.paths.socketFile);
    if (status.runtime.state === 'ready') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('runtime did not become ready');
}

async function authenticate(daemon) {
  const status = await waitForReady(daemon);
  const origin = `http://127.0.0.1:${status.admin.port}`;
  const login = await issueAdminLogin(daemon.paths.socketFile);
  const exchange = await tcpRequest(status.admin.port, 'POST', '/api/auth/exchange', {
    headers: { origin },
    body: { token: login.token },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const session = JSON.parse(exchange.body);
  return {
    port: status.admin.port,
    headers: {
      cookie: exchange.headers['set-cookie'][0].split(';', 1)[0],
      origin,
      'x-sky-csrf-token': session.csrfToken,
    },
  };
}

function createSessionFactory() {
  let created = 0;
  let releaseBlocked;
  let resolveBlockedStart;
  const blockedStarted = new Promise((resolve) => {
    resolveBlockedStart = resolve;
  });

  const factory = Object.assign(
    async () => {
      created += 1;
      const sessionId = `backend-session-${created}`;
      const listeners = new Set();
      return {
        sessionId,
        resumeRef: `/private/${sessionId}.jsonl`,
        systemPrompt: AGENT.systemPrompt,
        async prompt(text) {
          if (text === 'block') {
            resolveBlockedStart();
            await new Promise((resolve) => {
              releaseBlocked = resolve;
            });
            return;
          }
          for (const listener of listeners) {
            listener({ type: 'assistant_message', text: `reply:${text}` });
            listener({ type: 'turn_end', text: `reply:${text}` });
          }
        },
        async abort() {
          releaseBlocked?.();
        },
        dispose() {},
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
    { backend: 'pi' },
  );

  return { factory, blockedStarted, created: () => created };
}

function createJob(store, id, nextRunAt, overrides = {}) {
  return store.create({
    id,
    title: id,
    kind: 'once',
    nextRunAt,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: `secret prompt for ${id}`,
    createdAt: 1,
    ...overrides,
  });
}

test('assembled admin HTTP resets an active real-SQLite session and the next turn creates a fresh backend session', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-sessions-'));
  await writeRuntimeConfiguration(homeDir);
  const sessions = createSessionFactory();
  let manager;
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: 0 },
    startRuntime: async (settings, _controller, skyHome, scheduledJobStore) => {
      const conversationStore = openConversationStore(skyHome);
      manager = createConversationManager({
        defaultCwd: settings.workspace,
        store: conversationStore,
        createSession: sessions.factory,
      });
      return {
        admin: createRuntimeAdmin(manager, scheduledJobStore),
        async close() {
          await manager.closeAll();
          conversationStore.close();
        },
      };
    },
  });

  try {
    const auth = await authenticate(daemon);
    const first = await manager.runTurn('D123:1777901000.000000', AGENT, 'first');
    assert.equal(first.kind, 'ok');
    assert.equal(first.handle.sessionId, 'backend-session-1');

    const active = manager.runTurn('D123:1777901000.000000', AGENT, 'block');
    await sessions.blockedStarted;

    const listed = await tcpRequest(auth.port, 'GET', '/api/sessions', {
      headers: { cookie: auth.headers.cookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(JSON.parse(listed.body).sessions.map((session) => ({
      threadKey: session.threadKey,
      backendSessionId: session.backendSessionId,
      backend: session.backend,
      model: session.model,
      agent: session.agent,
    })), [
      {
        threadKey: 'D123:1777901000.000000',
        backendSessionId: 'backend-session-1',
        backend: 'pi',
        model: AGENT.model,
        agent: 'main',
      },
    ]);
    assert.doesNotMatch(listed.body, /stored-system-prompt|\/private\/|reply:first/);

    const reset = await tcpRequest(
      auth.port,
      'DELETE',
      `/api/sessions/${encodeURIComponent('D123:1777901000.000000')}`,
      { headers: auth.headers },
    );
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(JSON.parse(reset.body), { reset: true });
    assert.deepEqual(await active, { kind: 'interrupted' });

    const database = new DatabaseSync(daemon.paths.databaseFile, { readOnly: true });
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
      0,
    );
    database.close();

    const repeated = await tcpRequest(
      auth.port,
      'DELETE',
      `/api/sessions/${encodeURIComponent('D123:1777901000.000000')}`,
      { headers: auth.headers },
    );
    assert.deepEqual(JSON.parse(repeated.body), { reset: false });

    const next = await manager.runTurn('D123:1777901000.000000', AGENT, 'next');
    assert.equal(next.kind, 'ok');
    assert.equal(next.handle.sessionId, 'backend-session-2');
    assert.equal(sessions.created(), 2);
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('assembled admin HTTP lists safe scheduler fields, enforces conflicts, and races cancellation against dispatch atomically', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-scheduler-'));
  await writeRuntimeConfiguration(homeDir);
  const sessions = createSessionFactory();
  let scheduledJobStore;
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: 0 },
    startRuntime: async (settings, _controller, skyHome, store) => {
      scheduledJobStore = store;
      const conversationStore = openConversationStore(skyHome);
      const manager = createConversationManager({
        defaultCwd: settings.workspace,
        store: conversationStore,
        createSession: sessions.factory,
      });
      return {
        admin: createRuntimeAdmin(manager, store),
        async close() {
          await manager.closeAll();
          conversationStore.close();
        },
      };
    },
  });

  try {
    const auth = await authenticate(daemon);
    createJob(scheduledJobStore, 'pending', 5_000);
    createJob(scheduledJobStore, 'running', 100);
    assert.deepEqual(scheduledJobStore.claimDue(100).map(({ id }) => id), ['running']);
    createJob(scheduledJobStore, 'done', 200);
    assert.deepEqual(scheduledJobStore.claimDue(200).map(({ id }) => id), ['done']);
    assert.equal(scheduledJobStore.markDone('done'), true);
    createJob(scheduledJobStore, 'failed', 300);
    assert.deepEqual(scheduledJobStore.claimDue(300).map(({ id }) => id), ['failed']);
    assert.equal(
      scheduledJobStore.recordFailure('failed', 'raw secret diagnostic', 300, 0),
      'failed',
    );

    const listed = await tcpRequest(auth.port, 'GET', '/api/scheduler/jobs', {
      headers: { cookie: auth.headers.cookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const jobs = JSON.parse(listed.body).jobs;
    assert.deepEqual(jobs.find(({ id }) => id === 'failed').errorSummary, 'The most recent run failed.');
    assert.doesNotMatch(listed.body, /secret prompt|raw secret diagnostic|"prompt"/);

    const cancelled = await tcpRequest(auth.port, 'DELETE', '/api/scheduler/jobs/pending', {
      headers: auth.headers,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(JSON.parse(cancelled.body), { cancelled: true });
    assert.equal(scheduledJobStore.get('pending').status, 'cancelled');

    for (const [id, status] of [['running', 'running'], ['done', 'done'], ['failed', 'failed']]) {
      const conflict = await tcpRequest(auth.port, 'DELETE', `/api/scheduler/jobs/${id}`, {
        headers: auth.headers,
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.deepEqual(JSON.parse(conflict.body), {
        error: { code: 'scheduled_job_status_conflict', status },
      });
    }

    const missing = await tcpRequest(auth.port, 'DELETE', '/api/scheduler/jobs/missing', {
      headers: auth.headers,
    });
    assert.equal(missing.statusCode, 404, missing.body);

    createJob(scheduledJobStore, 'race', 1_000);
    const cancelPromise = tcpRequest(auth.port, 'DELETE', '/api/scheduler/jobs/race', {
      headers: auth.headers,
    });
    const claimPromise = new Promise((resolve) => {
      setImmediate(() => resolve(scheduledJobStore.claimDue(1_000)));
    });
    const [raceCancel, claimed] = await Promise.all([cancelPromise, claimPromise]);
    const cancelWon = raceCancel.statusCode === 200;
    const dispatchWon = claimed.some(({ id }) => id === 'race');
    assert.notEqual(cancelWon, dispatchWon);
    assert.equal(
      scheduledJobStore.get('race').status,
      cancelWon ? 'cancelled' : 'running',
    );
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('runtime management endpoints return unavailable instead of persisted data before runtime readiness', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-admin-runtime-unavailable-'));
  const daemon = await startSkyd({
    homeDir,
    admin: { host: '127.0.0.1', port: 0 },
  });
  try {
    const deadline = Date.now() + 2_000;
    let status;
    while (Date.now() < deadline) {
      status = await getDaemonStatus(daemon.paths.socketFile);
      if (status.runtime.state === 'needs_configuration') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(status.runtime.state, 'needs_configuration');
    const origin = `http://127.0.0.1:${status.admin.port}`;
    const login = await issueAdminLogin(daemon.paths.socketFile);
    const exchange = await tcpRequest(status.admin.port, 'POST', '/api/auth/exchange', {
      headers: { origin },
      body: { token: login.token },
    });
    const cookie = exchange.headers['set-cookie'][0].split(';', 1)[0];

    for (const requestPath of ['/api/sessions', '/api/scheduler/jobs']) {
      const response = await tcpRequest(status.admin.port, 'GET', requestPath, {
        headers: { cookie },
      });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(JSON.parse(response.body), {
        error: { code: 'runtime_unavailable' },
      });
    }
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
