import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Pi adapter converts backend-neutral tool specs to Pi tool definitions', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-pi-tool-adapter-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toPiToolDefinition } from './dist/agents/backend/pi.js';

const calls = [];
const piTool = toPiToolDefinition({
  name: 'sample_tool',
  label: 'Sample tool',
  description: 'Run a sample tool.',
  inputSchema: {
    message: z.string(),
  },
  execute: async (input) => {
    calls.push(input);
    return {
      content: [{ type: 'text', text: 'ok' }],
      details: { echoed: input.message },
    };
  },
});

assert.equal(piTool.name, 'sample_tool');
assert.equal(piTool.label, 'Sample tool');
assert.equal(piTool.description, 'Run a sample tool.');
assert.equal(piTool.executionMode, 'sequential');
assert.deepEqual(piTool.parameters.properties.message, { type: 'string' });

const result = await piTool.execute('tool-1', { message: 'hello' }, undefined, undefined, {
  signal: undefined,
  isIdle: () => false,
  shutdown: () => undefined,
});

assert.deepEqual(calls, [{ message: 'hello' }]);
assert.deepEqual(result, {
  content: [{ type: 'text', text: 'ok' }],
  details: { echoed: 'hello' },
});

const failingTool = toPiToolDefinition({
  name: 'failing_tool',
  description: 'Fail.',
  inputSchema: {},
  execute: async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }),
});
await assert.rejects(
  () => failingTool.execute('tool-2', {}, undefined, undefined, {
    signal: undefined,
    isIdle: () => false,
    shutdown: () => undefined,
  }),
  /nope/,
);

console.log('pi-tool-adapter-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /pi-tool-adapter-ok/);
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
  [],
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
  assert.deepEqual(tools.map((tool) => tool.name), ['slack_attach_files']);

  const attachTool = tools.find((tool) => tool.name === 'slack_attach_files');
  const result = await attachTool.execute({ paths: [filePath] });

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

test('Slack file uploader provider is lazy and reports unavailable Slack app at execution time', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-slack-attach-lazy-'));

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
import { createSlackFileUploaderProvider } from './dist/bot.js';

let slackApp;
const provider = createSlackFileUploaderProvider(() => slackApp);
assert.equal(provider(), undefined);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sky-lazy-uploader-'));
try {
const filePath = path.join(tempDir, 'report.txt');
await writeFile(filePath, 'report', 'utf8');

const agent = createMainAgentConfig({
  systemPrompt: 'system',
  slackFileUploaderProvider: provider,
});
const unavailableTool = agent
  .customToolsFactory({ sessionKey: 'C123:111.22' })
  .find((tool) => tool.name === 'slack_attach_files');
await assert.rejects(
  () => unavailableTool.execute({ paths: [filePath] }),
  /Slack app is not ready/,
);

  const uploadCalls = [];
  slackApp = {
    client: {
      files: {
        uploadV2: async (params) => {
          uploadCalls.push(params);
          return { ok: true, file: { id: 'F123' } };
        },
      },
    },
  };

  const uploader = provider();
  const result = await uploader.uploadFiles({
    channelId: 'C123',
    threadTs: '111.22',
    paths: [filePath],
  });

  assert.deepEqual(result, [{ path: filePath, fileId: 'F123' }]);
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].channel_id, 'C123');
  assert.equal(uploadCalls[0].thread_ts, '111.22');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('slack-lazy-uploader-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /slack-lazy-uploader-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
