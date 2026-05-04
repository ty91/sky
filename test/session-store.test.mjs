import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('session store round-trips get/put/remove', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--disable-warning=ExperimentalWarning',
      '-e',
      `
import assert from 'node:assert/strict';
import { openSessionStore } from './dist/session/store.js';

const store = openSessionStore(':memory:');

// empty read returns undefined
assert.equal(store.get('missing'), undefined);

// put -> get
store.put('thread-1', {
  sessionId: 'sess-a',
  model: 'anthropic/claude-opus-4-7',
  systemPrompt: 'prompt-a',
});
assert.deepEqual(store.get('thread-1'), {
  sessionId: 'sess-a',
  model: 'anthropic/claude-opus-4-7',
  systemPrompt: 'prompt-a',
});

// upsert overwrites
store.put('thread-1', {
  sessionId: 'sess-b',
  model: 'anthropic/claude-sonnet-4-6',
  systemPrompt: 'prompt-b',
});
assert.deepEqual(store.get('thread-1'), {
  sessionId: 'sess-b',
  model: 'anthropic/claude-sonnet-4-6',
  systemPrompt: 'prompt-b',
});

// remove
store.remove('thread-1');
assert.equal(store.get('thread-1'), undefined);

store.close();
console.log('session-store-basic-ok');
      `,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.match(output, /session-store-basic-ok/);
});

test('legacy sessions.json is ignored after ACP migration', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-store-'));
  const skyDir = path.join(homeDir, '.sky');
  fs.mkdirSync(skyDir, { recursive: true });
  const legacy = path.join(skyDir, 'sessions.json');
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      'slack:C1:111.22': 'legacy-session-a',
      'telegram:123': 'legacy-session-b',
    }),
  );

  try {
    const dbPath = path.join(skyDir, 'sky.db');
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--disable-warning=ExperimentalWarning',
        '-e',
        `
import assert from 'node:assert/strict';
import { openSessionStore } from './dist/session/store.js';

const store = openSessionStore(${JSON.stringify(dbPath)});

assert.equal(store.get('slack:C1:111.22'), undefined);
assert.equal(store.get('telegram:123'), undefined);

store.close();
console.log('legacy-ignored-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /legacy-ignored-ok/);
    assert.equal(fs.existsSync(legacy), true, 'legacy file should be left untouched');
    assert.equal(fs.existsSync(`${legacy}.bak`), false, 'legacy file should not be renamed');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('store opens idempotently without legacy file', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-store-'));
  const skyDir = path.join(homeDir, '.sky');
  fs.mkdirSync(skyDir, { recursive: true });
  const dbPath = path.join(skyDir, 'sky.db');

  try {
    // First open + write
    let output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--disable-warning=ExperimentalWarning',
        '-e',
        `
import { openSessionStore } from './dist/session/store.js';
const store = openSessionStore(${JSON.stringify(dbPath)});
store.put('k1', { sessionId: 's1', model: 'anthropic/claude-opus-4-7', systemPrompt: 'p1' });
store.close();
console.log('first-open-ok');
        `,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.match(output, /first-open-ok/);

    // Reopen + read
    output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--disable-warning=ExperimentalWarning',
        '-e',
        `
import assert from 'node:assert/strict';
import { openSessionStore } from './dist/session/store.js';
const store = openSessionStore(${JSON.stringify(dbPath)});
assert.deepEqual(store.get('k1'), {
  sessionId: 's1',
  model: 'anthropic/claude-opus-4-7',
  systemPrompt: 'p1',
});
store.close();
console.log('reopen-ok');
        `,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.match(output, /reopen-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
