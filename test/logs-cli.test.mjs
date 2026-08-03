import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startSkyd } from './helpers/start-skyd.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');
const fakeLaunchctl = path.join(repositoryRoot, 'test', 'helpers', 'fake-launchctl.mjs');

async function runCli(args, env) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [skyEntrypoint, ...args], {
    env,
    encoding: 'utf8',
  });
  return { stdout, stderr };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not reached before timeout');
}

test('logs uses daemon JSON history and read-only file fallback without tail', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-logs-cli-'));
  const env = { ...process.env, HOME: homeDir };
  const daemon = await startSkyd({ homeDir });
  try {
    const live = await runCli(['logs', '--json'], env);
    assert.equal(live.stderr, '');
    const records = live.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(records.length > 0);
    assert.ok(records.every((record) => record.cursor.startsWith(`${daemon.status().instanceId}:`)));
  } finally {
    await daemon.close();
  }

  try {
    const stderrFile = path.join(homeDir, '.sky', 'logs', 'launchd.stderr.log');
    await writeFile(stderrFile, 'launchd startup failure\n');
    const fallback = await runCli(['logs', '--json'], env);
    const records = fallback.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.scope === 'launchd'));
    assert.ok(records.some((record) => record.scope === 'daemon'));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('logs --follow reconnects with its last cursor after daemon replacement', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-logs-follow-'));
  const binDir = path.join(homeDir, 'bin');
  const stateFile = path.join(homeDir, 'launchctl-state.json');
  await mkdir(binDir, { recursive: true });
  const launchctlWrapper = path.join(binDir, 'launchctl');
  await writeFile(
    launchctlWrapper,
    '#!/bin/sh\nexec "$SKY_TEST_NODE" "$SKY_TEST_FAKE_LAUNCHCTL" "$@"\n',
  );
  await chmod(launchctlWrapper, 0o755);
  await writeFile(stateFile, JSON.stringify({ loaded: true, pid: process.pid }));
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: [binDir, process.env.PATH ?? ''].join(path.delimiter),
    SKY_TEST_NODE: process.execPath,
    SKY_TEST_FAKE_LAUNCHCTL: fakeLaunchctl,
    SKY_FAKE_LAUNCHCTL_STATE: stateFile,
  };

  let daemonA = await startSkyd({ homeDir });
  const instanceA = daemonA.status().instanceId;
  let daemonB;
  let instanceB;
  const child = spawn(process.execPath, [skyEntrypoint, 'logs', '--follow', '--json'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  try {
    await waitFor(() => stdout.includes(`${instanceA}:`));
    await daemonA.close();
    daemonA = undefined;

    daemonB = await startSkyd({ homeDir });
    instanceB = daemonB.status().instanceId;
    await waitFor(() => stdout.includes(`${instanceB}:`));

    await writeFile(stateFile, JSON.stringify({ loaded: false, pid: null }));
    await daemonB.close();
    daemonB = undefined;
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);

    const records = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const firstProcessIndex = records.findIndex((record) => record.cursor.startsWith(`${instanceA}:`));
    const replacementIndex = records.findIndex((record) => record.cursor.startsWith(`${instanceB}:`));
    assert.ok(firstProcessIndex >= 0);
    assert.ok(records.some((record) => record.message === 'Daemon stopped.'));
    assert.ok(replacementIndex > firstProcessIndex);
  } finally {
    if (daemonA) await daemonA.close();
    if (daemonB) await daemonB.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('logs uses the same absolute SKY_HOME override as the daemon', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-logs-override-'));
  const rootDir = path.join(homeDir, 'private-sky');
  const env = { ...process.env, HOME: homeDir, SKY_HOME: rootDir };
  const daemon = await startSkyd({ rootDir });
  try {
    const result = await runCli(['logs', '--json'], env);
    assert.equal(result.stderr, '');
    const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(
      records.some((record) => record.cursor.startsWith(`${daemon.status().instanceId}:`)),
    );
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
