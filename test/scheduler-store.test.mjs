import test from 'node:test';
import assert from 'node:assert/strict';
import { openScheduledJobStore } from '../dist/scheduler/store.js';

test('scheduled job store persists one-shot reminders for later delivery', () => {
  const store = openScheduledJobStore(':memory:');

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

  assert.deepEqual(job, {
    id: 'job-1',
    title: '국제운전면허증 신청',
    kind: 'once',
    nextRunAt: 1_800_000_000_000,
    cronExpr: null,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: '국제운전면허증을 신청하라고 알려줘',
    status: 'pending',
    createdAt: 1_700_000_000_000,
    lastRunAt: null,
    runCount: 0,
    lastError: null,
  });
  assert.deepEqual(store.list(), [job]);

  store.close();
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
