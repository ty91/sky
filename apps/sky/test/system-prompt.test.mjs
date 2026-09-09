import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSystemPrompt } from '../dist/bot.js';

async function withTempWorkspace(fn) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sky-prompt-'));
  try {
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('loadSystemPrompt assembles workspace prompt files in configured order', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, 'MEMORY.md'), 'memory', 'utf8');
    await writeFile(path.join(workspace, 'AGENTS.md'), 'agents', 'utf8');
    await writeFile(path.join(workspace, 'SOUL.md'), 'soul', 'utf8');
    await writeFile(path.join(workspace, 'USER.md'), 'user', 'utf8');

    assert.equal(loadSystemPrompt(workspace), 'soul\n\nagents\n\nuser\n\nmemory');
  });
});

test('loadSystemPrompt skips missing files without changing loaded file order', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, 'MEMORY.md'), 'memory', 'utf8');
    await writeFile(path.join(workspace, 'SOUL.md'), 'soul', 'utf8');

    assert.equal(loadSystemPrompt(workspace), 'soul\n\nmemory');
  });
});
