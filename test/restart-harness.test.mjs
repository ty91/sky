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

test('main agent exposes restart_harness as a Pi custom tool bound to Slack session context', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-restart-pi-tool-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import { createMainAgentConfig } from './dist/agents/main.js';
import { _resetRestartStateForTests, consumePendingRestart } from './dist/runtime/pending-restart.js';

_resetRestartStateForTests();
const agent = createMainAgentConfig({ systemPrompt: 'system' });

assert.ok(agent.tools.includes('restart_harness'));
assert.equal(typeof agent.customToolsFactory, 'function');

const signals = [];
const agentWithFakeSignal = createMainAgentConfig({
  systemPrompt: 'system',
  restartSignalParent: (pid, signal) => signals.push({ pid, signal }),
});
const tools = agentWithFakeSignal.customToolsFactory({ sessionKey: 'C123:111.22' });
assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'restart_harness');

const result = await tools[0].execute('tool-1', { reason: 'reload' }, undefined, undefined, {
  signal: undefined,
  isIdle: () => false,
  shutdown: () => undefined,
});

assert.match(result.content[0].text, /Restart scheduled/);
assert.deepEqual(result.details, {
  sessionKey: 'C123:111.22',
  channelId: 'C123',
  threadTs: '111.22',
});

const pending = consumePendingRestart();
assert.equal(pending.sessionKey, 'C123:111.22');
assert.equal(pending.channelId, 'C123');
assert.equal(pending.threadTs, '111.22');
assert.equal(pending.reason, 'reload');
assert.deepEqual(signals, [{ pid: process.pid, signal: 'SIGUSR2' }]);
console.log('restart-pi-tool-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /restart-pi-tool-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('main agent exposes slack_attach_files only when a Slack uploader provider is configured', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-slack-attach-main-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMainAgentConfig } from './dist/agents/main.js';

const agentWithoutUploader = createMainAgentConfig({ systemPrompt: 'system' });
assert.ok(agentWithoutUploader.tools.includes('slack_attach_files'));
assert.deepEqual(
  agentWithoutUploader.customToolsFactory({ sessionKey: 'C123:111.22' }).map((tool) => tool.name),
  ['restart_harness'],
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sky-main-tool-'));
try {
  const filePath = path.join(tempDir, 'report.txt');
  await writeFile(filePath, 'report', 'utf8');
  const uploadCalls = [];
  const agentWithUploader = createMainAgentConfig({
    systemPrompt: 'system',
    slackFileUploaderProvider: () => ({
      uploadFiles: async (params) => {
        uploadCalls.push(params);
        return params.paths.map((uploadedPath) => ({ path: uploadedPath, fileId: 'F1' }));
      },
    }),
  });

  const tools = agentWithUploader.customToolsFactory({ sessionKey: 'C123:111.22' });
  assert.deepEqual(tools.map((tool) => tool.name), ['restart_harness', 'slack_attach_files']);

  const attachTool = tools.find((tool) => tool.name === 'slack_attach_files');
  const result = await attachTool.execute('tool-1', { paths: [filePath] }, undefined, undefined, {
    signal: undefined,
    isIdle: () => false,
    shutdown: () => undefined,
  });

  assert.deepEqual(uploadCalls, [
    {
      channelId: 'C123',
      threadTs: '111.22',
      paths: [filePath],
    },
  ]);
  assert.deepEqual(result.details, {
    channelId: 'C123',
    threadTs: '111.22',
    uploadedCount: 1,
    uploadedPaths: [filePath],
    uploads: [{ path: filePath, fileId: 'F1' }],
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('slack-attach-main-agent-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /slack-attach-main-agent-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('post-restart trigger is delivered through the original Pi conversation and Slack thread', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-restart-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import { triggerPostRestartIfPending } from './dist/bot.js';
import { requestRestart, _resetRestartStateForTests } from './dist/runtime/pending-restart.js';

_resetRestartStateForTests();
requestRestart({
  sessionKey: 'C123:111.22',
  channelId: 'C123',
  threadTs: '111.22',
  reason: 'reload',
  requestedAt: Date.now(),
});

const calls = { runTurn: [], posts: [] };
const conversationManager = {
  runTurn: async (key, agent, text, options) => {
    calls.runTurn.push({ key, agentName: agent.name, text });
    await options.onTextDelta('back online');
    return { kind: 'ok', text: 'back online', handle: { sessionId: 'pi-session' } };
  },
};
const slackApp = {
  client: {
    chat: {
      postMessage: async (message) => {
        calls.posts.push(message);
      },
    },
  },
};

await triggerPostRestartIfPending(slackApp, conversationManager, { name: 'main' });

assert.equal(calls.runTurn.length, 1);
assert.equal(calls.runTurn[0].key, 'C123:111.22');
assert.equal(calls.runTurn[0].agentName, 'main');
assert.match(calls.runTurn[0].text, /<system-reminder>/);
assert.ok(calls.runTurn[0].text.includes('Reason: reload.'));
assert.deepEqual(calls.posts, [{ channel: 'C123', thread_ts: '111.22', text: 'back online' }]);
console.log('post-restart-conversation-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /post-restart-conversation-ok/);
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
