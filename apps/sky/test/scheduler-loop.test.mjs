import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';
import { createScheduledJobScheduler } from '../dist/scheduler/loop.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';
import { createSchedulerConversationManager } from './helpers/scheduler.mjs';
import { createRuntimeController } from '../dist/runtime/controller.js';

function createJob(store, overrides = {}) {
  return store.create({
    id: 'job-1',
    title: '여권 챙기기',
    kind: 'once',
    nextRunAt: 1_000,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: '여권을 챙기라고 알려줘',
    createdAt: 500,
    ...overrides,
  });
}

function createDispatcher(posts, agentResult) {
  const { manager } = createSchedulerConversationManager(agentResult);
  return {
    manager,
    dispatcher: createScheduledJobDispatcher({
      mainAgent: { name: 'main', systemPrompt: 'system' },
      conversationManager: manager,
      postMessage: async (message) => posts.push(message),
    }),
  };
}

test('scheduler does not claim or dispatch jobs after drain begins', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, { finalText: '보내지 않음' });
  const runtimeController = createRuntimeController({ supervisionMode: 'launchd' });
  assert.equal(runtimeController.requestRestart().ok, true);
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => 1_000,
    runtimeController,
  });

  await scheduler.tick();

  assert.deepEqual(posts, []);
  assert.equal(store.list()[0].status, 'pending');
  await manager.closeAll();
  store.close();
});

test('scheduler tick dispatches a due reminder once and marks it done', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, {
    finalText: '여권을 챙기세요.',
  });
  const scheduler = createScheduledJobScheduler({ store, dispatcher, now: () => 1_000 });

  await scheduler.tick();
  await scheduler.tick();

  assert.deepEqual(posts, [{ channel: 'D123', text: '여권을 챙기세요.' }]);
  assert.deepEqual(store.list().map(({ status, runCount, lastRunAt }) => ({
    status,
    runCount,
    lastRunAt,
  })), [
    { status: 'done', runCount: 1, lastRunAt: 1_000 },
  ]);

  await manager.closeAll();
  store.close();
});

test('scheduler retries a failed reminder three times before reporting failure', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, {
    error: new Error('agent unavailable'),
  });
  let currentTime = 1_000;
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => currentTime,
  });

  await scheduler.tick();
  assert.deepEqual(store.list().map(({ status, nextRunAt, runCount, lastError }) => ({
    status,
    nextRunAt,
    runCount,
    lastError,
  })), [
    {
      status: 'pending',
      nextRunAt: 61_000,
      runCount: 1,
      lastError: 'agent unavailable',
    },
  ]);

  currentTime = 61_000;
  await scheduler.tick();
  currentTime = 121_000;
  await scheduler.tick();

  assert.equal(store.list()[0].status, 'failed');
  assert.equal(store.list()[0].runCount, 3);
  assert.equal(store.list()[0].lastError, 'agent unavailable');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].channel, 'D123');
  assert.match(posts[0].text, /여권 챙기기/);
  assert.match(posts[0].text, /3회/);

  await manager.closeAll();
  store.close();
});

test('scheduler start skips reminders missed while offline', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store, { id: 'missed', nextRunAt: 999 });
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, { finalText: '새 리마인더' });
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => 1_000,
    setInterval: () => ({ id: 'timer' }),
    clearInterval: () => undefined,
  });

  await scheduler.start();

  assert.equal(store.list()[0].status, 'done');
  assert.equal(store.list()[0].runCount, 0);
  assert.deepEqual(posts, []);
  await scheduler.stop();

  await manager.closeAll();
  store.close();
});

test('scheduler start and stop manage a 30 second ticker', async () => {
  const store = openScheduledJobStore(':memory:');
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, { finalText: 'unused' });
  const intervals = [];
  const cleared = [];
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => 1_000,
    setInterval: (callback, milliseconds) => {
      const handle = { callback, milliseconds };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  });

  await scheduler.start();
  await scheduler.stop();

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 30_000);
  assert.deepEqual(cleared, [intervals[0]]);

  await manager.closeAll();
  store.close();
});

test('scheduler start fails a stale interrupted reminder without redelivery', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  store.claimDue(1_000);
  const posts = [];
  const { dispatcher, manager } = createDispatcher(posts, {
    error: new Error('must not redeliver'),
  });
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => 3_602_000,
    setInterval: () => ({ id: 'timer' }),
    clearInterval: () => undefined,
  });

  await scheduler.start();

  assert.equal(store.list()[0].status, 'failed');
  assert.match(store.list()[0].lastError, /restart/i);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'D123');
  assert.match(posts[0].text, /여권 챙기기/);

  await scheduler.stop();
  await manager.closeAll();
  store.close();
});
