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

function sequentialIds(prefix) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function openTestStore(location = ':memory:') {
  return openScheduledJobStore(location, {
    createRunId: sequentialIds('run'),
    createConversationId: sequentialIds('conversation'),
  });
}

function createJob(store, id, { kind = 'once', nextRunAt = 1_000, cronExpr } = {}) {
  return store.create({
    id,
    title: id,
    kind,
    nextRunAt,
    ...(cronExpr ? { cronExpr } : {}),
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: id,
    createdAt: 500,
  });
}

function runSummary(run) {
  return {
    id: run.id,
    conversationId: run.conversationId,
    scheduledFor: run.scheduledFor,
    status: run.status,
    attempts: run.attempts,
    finished: run.finishedAt !== null,
    lastError: run.lastError,
  };
}

test('scheduled job store atomically claims each due reminder once', () => {
  const store = openTestStore();
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

  assert.deepEqual([store.claim('due', 1_000)], [
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
      run: {
        id: 'run-1',
        jobId: 'due',
        conversationId: 'conversation-1',
        scheduledFor: 1_000,
        status: 'running',
        attempts: 1,
        startedAt: 1_000,
        updatedAt: 1_000,
        finishedAt: null,
        lastError: null,
      },
    },
  ]);
  assert.equal(store.claim('due', 1_000), undefined);
  assert.equal(store.claim('future', 1_000), undefined);
  assert.equal(store.list().find((job) => job.id === 'future').status, 'pending');
  assert.equal(store.list().find((job) => job.id === 'cron').status, 'pending');

  store.close();
});

test('a retried one-shot reminder resumes its open run and conversation until it finishes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sky-scheduler-runs-'));
  const dbPath = path.join(directory, 'sky.db');
  let store = openTestStore(dbPath);
  try {
    createJob(store, 'once');
    const first = store.claim('once', 1_000);
    assert.equal(store.recordFailure('once', 'model overloaded', 2_000, 3), 'retrying');
    assert.deepEqual(store.listRuns('once').map(runSummary), [{
      id: 'run-1', conversationId: 'conversation-1', scheduledFor: 1_000,
      status: 'retrying', attempts: 1, finished: false, lastError: 'model overloaded',
    }]);

    store.close();
    store = openTestStore(dbPath);

    const retried = store.claim('once', 2_000);
    assert.equal(retried.run.id, first.run.id);
    assert.equal(retried.run.conversationId, first.run.conversationId);
    assert.equal(retried.run.attempts, 2);
    assert.equal(retried.run.status, 'running');
    assert.equal(store.markDone('once'), true);

    assert.deepEqual(store.listRuns('once').map(runSummary), [{
      id: 'run-1', conversationId: 'conversation-1', scheduledFor: 1_000,
      status: 'succeeded', attempts: 2, finished: true, lastError: null,
    }]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a reminder that exhausts its attempts or fails delivery finishes its run as failed', () => {
  const store = openTestStore();
  createJob(store, 'exhausted');
  createJob(store, 'undelivered');

  store.claim('exhausted', 1_000);
  assert.equal(store.recordFailure('exhausted', 'first', 2_000, 2), 'retrying');
  store.claim('exhausted', 2_000);
  assert.equal(store.recordFailure('exhausted', 'second', 3_000, 2), 'failed');
  store.claim('undelivered', 1_000);
  assert.equal(store.recordFailure('undelivered', 'Slack send failed', 2_000, 0), 'failed');

  assert.deepEqual(store.listRuns('exhausted').map(runSummary), [{
    id: 'run-1', conversationId: 'conversation-1', scheduledFor: 1_000,
    status: 'failed', attempts: 2, finished: true, lastError: 'second',
  }]);
  assert.deepEqual(store.listRuns('undelivered').map(({ status, finishedAt }) => ({ status, finished: finishedAt !== null })), [
    { status: 'failed', finished: true },
  ]);
  assert.equal(store.claim('exhausted', 5_000), undefined);
  store.close();
});

test('each cron occurrence gets its own run and conversation', () => {
  const store = openTestStore();
  createJob(store, 'daily', { kind: 'cron', cronExpr: '0 9 * * *' });

  const first = store.claim('daily', 1_000);
  assert.equal(store.rearmCron('daily', 5_000), true);
  const second = store.claim('daily', 5_000);
  assert.equal(store.rearmCron('daily', 9_000, 'Slack send failed'), true);

  assert.notEqual(second.run.id, first.run.id);
  assert.notEqual(second.run.conversationId, first.run.conversationId);
  assert.deepEqual(store.listRuns('daily').map(runSummary), [
    { id: 'run-1', conversationId: 'conversation-1', scheduledFor: 1_000, status: 'succeeded', attempts: 1, finished: true, lastError: null },
    { id: 'run-2', conversationId: 'conversation-2', scheduledFor: 5_000, status: 'failed', attempts: 1, finished: true, lastError: 'Slack send failed' },
  ]);
  store.close();
});

test('cancelling a reminder awaiting retry and failing a stale run close their open runs', () => {
  const store = openTestStore();
  createJob(store, 'cancelled');
  createJob(store, 'stale');

  store.claim('cancelled', 1_000);
  store.recordFailure('cancelled', 'model overloaded', 2_000, 3);
  assert.equal(store.cancel('cancelled'), true);
  store.claim('stale', 1_000);
  assert.deepEqual(store.failRunningBefore(1_500, 'stale after restart').map(({ id }) => id), ['stale']);

  assert.deepEqual(store.listRuns('cancelled').map(({ status, finishedAt }) => ({ status, finished: finishedAt !== null })), [
    { status: 'cancelled', finished: true },
  ]);
  assert.deepEqual(store.listRuns('stale').map(({ status, lastError }) => ({ status, lastError })), [
    { status: 'failed', lastError: 'stale after restart' },
  ]);
  store.close();
});
