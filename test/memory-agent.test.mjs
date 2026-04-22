import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('memory agent processes unread transcripts and advances cursors', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joy-memory-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemoryAgent } from './dist/agents/memory/agent.js';

const joyDir = path.join(os.homedir(), '.joy');
const transcriptDir = path.join(joyDir, 'transcripts', 'chat-1');
fs.mkdirSync(transcriptDir, { recursive: true });

const transcriptBody = '### user\\\\n\\\\nhello\\\\n\\\\n';
fs.writeFileSync(path.join(transcriptDir, 'session-1.md'), transcriptBody, 'utf8');

const calls = { open: 0, send: 0, close: 0 };
const sessionManager = {
  open: () => { calls.open += 1; },
  send: async () => {
    calls.send += 1;
    return { kind: 'ok', text: 'memory summary' };
  },
  getSessionId: () => undefined,
  close: async () => { calls.close += 1; },
  closeAll: async () => {},
};

const first = await runMemoryAgent({ sessionManager, workspace: '/tmp/workspace' });
assert.deepEqual(first, {
  processed: 1,
  skipped: false,
  summary: 'memory summary',
});
assert.deepEqual(calls, { open: 1, send: 1, close: 1 });

const cursors = JSON.parse(fs.readFileSync(path.join(joyDir, 'memory-cursors.json'), 'utf8'));
assert.equal(cursors['chat-1/session-1.md'], Buffer.byteLength(transcriptBody));

const second = await runMemoryAgent({ sessionManager, workspace: '/tmp/workspace' });
assert.deepEqual(second, {
  processed: 0,
  skipped: true,
  summary: 'No new transcripts to process.',
});

console.log('memory-agent-test-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
        },
        encoding: 'utf8',
      },
    );

    assert.match(output, /memory-agent-test-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
