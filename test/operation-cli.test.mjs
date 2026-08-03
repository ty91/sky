import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getOperation, watchOperation } from '../dist/skyd/control-uds.js';
import { startSkyd } from '../dist/skyd/app.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const skyEntrypoint = path.join(repositoryRoot, 'dist', 'index.js');

async function setupHome() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-operation-cli-'));
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
  return homeDir;
}

async function runCli(args, homeDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [skyEntrypoint, ...args], {
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf8',
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

test('memory and dream are thin operation clients with status and watch reattachment', async () => {
  const homeDir = await setupHome();
  const daemon = await startSkyd({
    homeDir,
    startRuntime: async () => ({ close: async () => {} }),
    runOperation: async (request, context) => {
      context.progress(`running ${request.type}`);
      return { type: request.type, input: request };
    },
  });
  try {
    const memory = await runCli(['memory'], homeDir);
    assert.equal(memory.code, 0, memory.stderr);
    const memoryLines = memory.stdout.trim().split('\n');
    assert.match(memoryLines[0], /^operation: /);
    assert.ok(memoryLines.includes('Operation succeeded.'));
    const memoryId = memoryLines[0].slice('operation: '.length);

    const status = await runCli(['operation', 'status', memoryId, '--json'], homeDir);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).operation.state, 'succeeded');

    const dream = await runCli(
      ['dream', '--date', '2026-08-01', '--step', 'summarize', '--detach'],
      homeDir,
    );
    assert.equal(dream.code, 0, dream.stderr);
    assert.match(dream.stdout.trim(), /^operation: /);
    const dreamId = dream.stdout.trim().slice('operation: '.length);
    const watched = await runCli(['operation', 'watch', dreamId, '--json'], homeDir);
    assert.equal(watched.code, 0, watched.stderr);
    const events = watched.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'succeeded');
  } finally {
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('Ctrl-C detaches the CLI without cancelling the running operation', async () => {
  const homeDir = await setupHome();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const daemon = await startSkyd({
    homeDir,
    startRuntime: async () => ({ close: async () => {} }),
    runOperation: async () => {
      await gate;
      return { ok: true };
    },
  });
  let child;
  try {
    child = spawn(process.execPath, [skyEntrypoint, 'memory'], {
      env: { ...process.env, HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let operationId;
    for await (const chunk of child.stdout) {
      stdout += chunk;
      const match = stdout.match(/^operation: (.+)$/m);
      if (match) {
        operationId = match[1];
        child.kill('SIGINT');
        break;
      }
    }
    assert.ok(operationId);
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(signal, null);

    const running = await getOperation(daemon.paths.socketFile, operationId);
    assert.equal(running.state, 'running');
    release();
    for await (const event of watchOperation(daemon.paths.socketFile, operationId)) {
      assert.ok(event.sequence > 0);
    }
    assert.equal((await getOperation(daemon.paths.socketFile, operationId)).state, 'succeeded');
  } finally {
    release();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await daemon.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
