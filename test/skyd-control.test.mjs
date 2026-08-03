import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SlackStartupError } from '../dist/bot.js';
import { startSkyd } from './helpers/start-skyd.mjs';
import { ControlError } from '../dist/skyd/control.js';
import {
  ControlRequestError,
  DaemonAlreadyRunningError,
  getDaemonStatus,
  createOperation,
  getLogHistory,
  getOperation,
  requestDaemonRestart,
  streamLogRecords,
  watchOperation,
} from '../dist/skyd/control-uds.js';
import { createJsonlLogger } from '../dist/skyd/logger.js';

function permissions(stats) {
  return stats.mode & 0o777;
}

async function withTempHome(run) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'skyd-test-'));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeValidSettings(homeDir) {
  const settingsFile = path.join(homeDir, '.sky', 'settings.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify({
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
      model: 'anthropic/test-model',
      agentBackend: 'pi',
    }),
    { mode: 0o600 },
  );
}

async function waitForStatus(socketFile, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastStatus = await getDaemonStatus(socketFile);
      if (predicate(lastStatus)) return lastStatus;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    `status did not reach expected state: ${JSON.stringify(lastStatus)} ${lastError?.message ?? ''}`,
  );
}

function rawControlRequest(socketFile, method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: socketFile, method, path: requestPath },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ statusCode: response.statusCode, body }));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function leaveStaleSocket(socketFile) {
  const script = [
    "const net = require('node:net');",
    'const server = net.createServer();',
    "server.listen(process.argv[1], () => process.stdout.write('ready\\n'));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const child = spawn(process.execPath, ['-e', script, socketFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let output = '';
    for await (const chunk of child.stdout) {
      output += chunk;
      if (output.includes('ready')) break;
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('GET /status stays available without settings and exposes stable control errors', async () => {
  await withTempHome(async (homeDir) => {
    const daemon = await startSkyd({ homeDir, productVersion: 'test-version' });
    try {
      const status = await waitForStatus(
        daemon.paths.socketFile,
        (candidate) => candidate.runtime.state === 'needs_configuration',
      );

      assert.equal(status.productVersion, 'test-version');
      assert.equal(status.process.pid, process.pid);
      assert.equal(status.process.state, 'running');
      assert.equal(status.slack.state, 'not_configured');
      assert.deepEqual(status.agent, { backend: null, model: null });
      assert.equal(status.activeWorkCount, 0);
      assert.deepEqual(status.recentErrors.map(({ code }) => code), ['settings_missing']);
      assert.ok(status.instanceId);
      assert.ok(status.process.uptimeMs >= 0);

      const directStatus = await daemon.control.execute({ type: 'status' });
      assert.equal(directStatus.instanceId, status.instanceId);
      await assert.rejects(
        daemon.control.execute({ type: 'logs.history', limit: 0 }),
        (error) =>
          error instanceof ControlError &&
          error.code === 'invalid_limit' &&
          error.statusCode === 400,
      );
      const directLogs = daemon.control.subscribe({ type: 'logs.stream' })[Symbol.asyncIterator]();
      const directLog = await directLogs.next();
      await directLogs.return();
      assert.equal(directLog.done, false);
      assert.ok(directLog.value.cursor);

      const missing = await rawControlRequest(daemon.paths.socketFile, 'GET', '/missing');
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(JSON.parse(missing.body), { error: { code: 'not_found' } });

      assert.equal(permissions(await lstat(daemon.paths.rootDir)), 0o700);
      assert.equal(permissions(await lstat(daemon.paths.runDir)), 0o700);
      assert.equal(permissions(await lstat(daemon.paths.logsDir)), 0o700);
      assert.equal(permissions(await lstat(daemon.paths.socketFile)), 0o600);
      assert.equal(permissions(await lstat(daemon.paths.logFile)), 0o600);
    } finally {
      await daemon.close();
    }

    await assert.rejects(lstat(daemon.paths.socketFile), { code: 'ENOENT' });
  });
});

test('POST /restart drains active work over UDS before a supervised replacement starts', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    let lease;
    let runtimeClosed = false;
    const oldDaemon = await startSkyd({
      homeDir,
      supervisionMode: 'launchd',
      startRuntime: async (_settings, runtimeController) => {
        lease = runtimeController.lease('slack_turn');
        return {
          close: async () => {
            runtimeClosed = true;
          },
        };
      },
    });

    const oldStatus = await waitForStatus(
      oldDaemon.paths.socketFile,
      (status) => status.runtime.state === 'ready',
    );
    const accepted = await requestDaemonRestart(oldDaemon.paths.socketFile);
    assert.deepEqual(accepted, { accepted: true, instanceId: oldStatus.instanceId });

    const draining = await getDaemonStatus(oldDaemon.paths.socketFile);
    assert.equal(draining.runtime.state, 'draining');
    assert.equal(draining.activeWorkCount, 1);
    assert.equal(runtimeClosed, false);

    lease.release();
    await oldDaemon.finished;
    assert.equal(runtimeClosed, true);
    await assert.rejects(lstat(oldDaemon.paths.socketFile), { code: 'ENOENT' });

    const replacement = await startSkyd({
      homeDir,
      supervisionMode: 'launchd',
      startRuntime: async () => ({ close: async () => {} }),
    });
    try {
      const replacementStatus = await waitForStatus(
        replacement.paths.socketFile,
        (status) => status.runtime.state === 'ready',
      );
      assert.notEqual(replacementStatus.instanceId, oldStatus.instanceId);
    } finally {
      await replacement.close();
    }
  });
});

test('restart validates disk settings and rejects foreground without disturbing the runtime', async () => {
  await withTempHome(async (homeDir) => {
    const invalid = await startSkyd({ homeDir, supervisionMode: 'launchd' });
    try {
      await waitForStatus(
        invalid.paths.socketFile,
        (status) => status.runtime.state === 'needs_configuration',
      );
      await assert.rejects(
        requestDaemonRestart(invalid.paths.socketFile),
        (error) => error instanceof ControlRequestError && error.code === 'settings_missing',
      );
      assert.equal((await getDaemonStatus(invalid.paths.socketFile)).process.state, 'running');
    } finally {
      await invalid.close();
    }

    await writeValidSettings(homeDir);
    const foreground = await startSkyd({
      homeDir,
      supervisionMode: 'foreground',
      startRuntime: async () => ({ close: async () => {} }),
    });
    try {
      await waitForStatus(
        foreground.paths.socketFile,
        (status) => status.runtime.state === 'ready',
      );
      await assert.rejects(
        requestDaemonRestart(foreground.paths.socketFile),
        (error) =>
          error instanceof ControlRequestError && error.code === 'restart_unsupported_foreground',
      );
      assert.equal((await getDaemonStatus(foreground.paths.socketFile)).runtime.state, 'ready');
    } finally {
      await foreground.close();
    }
  });
});

test('stop aborts remaining activity after its bounded drain deadline', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    let runtimeClosed = false;
    const daemon = await startSkyd({
      homeDir,
      stopDrainTimeoutMs: 10,
      startRuntime: async (_settings, runtimeController) => {
        const lease = runtimeController.lease('maintenance');
        return {
          close: async () => {
            runtimeClosed = true;
            lease.release();
          },
        };
      },
    });
    await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
    await daemon.close();
    assert.equal(runtimeClosed, true);
    const logs = await readFile(daemon.paths.logFile, 'utf8');
    assert.match(logs, /Drain deadline exceeded/);
  });
});

test('the skyd entrypoint stays foreground with invalid settings and shuts down cleanly', async () => {
  await withTempHome(async (homeDir) => {
    const skyDir = path.join(homeDir, '.sky');
    const settingsFile = path.join(skyDir, 'settings.json');
    const socketFile = path.join(skyDir, 'run', 'skyd.sock');
    await mkdir(skyDir, { recursive: true });
    await writeFile(settingsFile, '{ invalid json', { mode: 0o644 });

    const entrypoint = fileURLToPath(new URL('../dist/skyd.js', import.meta.url));
    const child = spawn(process.execPath, [entrypoint, '--foreground'], {
      env: { ...process.env, HOME: homeDir },
      stdio: 'ignore',
    });

    try {
      const status = await waitForStatus(
        socketFile,
        (candidate) => candidate.runtime.state === 'needs_configuration',
      );
      assert.deepEqual(status.recentErrors.map(({ code }) => code), ['settings_invalid']);
      assert.equal(permissions(await lstat(settingsFile)), 0o600);

      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(exited, false);

      child.kill('SIGTERM');
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.equal(signal, null);
      await assert.rejects(lstat(socketFile), { code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});

test('Slack startup failures degrade, redact credentials, and recover through retry', async () => {
  await withTempHome(async (homeDir) => {
    const skyDir = path.join(homeDir, '.sky');
    const settingsFile = path.join(skyDir, 'settings.json');
    await mkdir(skyDir, { recursive: true });
    await writeFile(
      settingsFile,
      JSON.stringify({
        slack: { botToken: 'xoxb-super-secret', appToken: 'xapp-super-secret' },
        model: 'anthropic/test-model',
        agentBackend: 'claude-agent-sdk',
        claudeAgentSdk: { oauthToken: 'arbitrary-oauth-secret' },
      }),
      { mode: 0o644 },
    );

    let starts = 0;
    let runtimeClosed = false;
    const daemon = await startSkyd({
      homeDir,
      backoff: { baseMs: 30, maxMs: 30, jitterRatio: 0 },
      startRuntime: async (settings) => {
        starts += 1;
        if (starts <= 2) {
          throw new SlackStartupError(
            new Error(
              `tokens: ${settings.slack.botToken} ${settings.slack.appToken} ${settings.claudeAgentSdk.oauthToken}`,
            ),
          );
        }
        return {
          activeWorkCount: () => 2,
          close: async () => {
            runtimeClosed = true;
          },
        };
      },
    });

    try {
      const degraded = await waitForStatus(
        daemon.paths.socketFile,
        (status) => status.runtime.state === 'degraded' && status.slack.attempts >= 1,
      );
      assert.equal(degraded.slack.state, 'retrying');
      assert.ok(degraded.slack.nextRetryAt);

      const ready = await waitForStatus(
        daemon.paths.socketFile,
        (status) => status.runtime.state === 'ready',
      );
      assert.equal(starts, 3);
      assert.equal(ready.slack.state, 'connected');
      assert.deepEqual(ready.agent, {
        backend: 'claude-agent-sdk',
        model: 'anthropic/test-model',
      });
      assert.equal(ready.activeWorkCount, 0);
      assert.deepEqual(
        ready.recentErrors.map(({ code }) => code),
        ['slack_startup_failed', 'slack_startup_failed'],
      );
      assert.equal(permissions(await lstat(settingsFile)), 0o600);

      const logs = await readFile(daemon.paths.logFile, 'utf8');
      assert.doesNotMatch(logs, /super-secret|arbitrary-oauth-secret/);
      assert.match(logs, /\[REDACTED\]/);
    } finally {
      await daemon.close();
    }
    assert.equal(runtimeClosed, true);
  });
});

test('a live socket rejects a second daemon while a probed stale socket is recovered', async () => {
  await withTempHome(async (homeDir) => {
    const first = await startSkyd({ homeDir });
    try {
      await assert.rejects(
        startSkyd({ homeDir }),
        (error) => error instanceof DaemonAlreadyRunningError,
      );
    } finally {
      await first.close();
    }

    await mkdir(path.dirname(first.paths.socketFile), { recursive: true });
    await leaveStaleSocket(first.paths.socketFile);
    assert.equal((await lstat(first.paths.socketFile)).isSocket(), true);

    const recovered = await startSkyd({ homeDir });
    try {
      const status = await getDaemonStatus(recovered.paths.socketFile);
      assert.equal(status.process.state, 'running');
    } finally {
      await recovered.close();
    }
  });
});

test('a symlink settings file is not modified and leaves the daemon controllable', async () => {
  await withTempHome(async (homeDir) => {
    const skyDir = path.join(homeDir, '.sky');
    const target = path.join(homeDir, 'settings-target.json');
    const settingsFile = path.join(skyDir, 'settings.json');
    await mkdir(skyDir, { recursive: true });
    await writeFile(target, '{}', { mode: 0o644 });
    await chmod(target, 0o644);
    await symlink(target, settingsFile);

    const daemon = await startSkyd({ homeDir });
    try {
      const status = await waitForStatus(
        daemon.paths.socketFile,
        (candidate) => candidate.runtime.state === 'needs_configuration',
      );
      assert.deepEqual(status.recentErrors.map(({ code }) => code), ['settings_unsafe']);
      assert.equal(permissions(await lstat(target)), 0o644);
      assert.equal((await lstat(settingsFile)).isSymbolicLink(), true);
    } finally {
      await daemon.close();
    }
  });
});

// Direct file verification is intentional: rotation and permissions are
// load-bearing operational invariants whose failures are otherwise difficult
// to diagnose through GET /status.
test('structured logs rotate with bounded archives and redact secret-shaped values', async () => {
  await withTempHome(async (homeDir) => {
    const logFile = path.join(homeDir, 'skyd.jsonl');
    const logger = createJsonlLogger(logFile, {
      maxBytes: 180,
      archiveCount: 2,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    logger.protect(['opaque-secret']);
    logger.log('info', 'test', 'xoxb-token opaque-secret and safe text');
    logger.log('warn', 'test', 'xapp-token second record');
    logger.log('error', 'test', 'Bearer abc.def third record', { operationId: 'op-1' });

    const files = [logFile, `${logFile}.1`, `${logFile}.2`];
    for (const file of files) {
      assert.equal(permissions(await lstat(file)), 0o600);
      const records = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(records.length > 0);
      for (const record of records) {
        assert.equal(record.timestamp, '2026-08-02T00:00:00.000Z');
        assert.ok(record.level);
        assert.equal(record.scope, 'test');
      }
    }
    await assert.rejects(lstat(`${logFile}.3`), { code: 'ENOENT' });

    const combined = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const output = combined.join('');
    assert.doesNotMatch(output, /xoxb-token|xapp-token|opaque-secret|abc\.def/);
    assert.match(output, /\[REDACTED\]/);
  });
});

test('maintenance operations are single-flight, observable, and included in daemon drain', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    let releaseOperation;
    const operationGate = new Promise((resolve) => {
      releaseOperation = resolve;
    });
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async (request, context) => {
        context.progress(`Running ${request.type}.`);
        await operationGate;
        return { processed: 1, summary: 'private agent output' };
      },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
      const created = await createOperation(daemon.paths.socketFile, { type: 'memory' });
      assert.ok(created.operationId);

      await assert.rejects(
        createOperation(daemon.paths.socketFile, { type: 'dream' }),
        (error) =>
          error instanceof ControlRequestError &&
          error.code === 'operation_active' &&
          error.statusCode === 409 &&
          error.details.activeOperationId === created.operationId,
      );

      const running = await getOperation(daemon.paths.socketFile, created.operationId);
      assert.ok(running.state === 'queued' || running.state === 'running');
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 1);

      const eventsPromise = (async () => {
        const events = [];
        for await (const event of watchOperation(daemon.paths.socketFile, created.operationId)) {
          events.push(event);
        }
        return events;
      })();
      releaseOperation();
      const events = await eventsPromise;
      assert.deepEqual(events.map((event) => event.type), [
        'queued',
        'running',
        'progress',
        'succeeded',
      ]);
      const completed = await getOperation(daemon.paths.socketFile, created.operationId);
      assert.equal(completed.state, 'succeeded');
      assert.deepEqual(completed.result, { processed: 1, summary: 'private agent output' });
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 0);

      const logText = await readFile(daemon.paths.logFile, 'utf8');
      assert.doesNotMatch(logText, /private agent output/);
    } finally {
      releaseOperation();
      await daemon.close();
    }
  });
});

test('operation records and events obey their retention bounds', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    let nowMs = Date.parse('2026-08-02T00:00:00.000Z');
    let nextId = 0;
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async (_request, context) => {
        for (let index = 0; index < 1_005; index += 1) context.progress(`step ${index}`);
        return { ok: true };
      },
      operationRegistry: {
        completedLimit: 2,
        retentionMs: 100,
        eventLimit: 1_000,
        now: () => new Date(nowMs),
        createId: () => `operation-${++nextId}`,
      },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
      const ids = [];
      for (let index = 0; index < 3; index += 1) {
        nowMs += 1;
        const { operationId } = await createOperation(daemon.paths.socketFile, { type: 'memory' });
        ids.push(operationId);
        for await (const event of watchOperation(daemon.paths.socketFile, operationId)) {
          // Completion of the stream is the observable completion barrier.
          assert.ok(event.sequence > 0);
        }
      }

      await assert.rejects(
        getOperation(daemon.paths.socketFile, ids[0]),
        (error) => error instanceof ControlRequestError && error.code === 'operation_not_found',
      );
      const retainedEvents = [];
      for await (const event of watchOperation(daemon.paths.socketFile, ids[2])) {
        retainedEvents.push(event);
      }
      assert.equal(retainedEvents.length, 1_000);
      assert.equal(retainedEvents.at(-1).type, 'succeeded');

      nowMs += 101;
      await assert.rejects(
        getOperation(daemon.paths.socketFile, ids[2]),
        (error) => error instanceof ControlRequestError && error.code === 'operation_not_found',
      );
    } finally {
      await daemon.close();
    }
  });
});

test('daemon shutdown waits for a running maintenance operation to drain', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    let releaseOperation;
    const gate = new Promise((resolve) => {
      releaseOperation = resolve;
    });
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async () => {
        await gate;
        return { ok: true };
      },
    });
    await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
    await createOperation(daemon.paths.socketFile, { type: 'memory' });
    await waitForStatus(daemon.paths.socketFile, (status) => status.activeWorkCount === 1);

    let stopped = false;
    const closing = daemon.close().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    releaseOperation();
    await closing;
    assert.equal(stopped, true);
  });
});

test('operation failures expose a stable code without logging prompt or token contents', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async () => {
        throw new Error('private user prompt xoxb-operation-secret');
      },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
      const { operationId } = await createOperation(daemon.paths.socketFile, { type: 'memory' });
      for await (const event of watchOperation(daemon.paths.socketFile, operationId)) {
        assert.ok(event.sequence > 0);
      }
      const operation = await getOperation(daemon.paths.socketFile, operationId);
      assert.equal(operation.state, 'failed');
      assert.deepEqual(operation.error, { code: 'operation_failed' });
      const logs = await readFile(daemon.paths.logFile, 'utf8');
      assert.doesNotMatch(logs, /private user prompt|xoxb-operation-secret/);
    } finally {
      await daemon.close();
    }
  });
});

test('log history and streams use cursors across rotation and process instances', async () => {
  await withTempHome(async (homeDir) => {
    const daemonA = await startSkyd({
      homeDir,
      logger: { maxBytes: 240, archiveCount: 5 },
    });
    let cursorA;
    try {
      await waitForStatus(
        daemonA.paths.socketFile,
        (status) => status.runtime.state === 'needs_configuration',
      );
      const firstHistory = await getLogHistory(daemonA.paths.socketFile, { limit: 100 });
      cursorA = firstHistory.records[0].cursor;
      assert.ok(cursorA.startsWith(`${daemonA.status().instanceId}:`));
    } finally {
      await daemonA.close();
    }

    const daemonB = await startSkyd({
      homeDir,
      logger: { maxBytes: 240, archiveCount: 5 },
    });
    try {
      await waitForStatus(
        daemonB.paths.socketFile,
        (status) => status.runtime.state === 'needs_configuration',
      );
      const resumed = await getLogHistory(daemonB.paths.socketFile, {
        cursor: cursorA,
        limit: 100,
      });
      assert.ok(resumed.records.some((record) => record.cursor.startsWith(`${daemonB.status().instanceId}:`)));

      const abortController = new AbortController();
      const iterator = streamLogRecords(daemonB.paths.socketFile, {
        cursor: resumed.nextCursor,
        signal: abortController.signal,
      })[Symbol.asyncIterator]();
      const nextRecord = iterator.next();
      const created = await createOperation(daemonB.paths.socketFile, { type: 'memory' });
      const streamed = await nextRecord;
      abortController.abort();
      assert.equal(streamed.done, false);
      assert.equal(streamed.value.operationId, created.operationId);
    } finally {
      await daemonB.close();
    }
  });
});
