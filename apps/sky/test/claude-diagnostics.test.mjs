import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLAUDE_DEBUG_LOG_NAME,
  createSkydClaudeDiagnostics,
} from '../dist/skyd/claude-diagnostics.js';
import { createJsonlLogger } from '../dist/skyd/logger.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';

test('Claude debug output is opt-in, private, and bounded', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'sky-claude-diagnostics-'));
  const paths = createSkyHome({ homeDir });
  const debugFile = path.join(paths.logsDir, CLAUDE_DEBUG_LOG_NAME);
  try {
    prepareSkyHome(paths);
    const logger = createJsonlLogger(paths.logFile);
    const disabled = createSkydClaudeDiagnostics({
      paths,
      logger,
      supervisionMode: 'launchd',
      env: {},
    });
    assert.equal(disabled.debugStderr, undefined);
    await assert.rejects(stat(debugFile), { code: 'ENOENT' });

    const enabled = createSkydClaudeDiagnostics({
      paths,
      logger,
      supervisionMode: 'launchd',
      env: { SKY_CLAUDE_DIAGNOSTICS: '1' },
      maxDebugBytes: 16,
    });
    enabled.debugStderr('0123456789');
    enabled.debugStderr('abcdefghijklmnop');

    assert.equal((await stat(debugFile)).mode & 0o777, 0o600);
    assert.equal(await readFile(debugFile, 'utf8'), '0123456789abcdef');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
