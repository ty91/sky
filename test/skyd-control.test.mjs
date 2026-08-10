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
import { createConfiguration } from '../dist/configuration.js';
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
import { createMaintenanceOperationRunner } from '../dist/skyd/maintenance.js';
import { createOperationRegistry } from '../dist/skyd/operations.js';
import { PRODUCT_VERSION } from '../dist/product-version.js';
import { createRuntimeController } from '../dist/runtime/controller.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';

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

function createFakeClock(initial) {
  let nowMs = Date.parse(initial);
  let nextTimerId = 0;
  const timers = new Map();

  return {
    now: () => new Date(nowMs),
    timer: {
      setTimeout(callback, delayMs) {
        nextTimerId += 1;
        timers.set(nextTimerId, { callback, dueAt: nowMs + delayMs });
        return nextTimerId;
      },
      clearTimeout(timerId) {
        timers.delete(timerId);
      },
    },
    advanceBy(milliseconds) {
      nowMs += milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= nowMs)
          .toSorted((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    pendingDelays: () =>
      [...timers.values()]
        .map((timer) => timer.dueAt - nowMs)
        .toSorted((left, right) => left - right),
  };
}

function createFakeMaintenanceClock(initial) {
  let nowMs = Date.parse(initial);
  let nextTimerId = 0;
  let startedCount = 0;
  const intervals = new Map();
  const delays = [];

  return {
    now: () => nowMs,
    setInterval(callback, delayMs) {
      nextTimerId += 1;
      startedCount += 1;
      delays.push(delayMs);
      intervals.set(nextTimerId, { callback, delayMs, nextAt: nowMs + delayMs });
      return nextTimerId;
    },
    clearInterval(timerId) {
      intervals.delete(timerId);
    },
    async advanceBy(milliseconds) {
      const target = nowMs + milliseconds;
      while (true) {
        const due = [...intervals.entries()]
          .filter(([, interval]) => interval.nextAt <= target)
          .toSorted((left, right) => left[1].nextAt - right[1].nextAt || left[0] - right[0])[0];
        if (!due) break;
        nowMs = due[1].nextAt;
        due[1].nextAt += due[1].delayMs;
        due[1].callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      nowMs = target;
    },
    startedCount: () => startedCount,
    activeCount: () => intervals.size,
    delays: () => [...delays],
  };
}

function createControllableOperationRunner() {
  const starts = [];
  const waiters = [];

  return {
    async run(request) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const start = { request, release };
      starts.push(start);
      for (const resolve of waiters.splice(0)) resolve();
      await gate;
      return { ok: true };
    },
    async waitForStarts(count) {
      while (starts.length < count) {
        await new Promise((resolve) => waiters.push(resolve));
      }
      return starts;
    },
    starts,
  };
}

function createAbortableOperationRunner() {
  const pendingStarts = [];
  const startWaiters = [];

  return {
    async run(request, context) {
      const started = { request, signal: context.signal };
      const waiter = startWaiters.shift();
      if (waiter) waiter(started);
      else pendingStarts.push(started);

      await new Promise((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', resolve, { once: true });
      });
      return { summary: 'private agent output xoxb-operation-secret' };
    },
    nextStart() {
      const started = pendingStarts.shift();
      return started ?? new Promise((resolve) => startWaiters.push(resolve));
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createMaintenanceSessionFactory(options = {}) {
  const promptStarted = createDeferred();
  const abortStarted = createDeferred();
  const abortReleased = createDeferred();
  let sessionCount = 0;
  let resolvePrompt;
  let delayedSessionDisposed = false;

  const createSession = async () => {
    sessionCount += 1;
    const delayed = options.delayFirstAbort !== false && sessionCount === 1;
    const listeners = new Set();
    return {
      sessionId: `maintenance-session-${sessionCount}`,
      async prompt() {
        if (delayed) {
          promptStarted.resolve();
          await new Promise((resolve) => {
            resolvePrompt = resolve;
          });
          return;
        }
        for (const listener of listeners) {
          listener({ type: 'assistant_message', text: 'completed' });
          listener({ type: 'turn_end', text: 'completed' });
        }
      },
      async abort() {
        if (!delayed) return;
        abortStarted.resolve();
        resolvePrompt();
        await abortReleased.promise;
      },
      dispose() {
        if (delayed) delayedSessionDisposed = true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };
  createSession.backend = 'pi';

  return {
    createSession,
    promptStarted: promptStarted.promise,
    abortStarted: abortStarted.promise,
    releaseAbort: abortReleased.resolve,
    delayedSessionDisposed: () => delayedSessionDisposed,
    sessionCount: () => sessionCount,
  };
}

async function writeUnreadTranscript(paths) {
  const transcriptDirectory = path.join(paths.transcriptsDir, 'chat-1');
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(path.join(transcriptDirectory, 'session-1.md'), '### user\n\nhello\n\n', {
    mode: 0o600,
  });
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
    const daemon = await startSkyd({ homeDir });
    try {
      const status = await waitForStatus(
        daemon.paths.socketFile,
        (candidate) => candidate.runtime.state === 'needs_configuration',
      );

      assert.equal(status.productVersion, PRODUCT_VERSION);
      assert.equal(status.runtime.kind, 'node');
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
      assert.ok(status.recentErrors.some(({ code }) => code === 'settings_invalid'));
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

test('maintenance ticker uses the next five-minute KST occurrence while Slack reconnects', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const clock = createFakeMaintenanceClock('2026-08-10T00:00:01.000Z');
    const starts = [];
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => {
        throw new SlackStartupError(new Error('Slack is unavailable.'));
      },
      backoff: { baseMs: 60_000, maxMs: 60_000, jitterRatio: 0 },
      runOperation: async (request) => {
        starts.push(request);
        return { ok: true };
      },
      maintenanceTicker: {
        now: clock.now,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
      },
    });
    try {
      const degraded = await waitForStatus(
        daemon.paths.socketFile,
        (status) => status.runtime.state === 'degraded',
      );
      assert.equal(degraded.slack.state, 'retrying');
      assert.deepEqual(clock.delays(), [30_000]);

      await clock.advanceBy(5 * 60 * 1_000 - 1);
      assert.deepEqual(starts, []);
      await clock.advanceBy(1);
      assert.deepEqual(starts, [{ type: 'memory' }]);
    } finally {
      await daemon.close();
    }
  });
});

test('skyd schedules coalesced memory operations independently of Slack and stops the ticker on drain', { timeout: 5_000 }, async () => {
  await withTempHome(async (homeDir) => {
    const clock = createFakeMaintenanceClock('2026-08-10T00:00:01.000Z');
    const runner = createControllableOperationRunner();
    const daemon = await startSkyd({
      homeDir,
      runOperation: runner.run,
      maintenanceTicker: {
        now: clock.now,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
      },
    });
    try {
      await waitForStatus(
        daemon.paths.socketFile,
        (status) => status.runtime.state === 'needs_configuration',
      );
      assert.equal(clock.startedCount(), 1);
      assert.equal(clock.activeCount(), 1);

      await clock.advanceBy(5 * 60 * 1_000);
      assert.deepEqual(runner.starts, []);

      await writeValidSettings(homeDir);
      const manual = await createOperation(daemon.paths.socketFile, { type: 'dream' });
      const [manualStart] = await runner.waitForStarts(1);
      assert.equal(manualStart.request.type, 'dream');

      await clock.advanceBy(30_000);
      assert.equal(runner.starts.length, 1);

      manualStart.release();
      for await (const event of watchOperation(daemon.paths.socketFile, manual.operationId)) {
        assert.ok(event.sequence > 0);
      }

      await clock.advanceBy(30_000);
      const scheduledStarts = await runner.waitForStarts(2);
      assert.deepEqual(scheduledStarts.map(({ request }) => request.type), ['dream', 'memory']);

      await clock.advanceBy(11 * 60 * 1_000);
      assert.equal(runner.starts.length, 2);

      scheduledStarts[1].release();
      await waitForStatus(daemon.paths.socketFile, (status) => status.activeWorkCount === 0);
      await clock.advanceBy(30_000);
      const coalescedStarts = await runner.waitForStarts(3);
      assert.deepEqual(coalescedStarts.map(({ request }) => request.type), [
        'dream',
        'memory',
        'memory',
      ]);

      coalescedStarts[2].release();
      await waitForStatus(daemon.paths.socketFile, (status) => status.activeWorkCount === 0);
      const records = (await readFile(daemon.paths.logFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const submissions = records.filter(
        (record) =>
          record.scope === 'maintenance' && record.message === 'Scheduled memory operation submitted.',
      );
      assert.equal(submissions.length, 2);
      for (const submission of submissions) {
        assert.ok(
          records.some(
            (record) =>
              record.scope === 'operation' &&
              record.operationId === submission.operationId &&
              record.message === 'memory operation succeeded.',
          ),
        );
      }
    } finally {
      for (const start of runner.starts) start.release();
      await daemon.close();
    }

    assert.equal(clock.activeCount(), 0);
    const startCount = runner.starts.length;
    await clock.advanceBy(10 * 60 * 1_000);
    assert.equal(runner.starts.length, startCount);
  });
});

test('maintenance ticker rejects a due operation once daemon drain begins', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const clock = createFakeMaintenanceClock('2026-08-10T00:00:01.000Z');
    const starts = [];
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async (request) => {
        starts.push(request);
        return { ok: true };
      },
      maintenanceTicker: {
        now: clock.now,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
      },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');

      const closing = daemon.close();
      await clock.advanceBy(5 * 60 * 1_000);
      await closing;

      assert.deepEqual(starts, []);
      assert.equal(clock.activeCount(), 0);
    } finally {
      await daemon.close();
    }
  });
});

test('maintenance defaults time out memory and dream operations and release runtime ownership', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const clock = createFakeClock('2026-08-10T00:00:00.000Z');
    const runner = createAbortableOperationRunner();
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: runner.run,
      operationRegistry: { now: clock.now, timer: clock.timer },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');

      const memory = await createOperation(daemon.paths.socketFile, { type: 'memory' });
      const memoryStart = await runner.nextStart();
      assert.equal(memoryStart.request.type, 'memory');
      assert.deepEqual(clock.pendingDelays(), [10 * 60 * 1_000]);
      clock.advanceBy(10 * 60 * 1_000 - 1);
      assert.equal((await getOperation(daemon.paths.socketFile, memory.operationId)).state, 'running');
      clock.advanceBy(1);
      const memoryEvents = [];
      for await (const event of watchOperation(daemon.paths.socketFile, memory.operationId)) {
        memoryEvents.push(event);
      }
      assert.equal(memoryStart.signal.aborted, true);
      assert.deepEqual(memoryEvents.map((event) => event.type), ['queued', 'running', 'failed']);
      const failedMemory = await getOperation(daemon.paths.socketFile, memory.operationId);
      assert.equal(failedMemory.state, 'failed');
      assert.equal(failedMemory.finishedAt, '2026-08-10T00:10:00.000Z');
      assert.equal(failedMemory.result, null);
      assert.deepEqual(failedMemory.error, { code: 'operation_failed' });
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 0);

      const dream = await createOperation(daemon.paths.socketFile, { type: 'dream' });
      const dreamStart = await runner.nextStart();
      assert.equal(dreamStart.request.type, 'dream');
      assert.deepEqual(clock.pendingDelays(), [60 * 60 * 1_000]);
      clock.advanceBy(60 * 60 * 1_000);
      for await (const event of watchOperation(daemon.paths.socketFile, dream.operationId)) {
        assert.ok(event.sequence > 0);
      }
      assert.equal(dreamStart.signal.aborted, true);
      assert.equal((await getOperation(daemon.paths.socketFile, dream.operationId)).state, 'failed');
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 0);
      assert.deepEqual(clock.pendingDelays(), []);

      const logs = await readFile(daemon.paths.logFile, 'utf8');
      assert.match(logs, /memory operation timed out after 600000ms/);
      assert.match(logs, /dream operation timed out after 3600000ms/);
      assert.doesNotMatch(logs, /private agent output|xoxb-operation-secret/);
    } finally {
      await daemon.close();
    }
  });
});

test('maintenance timeout retains operation ownership until the agent session finishes closing', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const paths = createSkyHome({ homeDir });
    prepareSkyHome(paths);
    await writeUnreadTranscript(paths);
    const clock = createFakeClock('2026-08-10T00:00:00.000Z');
    const sessions = createMaintenanceSessionFactory();
    const configuration = createConfiguration(paths, { env: {} });
    const runOperation = createMaintenanceOperationRunner(
      paths,
      createJsonlLogger(path.join(paths.logsDir, 'maintenance-test.jsonl'), { now: clock.now }),
      configuration,
      { createSession: sessions.createSession },
    );
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation,
      operationRegistry: {
        now: clock.now,
        timeouts: { memory: 25 },
        timer: clock.timer,
      },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
      const memory = await createOperation(daemon.paths.socketFile, { type: 'memory' });
      await sessions.promptStarted;
      clock.advanceBy(25);
      await sessions.abortStarted;

      assert.equal(sessions.delayedSessionDisposed(), false);
      assert.equal((await getOperation(daemon.paths.socketFile, memory.operationId)).state, 'running');
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 1);
      await assert.rejects(
        createOperation(daemon.paths.socketFile, { type: 'dream' }),
        (error) => error instanceof ControlRequestError && error.code === 'operation_active',
      );

      sessions.releaseAbort();
      for await (const event of watchOperation(daemon.paths.socketFile, memory.operationId)) {
        assert.ok(event.sequence > 0);
      }
      assert.equal(sessions.delayedSessionDisposed(), true);
      assert.equal((await getDaemonStatus(daemon.paths.socketFile)).activeWorkCount, 0);

      const dream = await createOperation(daemon.paths.socketFile, {
        type: 'dream',
        step: 'summarize',
      });
      for await (const event of watchOperation(daemon.paths.socketFile, dream.operationId)) {
        assert.ok(event.sequence > 0);
      }
      assert.equal((await getOperation(daemon.paths.socketFile, dream.operationId)).state, 'succeeded');
    } finally {
      sessions.releaseAbort();
      await daemon.close();
    }
  });
});

test('a maintenance operation cancelled while queued never creates an agent session', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const paths = createSkyHome({ homeDir });
    prepareSkyHome(paths);
    await writeUnreadTranscript(paths);
    const clock = createFakeClock('2026-08-10T00:00:00.000Z');
    const sessions = createMaintenanceSessionFactory({ delayFirstAbort: false });
    const runOperation = createMaintenanceOperationRunner(
      paths,
      createJsonlLogger(path.join(paths.logsDir, 'queued-cancel-test.jsonl'), { now: clock.now }),
      createConfiguration(paths, { env: {} }),
      { createSession: sessions.createSession },
    );
    const runtimeController = createRuntimeController({ supervisionMode: 'foreground' });
    const registry = createOperationRegistry({
      runtimeController,
      logger: createJsonlLogger(path.join(paths.logsDir, 'queued-cancel-registry.jsonl'), {
        now: clock.now,
      }),
      run: runOperation,
      now: clock.now,
      createId: () => 'queued-cancel',
      timer: clock.timer,
    });
    const created = registry.create({ type: 'memory' });
    assert.equal(created.ok, true);
    const terminal = new Promise((resolve) => {
      const subscription = registry.events(created.operation.id);
      const unsubscribe = subscription.subscribe((event) => {
        if (event.type !== 'cancelled') return;
        unsubscribe();
        resolve(event);
      });
    });

    registry.cancelActive();
    await terminal;

    assert.equal(sessions.sessionCount(), 0);
    assert.equal(registry.get(created.operation.id).state, 'cancelled');
    assert.equal(runtimeController.activeCount(), 0);
    assert.deepEqual(clock.pendingDelays(), []);
  });
});

test('a completed maintenance operation clears its timer without a late abort or event', async () => {
  await withTempHome(async (homeDir) => {
    await writeValidSettings(homeDir);
    const clock = createFakeClock('2026-08-10T00:00:00.000Z');
    let operationSignal;
    const daemon = await startSkyd({
      homeDir,
      startRuntime: async () => ({ close: async () => {} }),
      runOperation: async (_request, context) => {
        operationSignal = context.signal;
        return { ok: true };
      },
      operationRegistry: { now: clock.now, timer: clock.timer },
    });
    try {
      await waitForStatus(daemon.paths.socketFile, (status) => status.runtime.state === 'ready');
      const { operationId } = await createOperation(daemon.paths.socketFile, { type: 'memory' });
      const events = [];
      for await (const event of watchOperation(daemon.paths.socketFile, operationId)) {
        events.push(event);
      }
      assert.deepEqual(clock.pendingDelays(), []);
      assert.equal(operationSignal.aborted, false);

      clock.advanceBy(24 * 60 * 60 * 1_000);

      assert.equal(operationSignal.aborted, false);
      assert.equal((await getOperation(daemon.paths.socketFile, operationId)).state, 'succeeded');
      assert.deepEqual(events.map((event) => event.type), ['queued', 'running', 'succeeded']);
    } finally {
      await daemon.close();
    }
  });
});

test('operation registry resolves the load-bearing timeout and drain race once', async () => {
  await withTempHome(async (homeDir) => {
    for (const first of ['timeout', 'drain']) {
      const clock = createFakeClock('2026-08-10T00:00:00.000Z');
      const runner = createAbortableOperationRunner();
      const runtimeController = createRuntimeController({ supervisionMode: 'foreground' });
      const registry = createOperationRegistry({
        runtimeController,
        logger: createJsonlLogger(path.join(homeDir, `${first}.jsonl`), { now: clock.now }),
        run: runner.run,
        now: clock.now,
        createId: () => first,
        timeouts: { memory: 25, dream: 50 },
        timer: clock.timer,
      });
      const created = registry.create({ type: first === 'timeout' ? 'memory' : 'dream' });
      assert.equal(created.ok, true);
      const started = await runner.nextStart();
      assert.deepEqual(clock.pendingDelays(), [first === 'timeout' ? 25 : 50]);
      const terminal = new Promise((resolve) => {
        const subscription = registry.events(created.operation.id);
        const unsubscribe = subscription.subscribe((event) => {
          if (event.type !== 'failed' && event.type !== 'cancelled') return;
          unsubscribe();
          resolve(event);
        });
      });

      if (first === 'timeout') {
        clock.advanceBy(25);
        registry.cancelActive();
      } else {
        registry.cancelActive();
        clock.advanceBy(50);
      }

      const terminalEvent = await terminal;
      assert.equal(started.signal.aborted, true);
      assert.equal(terminalEvent.type, first === 'timeout' ? 'failed' : 'cancelled');
      assert.equal(registry.get(created.operation.id).state, terminalEvent.type);
      assert.equal(
        registry
          .events(created.operation.id)
          .events.filter((event) => event.type === 'failed' || event.type === 'cancelled').length,
        1,
      );
      assert.equal(runtimeController.activeCount(), 0);
      assert.deepEqual(clock.pendingDelays(), []);
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
