import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { contextFromEnv } from '../dist/mcp/restart-harness-server.js';

test('contextFromEnv validates MCP server context', () => {
  assert.deepEqual(
    contextFromEnv({
      SKY_SESSION_KEY: 'C123:111.22',
      SKY_SLACK_CHANNEL_ID: 'C123',
      SKY_SLACK_THREAD_TS: '111.22',
      SKY_PARENT_PID: '12345',
    }),
    {
      sessionKey: 'C123:111.22',
      channelId: 'C123',
      threadTs: '111.22',
      parentPid: 12345,
    },
  );

  assert.throws(
    () =>
      contextFromEnv({
        SKY_SESSION_KEY: 'C123:111.22',
        SKY_SLACK_CHANNEL_ID: 'C123',
        SKY_SLACK_THREAD_TS: '111.22',
        SKY_PARENT_PID: 'nope',
      }),
    /Invalid SKY_PARENT_PID/,
  );
});

test('restart harness records pending restart, signals parent, and rate limits repeats', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-restart-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import { runRestartHarnessTool } from './dist/agents/tools/restart-harness.js';
import { _resetRestartStateForTests, isRestartPending } from './dist/runtime/pending-restart.js';

_resetRestartStateForTests();
const signals = [];
const ctx = {
  sessionKey: 'C123:111.22',
  channelId: 'C123',
  threadTs: '111.22',
  parentPid: 4242,
};

const first = runRestartHarnessTool(ctx, { reason: 'reload' }, (pid, signal) => {
  signals.push({ pid, signal });
});

assert.equal(first.isError, undefined);
assert.match(first.content[0].text, /Restart scheduled/);
assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGUSR2' }]);
assert.equal(isRestartPending(), true);

const second = runRestartHarnessTool(ctx, {}, (pid, signal) => {
  signals.push({ pid, signal });
});

assert.equal(second.isError, true);
assert.match(second.content[0].text, /rate-limited/);
assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGUSR2' }]);
console.log('restart-harness-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /restart-harness-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('restart signal handler invokes the scheduler and can be unregistered', async () => {
  let count = 0;
  const { registerRestartSignalHandler } = await import('../dist/bot.js');
  const before = new Set(process.listeners('SIGUSR2'));
  const unregister = registerRestartSignalHandler(() => {
    count++;
  });
  const handler = process.listeners('SIGUSR2').find((listener) => !before.has(listener));
  assert.equal(typeof handler, 'function');

  handler();
  assert.equal(count, 1);

  unregister();
  assert.equal(process.listeners('SIGUSR2').includes(handler), false);
  assert.equal(count, 1);
});
