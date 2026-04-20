import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dateKeyKst,
  getYesterdayKey,
  koreanDayOfWeek,
  kstDayRangeUtc,
  nowIsoKst,
} from '../dist/agents/dream/date.js';
import {
  extractEntriesInRange,
  parseTranscriptFile,
  renderEntriesForPrompt,
} from '../dist/agents/dream/transcripts.js';
import { runDreamAgent } from '../dist/agents/dream/agent.js';

test('dateKeyKst returns the KST calendar date for a given instant', () => {
  // 2026-04-20T01:00:00Z === 2026-04-20 10:00 KST
  assert.equal(dateKeyKst(new Date('2026-04-20T01:00:00Z')), '2026-04-20');
  // 2026-04-19T15:00:00Z === 2026-04-20 00:00 KST exactly
  assert.equal(dateKeyKst(new Date('2026-04-19T15:00:00Z')), '2026-04-20');
  // 2026-04-19T14:59:59Z === 2026-04-19 23:59:59 KST
  assert.equal(dateKeyKst(new Date('2026-04-19T14:59:59Z')), '2026-04-19');
});

test('getYesterdayKey returns the prior KST date', () => {
  // now = 2026-04-20 02:00 KST → yesterday = 2026-04-19
  assert.equal(getYesterdayKey(new Date('2026-04-19T17:00:00Z')), '2026-04-19');
  // now = 2026-04-20 00:05 KST → yesterday = 2026-04-19
  assert.equal(getYesterdayKey(new Date('2026-04-19T15:05:00Z')), '2026-04-19');
  // now = 2026-04-20 23:59 KST → yesterday = 2026-04-19
  assert.equal(getYesterdayKey(new Date('2026-04-20T14:59:00Z')), '2026-04-19');
});

test('kstDayRangeUtc returns correct [start, end) for KST calendar day', () => {
  const { startUtc, endUtc } = kstDayRangeUtc('2026-04-19');
  assert.equal(startUtc.toISOString(), '2026-04-18T15:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-04-19T15:00:00.000Z');
});

test('kstDayRangeUtc rejects invalid date keys', () => {
  assert.throws(() => kstDayRangeUtc('04-19'));
  assert.throws(() => kstDayRangeUtc('2026-4-19'));
  assert.throws(() => kstDayRangeUtc('nope'));
});

test('koreanDayOfWeek returns 일/월/... label matching KST weekday', () => {
  // 2026-04-20 is Monday
  assert.equal(koreanDayOfWeek('2026-04-20'), '월');
  // 2026-04-19 is Sunday
  assert.equal(koreanDayOfWeek('2026-04-19'), '일');
  // 2026-04-25 is Saturday
  assert.equal(koreanDayOfWeek('2026-04-25'), '토');
});

test('nowIsoKst emits ISO 8601 with +09:00 offset', () => {
  const iso = nowIsoKst(new Date('2026-04-20T01:00:00Z'));
  assert.equal(iso, '2026-04-20T10:00:00+09:00');
});

test('parseTranscriptFile extracts role/timestamp/text entries', () => {
  const content =
    '### user (2026-04-19T07:30:00.000Z)\n\nhello there\n\n' +
    '### assistant (2026-04-19T07:31:00.000Z)\n\nhi!\n\n';
  const entries = parseTranscriptFile('chat1', 'sess1', content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[0].text, 'hello there');
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[1].text, 'hi!');
  assert.equal(entries[0].chatId, 'chat1');
  assert.equal(entries[0].sessionId, 'sess1');
});

test('extractEntriesInRange filters by [startUtc, endUtc) and sorts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-transcripts-'));
  try {
    const chatDir = path.join(tmp, 'chat1');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, 'sess1.md'),
      '### user (2026-04-18T14:00:00.000Z)\n\nbefore window\n\n' +
        '### user (2026-04-18T15:00:00.000Z)\n\nstart boundary (included)\n\n' +
        '### assistant (2026-04-19T03:00:00.000Z)\n\nmid day\n\n' +
        '### user (2026-04-19T15:00:00.000Z)\n\nend boundary (excluded)\n\n',
      'utf8',
    );
    // Second chat with an entry inside the window.
    const chatDir2 = path.join(tmp, 'chat2');
    fs.mkdirSync(chatDir2, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir2, 'sess2.md'),
      '### user (2026-04-19T00:30:00.000Z)\n\nearly morning\n\n',
      'utf8',
    );

    const { startUtc, endUtc } = kstDayRangeUtc('2026-04-19');
    const entries = extractEntriesInRange(startUtc, endUtc, tmp);

    // Expected: 3 entries (start boundary, early morning, mid day) — end boundary excluded.
    assert.equal(entries.length, 3);
    // Sorted chronologically.
    assert.deepEqual(
      entries.map((e) => e.text),
      ['start boundary (included)', 'early morning', 'mid day'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderEntriesForPrompt includes HH:MM KST, role, chat/session markers', () => {
  const entries = [
    {
      chatId: 'chat1',
      sessionId: 'sess1',
      role: 'user',
      timestampIso: '2026-04-19T07:30:00.000Z',
      timestamp: new Date('2026-04-19T07:30:00.000Z'),
      text: 'hi',
    },
  ];
  const rendered = renderEntriesForPrompt(entries);
  // 07:30 UTC = 16:30 KST
  assert.match(rendered, /### user \[16:30 KST\] \(chat=chat1, session=sess1\)/);
  assert.match(rendered, /\nhi\n/);
});

test('runDreamAgent uses yesterday by default and calls both steps', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-run-'));
  try {
    // Put one entry inside yesterday's KST window so we are NOT on the quiet-day path.
    const yesterdayKey = getYesterdayKey();
    const { startUtc } = kstDayRangeUtc(yesterdayKey);
    const oneHourIn = new Date(startUtc.getTime() + 60 * 60 * 1000);

    const chatDir = path.join(tmp, 'chat-1');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, 'sess-1.md'),
      `### user (${oneHourIn.toISOString()})\n\nhey\n\n`,
      'utf8',
    );

    const calls = [];
    const sessionManager = {
      open: (key) => calls.push(['open', key]),
      send: async (key) => {
        calls.push(['send', key]);
        return { kind: 'ok', text: `ok:${key}` };
      },
      getSessionId: () => undefined,
      close: async (key) => calls.push(['close', key]),
      closeAll: async () => {},
    };

    const result = await runDreamAgent({
      sessionManager,
      workspace: '/tmp/workspace',
      transcriptsDir: tmp,
    });

    assert.equal(result.targetDate, yesterdayKey);
    assert.equal(result.entryCount, 1);
    assert.equal(result.quietDay, false);
    assert.equal(result.summarize?.summary, 'ok:dream:summarize');
    assert.equal(result.knowledge?.summary, 'ok:dream:knowledge');

    // Two steps, each open/send/close.
    assert.deepEqual(calls, [
      ['open', 'dream:summarize'],
      ['send', 'dream:summarize'],
      ['close', 'dream:summarize'],
      ['open', 'dream:knowledge'],
      ['send', 'dream:knowledge'],
      ['close', 'dream:knowledge'],
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runDreamAgent preflight-deletes existing daily file before Step 1', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-preflight-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-workspace-'));
  try {
    // Put an existing daily file on disk in the workspace.
    const dailyDir = path.join(workspace, 'memory', 'episodes', 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const targetFile = path.join(dailyDir, '2026-04-19.md');
    fs.writeFileSync(targetFile, '# stale previous summary\n', 'utf8');
    assert.ok(fs.existsSync(targetFile));

    const sessionManager = {
      open: () => {},
      send: async () => ({ kind: 'ok', text: 'ok' }),
      getSessionId: () => undefined,
      close: async () => {},
      closeAll: async () => {},
    };

    await runDreamAgent({
      sessionManager,
      workspace,
      targetDate: '2026-04-19',
      transcriptsDir: tmp,
      onlyStep: 'summarize', // only the step that performs the unlink
    });

    // Preflight should have removed the stale file before Step 1 ran.
    assert.equal(fs.existsSync(targetFile), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runDreamAgent marks quiet day when there are no entries', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-quiet-'));
  try {
    const sessionManager = {
      open: () => {},
      send: async () => ({ kind: 'ok', text: 'ok' }),
      getSessionId: () => undefined,
      close: async () => {},
      closeAll: async () => {},
    };

    const result = await runDreamAgent({
      sessionManager,
      workspace: '/tmp/workspace',
      targetDate: '2026-04-19',
      transcriptsDir: tmp,
    });

    assert.equal(result.entryCount, 0);
    assert.equal(result.quietDay, true);
    // Both steps still run (quiet-day handling happens via the prompt,
    // not by skipping the step call).
    assert.ok(result.summarize?.ran);
    assert.ok(result.knowledge?.ran);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runDreamAgent respects onlyStep', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-onlystep-'));
  try {
    const calls = [];
    const sessionManager = {
      open: (key) => calls.push(['open', key]),
      send: async (key) => {
        calls.push(['send', key]);
        return { kind: 'ok', text: `ok:${key}` };
      },
      getSessionId: () => undefined,
      close: async (key) => calls.push(['close', key]),
      closeAll: async () => {},
    };

    const result = await runDreamAgent({
      sessionManager,
      workspace: '/tmp/workspace',
      targetDate: '2026-04-19',
      transcriptsDir: tmp,
      onlyStep: 'summarize',
    });

    assert.ok(result.summarize?.ran);
    assert.equal(result.knowledge, undefined);
    assert.deepEqual(
      calls.map((c) => c[1]),
      ['dream:summarize', 'dream:summarize', 'dream:summarize'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
