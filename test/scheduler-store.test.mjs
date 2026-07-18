import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openScheduledJobStore } from '../dist/scheduler/store.js';

test('scheduled job store persists one-shot reminders for later delivery', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sky-scheduler-store-'));
  const dbPath = path.join(directory, 'sky.db');
  let store = openScheduledJobStore(dbPath);

  try {
    const job = store.create({
      id: 'job-1',
      title: '국제운전면허증 신청',
      kind: 'once',
      nextRunAt: 1_800_000_000_000,
      timezone: 'Asia/Seoul',
      targetChannel: 'D123',
      threadStrategy: 'new-root',
      deliveryMode: 'agent',
      prompt: '국제운전면허증을 신청하라고 알려줘',
      createdAt: 1_700_000_000_000,
    });

    store.close();
    store = openScheduledJobStore(dbPath);

    assert.deepEqual(store.list(), [job]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scheduled job store cancels a pending reminder once', () => {
  const store = openScheduledJobStore(':memory:');
  store.create({
    id: 'job-1',
    title: '여권 챙기기',
    kind: 'once',
    nextRunAt: 1_800_000_000_000,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: '여권을 챙기라고 알려줘',
    createdAt: 1_700_000_000_000,
  });

  assert.equal(store.cancel('job-1'), true);
  assert.equal(store.cancel('job-1'), false);
  assert.equal(store.cancel('missing'), false);
  assert.equal(store.list()[0].status, 'cancelled');

  store.close();
});

test('scheduled job store atomically claims each due reminder once', () => {
  const store = openScheduledJobStore(':memory:');
  for (const [id, kind, nextRunAt] of [
    ['due', 'once', 1_000],
    ['future', 'once', 1_001],
    ['cron', 'cron', 1_000],
  ]) {
    store.create({
      id,
      title: id,
      kind,
      nextRunAt,
      timezone: 'Asia/Seoul',
      targetChannel: 'D123',
      threadStrategy: 'new-root',
      deliveryMode: 'agent',
      prompt: id,
      createdAt: 500,
    });
  }

  assert.deepEqual(store.claimDue(1_000), [
    {
      id: 'due',
      title: 'due',
      kind: 'once',
      nextRunAt: 1_000,
      cronExpr: null,
      timezone: 'Asia/Seoul',
      targetChannel: 'D123',
      threadStrategy: 'new-root',
      deliveryMode: 'agent',
      prompt: 'due',
      status: 'running',
      createdAt: 500,
      lastRunAt: 1_000,
      runCount: 1,
      lastError: null,
    },
  ]);
  assert.deepEqual(store.claimDue(1_000), []);
  assert.equal(store.list().find((job) => job.id === 'future').status, 'pending');
  assert.equal(store.list().find((job) => job.id === 'cron').status, 'pending');

  store.close();
});

test('scheduled job store skips only overdue one-shot reminders', () => {
  const store = openScheduledJobStore(':memory:');
  for (const kind of ['once', 'cron']) {
    store.create({
      id: kind,
      title: kind,
      kind,
      nextRunAt: 999,
      timezone: 'Asia/Seoul',
      targetChannel: 'D123',
      threadStrategy: 'new-root',
      deliveryMode: 'agent',
      prompt: kind,
      createdAt: 500,
    });
  }

  assert.equal(store.skipOverdue(1_000), 1);
  assert.deepEqual(
    store.list().map(({ kind, status }) => ({ kind, status })),
    [
      { kind: 'cron', status: 'pending' },
      { kind: 'once', status: 'done' },
    ],
  );

  store.close();
});
