import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');
const fakeLaunchctl = path.join(repositoryRoot, 'test', 'helpers', 'fake-launchctl.mjs');
const fakeSkyd = path.join(repositoryRoot, 'test', 'helpers', 'fake-skyd.mjs');

async function setup() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-launch-agent-'));
  const binDir = path.join(homeDir, 'bin');
  const stateFile = path.join(homeDir, 'launchctl-state.json');
  const readyFile = path.join(homeDir, 'fake-skyd-ready');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'launchctl'),
    '#!/bin/sh\nexec "$SKY_TEST_NODE" "$SKY_TEST_FAKE_LAUNCHCTL" "$@"\n',
  );
  await chmod(path.join(binDir, 'launchctl'), 0o755);
  await symlink(process.execPath, path.join(binDir, 'skyd'));

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
    SKY_TEST_NODE: process.execPath,
    SKY_TEST_FAKE_LAUNCHCTL: fakeLaunchctl,
    SKY_FAKE_LAUNCHCTL_STATE: stateFile,
    SKY_FAKE_DAEMON: fakeSkyd,
    SKY_FAKE_DAEMON_READY_FILE: readyFile,
  };
  return {
    homeDir,
    binDir,
    stateFile,
    readyFile,
    plistFile: path.join(
      homeDir,
      'Library',
      'LaunchAgents',
      'com.ty91.skyd.plist',
    ),
    env,
  };
}

async function runCli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [skyEntrypoint, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function readState(stateFile) {
  return JSON.parse(await readFile(stateFile, 'utf8'));
}

async function stopFakeDaemon(stateFile) {
  try {
    const { pid } = await readState(stateFile);
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {
    // A test may fail before fake launchd creates its state file.
  }
}

async function cleanup(context) {
  await stopFakeDaemon(context.stateFile);
  await rm(context.homeDir, { recursive: true, force: true });
}

async function parsePlist(plistFile) {
  const { stdout } = await execFileAsync(
    'plutil',
    ['-convert', 'json', '-o', '-', plistFile],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

function previousPlist(oldWrapper) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ty91.skyd</string>
  <key>ProgramArguments</key><array><string>${oldWrapper}</string><string>--foreground</string></array>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

test('CLI manages a persistent LaunchAgent without restarting an unchanged plist', { timeout: 60_000 }, async () => {
  const context = await setup();
  const settingsFile = path.join(context.homeDir, '.sky', 'settings.json');
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, '{"preserved":true}\n');

    const installed = await runCli(['service', 'install', '--json'], context.env);
    assert.equal(installed.code, 0, installed.stderr || installed.stdout);
    const installedJson = JSON.parse(installed.stdout);
    assert.equal(installedJson.ok, true);
    assert.equal(installedJson.changed, true);
    assert.equal(installedJson.status.control.status.runtime.state, 'ready');

    const plist = await parsePlist(context.plistFile);
    assert.deepEqual(Object.keys(plist).toSorted(), [
      'EnvironmentVariables',
      'ExitTimeOut',
      'KeepAlive',
      'Label',
      'ProcessType',
      'ProgramArguments',
      'StandardErrorPath',
      'Umask',
    ]);
    assert.equal(plist.Label, 'com.ty91.skyd');
    assert.deepEqual(plist.ProgramArguments, [
      path.join(context.binDir, 'skyd'),
      '--foreground',
      '--supervised',
    ]);
    assert.equal(plist.KeepAlive, true);
    assert.equal(plist.ProcessType, 'Standard');
    assert.equal(plist.Umask, 0o77);
    assert.equal(plist.ExitTimeOut, 30);
    assert.equal(
      plist.StandardErrorPath,
      path.join(context.homeDir, '.sky', 'logs', 'launchd.stderr.log'),
    );
    assert.deepEqual(Object.keys(plist.EnvironmentVariables).toSorted(), ['HOME', 'PATH']);
    assert.equal(plist.EnvironmentVariables.HOME, context.homeDir);
    assert.doesNotMatch(JSON.stringify(plist), /SLACK|CLAUDE|TOKEN|RunAtLoad|ThrottleInterval/i);

    const firstState = await readState(context.stateFile);
    const reconciled = await runCli(['service', 'install', '--json'], context.env);
    assert.equal(reconciled.code, 0, reconciled.stderr || reconciled.stdout);
    assert.equal(JSON.parse(reconciled.stdout).changed, false);
    const secondState = await readState(context.stateFile);
    assert.equal(secondState.bootstrapCount, firstState.bootstrapCount);
    assert.equal(secondState.pid, firstState.pid);

    const status = await runCli(['status', '--json'], context.env);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).status.launchd.pid, firstState.pid);

    const serviceStatus = await runCli(['service', 'status', '--json'], context.env);
    assert.equal(serviceStatus.code, 0, serviceStatus.stderr || serviceStatus.stdout);
    assert.equal(JSON.parse(serviceStatus.stdout).status.launchd.pid, firstState.pid);

    const restarted = await runCli(['restart', '--json'], context.env);
    assert.equal(restarted.code, 0, restarted.stderr || restarted.stdout);
    const restartedState = await readState(context.stateFile);
    assert.notEqual(restartedState.pid, firstState.pid);
    assert.equal(restartedState.kickstartCount, 0);
    assert.notEqual(
      JSON.parse(restarted.stdout).status.control.status.instanceId,
      installedJson.status.control.status.instanceId,
    );

    const stopped = await runCli(['stop', '--json'], context.env);
    assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
    assert.equal((await readState(context.stateFile)).loaded, false);
    assert.equal((await stat(context.plistFile)).isFile(), true);

    const restartWhileStopped = await runCli(['restart', '--json'], context.env);
    assert.equal(restartWhileStopped.code, 1);
    assert.equal(JSON.parse(restartWhileStopped.stdout).error.code, 'service_not_loaded');
    assert.equal((await readState(context.stateFile)).bootstrapCount, 1);

    const started = await runCli(['start', '--json'], context.env);
    assert.equal(started.code, 0, started.stderr || started.stdout);
    assert.equal((await readState(context.stateFile)).bootstrapCount, 2);

    const runningState = await readState(context.stateFile);
    process.kill(runningState.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unresponsive = await runCli(['restart', '--json'], context.env);
    assert.equal(unresponsive.code, 1);
    assert.equal(JSON.parse(unresponsive.stdout).error.code, 'daemon_unresponsive');
    assert.equal((await readState(context.stateFile)).kickstartCount, 0);

    const forced = await runCli(['restart', '--force', '--json'], context.env);
    assert.equal(forced.code, 0, forced.stderr || forced.stdout);
    assert.equal((await readState(context.stateFile)).kickstartCount, 1);

    const uninstalled = await runCli(['service', 'uninstall', '--json'], context.env);
    assert.equal(uninstalled.code, 0, uninstalled.stderr || uninstalled.stdout);
    await assert.rejects(stat(context.plistFile), { code: 'ENOENT' });
    assert.equal(await readFile(settingsFile, 'utf8'), '{"preserved":true}\n');
  } finally {
    await cleanup(context);
  }
});

test('service install records an absolute SKY_HOME override for launchd', { timeout: 60_000 }, async () => {
  const context = await setup();
  const customRoot = path.join(context.homeDir, 'custom-sky-home');
  const env = { ...context.env, SKY_HOME: customRoot };
  try {
    const installed = await runCli(['service', 'install', '--json'], env);
    assert.equal(installed.code, 0, installed.stderr || installed.stdout);

    const plist = await parsePlist(context.plistFile);
    assert.equal(plist.StandardErrorPath, path.join(customRoot, 'logs', 'launchd.stderr.log'));
    assert.equal(plist.EnvironmentVariables.SKY_HOME, customRoot);
  } finally {
    await cleanup(context);
  }
});

test('unhealthy startup states are reported as completed but non-zero', { timeout: 30_000 }, async (t) => {
  for (const runtimeState of ['needs_configuration', 'degraded']) {
    await t.test(runtimeState, async () => {
      const context = await setup();
      try {
        const result = await runCli(['service', 'install', '--json'], {
          ...context.env,
          SKY_FAKE_RUNTIME_STATE: runtimeState,
        });
        assert.equal(result.code, 1);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.status.control.status.runtime.state, runtimeState);
        assert.equal(output.rollback.attempted, false);
      } finally {
        await cleanup(context);
      }
    });
  }
});

test('a failed changed plist restores and reboots the previous LaunchAgent', { timeout: 30_000 }, async () => {
  const context = await setup();
  const oldWrapper = '/opt/sky/old-skyd';
  const oldPlist = previousPlist(oldWrapper);
  try {
    await mkdir(path.dirname(context.plistFile), { recursive: true });
    await writeFile(context.plistFile, oldPlist);
    await execFileAsync(path.join(context.binDir, 'launchctl'), [
      'bootstrap',
      'gui/501',
      context.plistFile,
    ], { env: context.env });

    const result = await runCli(['service', 'install', '--json'], {
      ...context.env,
      SKY_FAKE_FAIL_BOOTSTRAP_MATCH: path.join(context.binDir, 'skyd'),
    });
    assert.equal(result.code, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, 'reconcile_failed');
    assert.deepEqual(output.rollback, {
      attempted: true,
      succeeded: true,
      message: 'The previous LaunchAgent was restored.',
    });
    assert.equal(await readFile(context.plistFile, 'utf8'), oldPlist);
    const state = await readState(context.stateFile);
    assert.equal(state.loaded, true);
    assert.equal(state.bootstrapCount, 2);
  } finally {
    await cleanup(context);
  }
});

test('legacy migration terminates only a verified @ty91/sky bot.js and moves its log once', { timeout: 30_000 }, async () => {
  const context = await setup();
  const legacyPackage = path.join(context.homeDir, 'legacy-package');
  const legacyEntry = path.join(legacyPackage, 'dist', 'bot.js');
  let legacy;
  try {
    await mkdir(path.dirname(legacyEntry), { recursive: true });
    await writeFile(path.join(legacyPackage, 'package.json'), '{"name":"@ty91/sky"}\n');
    await writeFile(legacyEntry, 'setInterval(() => {}, 1000);\n');
    legacy = spawn(process.execPath, [legacyEntry], { stdio: 'ignore' });
    const legacyExited = once(legacy, 'exit');

    const skyDir = path.join(context.homeDir, '.sky');
    await mkdir(skyDir, { recursive: true });
    await writeFile(path.join(skyDir, 'sky.pid'), `${legacy.pid}\n`);
    await writeFile(path.join(skyDir, 'sky.log'), 'legacy log\n');

    const result = await runCli(['service', 'install', '--json'], context.env);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).legacyMigration, 'terminated');
    await legacyExited;
    assert.equal(await readFile(path.join(skyDir, 'logs', 'legacy-sky.log'), 'utf8'), 'legacy log\n');
    await assert.rejects(stat(path.join(skyDir, 'sky.pid')), { code: 'ENOENT' });
  } finally {
    if (legacy?.pid) {
      try { process.kill(legacy.pid, 'SIGTERM'); } catch {}
    }
    await cleanup(context);
  }
});

test('a reused legacy PID is ignored and never signaled', { timeout: 30_000 }, async () => {
  const context = await setup();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    const skyDir = path.join(context.homeDir, '.sky');
    await mkdir(skyDir, { recursive: true });
    await writeFile(path.join(skyDir, 'sky.pid'), `${unrelated.pid}\n`);

    const result = await runCli(['service', 'install', '--json'], context.env);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).legacyMigration, 'unrelated_process_ignored');
    assert.equal(unrelated.exitCode, null);
    process.kill(unrelated.pid, 0);
  } finally {
    unrelated.kill('SIGTERM');
    await cleanup(context);
  }
});

test('restart distinguishes an unmanaged foreground daemon', { timeout: 30_000 }, async () => {
  const context = await setup();
  const foreground = spawn(process.execPath, [fakeSkyd], {
    env: context.env,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await readFile(context.readyFile, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const result = await runCli(['restart', '--json'], context.env);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'foreground_daemon');
  } finally {
    foreground.kill('SIGTERM');
    await once(foreground, 'exit');
    await cleanup(context);
  }
});
