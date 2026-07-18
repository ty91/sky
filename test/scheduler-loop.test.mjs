import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';
import { createScheduledJobScheduler } from '../dist/scheduler/loop.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';

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

test('scheduler tick dispatches a due reminder once and marks it done', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  const posts = [];
  const dispatcher = createScheduledJobDispatcher({
    mainAgent: { name: 'main', systemPrompt: 'system' },
    conversationManager: {
      runTurn: async (_key, _agent, _text, options) => {
        await options.onFinal('여권을 챙기세요.');
        return {
          kind: 'ok',
          text: '여권을 챙기세요.',
          messages: ['여권을 챙기세요.'],
          handle: { sessionId: 'scheduled-session-1' },
        };
      },
    },
    postMessage: async (message) => posts.push(message),
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

  store.close();
});

test('scheduler retries a failed reminder three times before reporting failure', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store);
  const posts = [];
  const dispatcher = createScheduledJobDispatcher({
    mainAgent: { name: 'main', systemPrompt: 'system' },
    conversationManager: {
      runTurn: async () => ({ kind: 'error', error: new Error('agent unavailable') }),
    },
    postMessage: async (message) => posts.push(message),
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

  store.close();
});

test('scheduler start skips reminders missed while offline and starts a 30 second ticker', async () => {
  const store = openScheduledJobStore(':memory:');
  createJob(store, { id: 'missed', nextRunAt: 999 });
  const posts = [];
  const dispatcher = createScheduledJobDispatcher({
    mainAgent: { name: 'main', systemPrompt: 'system' },
    conversationManager: {
      runTurn: async (_key, _agent, _text, options) => {
        await options.onFinal('새 리마인더');
        return {
          kind: 'ok',
          text: '새 리마인더',
          messages: ['새 리마인더'],
          handle: { sessionId: 'scheduled-session-2' },
        };
      },
    },
    postMessage: async (message) => posts.push(message),
  });
  let currentTime = 1_000;
  const intervals = [];
  const cleared = [];
  const scheduler = createScheduledJobScheduler({
    store,
    dispatcher,
    now: () => currentTime,
    setInterval: (callback, milliseconds) => {
      const handle = { callback, milliseconds };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  });

  scheduler.start();

  assert.equal(store.list()[0].status, 'done');
  assert.equal(store.list()[0].runCount, 0);
  assert.deepEqual(posts, []);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 30_000);

  createJob(store, { id: 'new', nextRunAt: 1_100 });
  currentTime = 1_100;
  await scheduler.tick();
  await scheduler.stop();

  assert.deepEqual(posts, [{ channel: 'D123', text: '새 리마인더' }]);
  assert.deepEqual(cleared, [intervals[0]]);

  store.close();
});
