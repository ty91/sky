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
import { startSkyd } from '../dist/skyd/app.js';
import {
  ControlRequestError,
  DaemonAlreadyRunningError,
  getDaemonStatus,
  requestDaemonRestart,
} from '../dist/skyd/control.js';
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

      const missing = await rawControlRequest(daemon.paths.socketFile, 'GET', '/missing');
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(JSON.parse(missing.body), { error: { code: 'not_found' } });

      assert.equal(permissions(await lstat(daemon.paths.skyDir)), 0o700);
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
