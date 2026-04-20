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
store.put('thread-1', { sessionId: 'sess-a', systemPrompt: 'prompt-a' });
assert.deepEqual(store.get('thread-1'), { sessionId: 'sess-a', systemPrompt: 'prompt-a' });

// upsert overwrites
store.put('thread-1', { sessionId: 'sess-b', systemPrompt: 'prompt-b' });
assert.deepEqual(store.get('thread-1'), { sessionId: 'sess-b', systemPrompt: 'prompt-b' });

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

test('legacy sessions.json is migrated into the store and renamed to .bak', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-store-'));
  const claudeclawDir = path.join(homeDir, '.claudeclaw');
  fs.mkdirSync(claudeclawDir, { recursive: true });
  const legacy = path.join(claudeclawDir, 'sessions.json');
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      'slack:C1:111.22': 'legacy-session-a',
      'telegram:123': 'legacy-session-b',
    }),
  );

  try {
    const dbPath = path.join(claudeclawDir, 'claudeclaw.db');
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

const a = store.get('slack:C1:111.22');
assert.deepEqual(a, { sessionId: 'legacy-session-a', systemPrompt: '' });

const b = store.get('telegram:123');
assert.deepEqual(b, { sessionId: 'legacy-session-b', systemPrompt: '' });

store.close();
console.log('legacy-migration-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /legacy-migration-ok/);
    assert.equal(fs.existsSync(legacy), false, 'legacy file should be removed');
    assert.equal(fs.existsSync(`${legacy}.bak`), true, 'legacy file should be renamed to .bak');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('store opens idempotently without legacy file', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-store-'));
  const claudeclawDir = path.join(homeDir, '.claudeclaw');
  fs.mkdirSync(claudeclawDir, { recursive: true });
  const dbPath = path.join(claudeclawDir, 'claudeclaw.db');

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
store.put('k1', { sessionId: 's1', systemPrompt: 'p1' });
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
assert.deepEqual(store.get('k1'), { sessionId: 's1', systemPrompt: 'p1' });
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
