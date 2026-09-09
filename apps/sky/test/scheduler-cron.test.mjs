import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCronExpr, nextCronRun } from '../dist/scheduler/cron.js';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';
import { createScheduledJobScheduler } from '../dist/scheduler/loop.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';
import { createSchedulerConversationManager } from './helpers/scheduler.mjs';

test('nextCronRun computes the next daily 08:30 KST occurrence', () => {
  const after = Date.parse('2026-07-20T00:00:00+09:00');
  const next = nextCronRun('30 8 * * *', 'Asia/Seoul', after);
  // 08:30 KST == 23:30 UTC previous day
  assert.equal(new Date(next).toISOString(), '2026-07-19T23:30:00.000Z');
});

test('nextCronRun rolls forward to the next day when the time has passed', () => {
  const after = Date.parse('2026-07-20T09:00:00+09:00');
  const next = nextCronRun('30 8 * * *', 'Asia/Seoul', after);
  assert.equal(new Date(next).toISOString(), '2026-07-20T23:30:00.000Z');
});

test('isValidCronExpr accepts standard expressions and rejects garbage', () => {
  assert.equal(isValidCronExpr('30 8 * * *'), true);
  assert.equal(isValidCronExpr('*/15 * * * 1-5'), true);
  assert.equal(isValidCronExpr('bogus'), false);
});

test('claimDueCron claims due cron jobs once and rearmCron reschedules them', () => {
  const store = openScheduledJobStore(':memory:');
  store.create({
    id: 'cron-1',
    title: '아침 브리핑',
    kind: 'cron',
    nextRunAt: 1_000,
    cronExpr: '30 8 * * *',
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: 'brief',
    createdAt: 500,
  });

  const claimed = store.claimDueCron(1_000);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'running');
  assert.equal(claimed[0].cronExpr, '30 8 * * *');
  // A claimed (running) job is not claimed again.
  assert.deepEqual(store.claimDueCron(1_000), []);

  assert.equal(store.rearmCron('cron-1', 2_000, null), true);
  const job = store.list()[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.nextRunAt, 2_000);
  assert.equal(job.runCount, 1);

  store.close();
});

test('scheduler tick dispatches a due cron job and re-arms it for the next day', async () => {
  const store = openScheduledJobStore(':memory:');
  const firstRun = Date.parse('2026-07-20T08:30:00+09:00');
  store.create({
    id: 'cron-1',
    title: '아침 브리핑',
    kind: 'cron',
    nextRunAt: firstRun,
    cronExpr: '30 8 * * *',
    timezone: 'Asia/Seoul',
    targetChannel: 'C1',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: 'brief',
    createdAt: firstRun - 1_000,
  });

  const posts = [];
  const { manager } = createSchedulerConversationManager({ finalText: '브리핑' });
  const dispatcher = createScheduledJobDispatcher({
    mainAgent: { name: 'main', systemPrompt: 'system' },
    conversationManager: manager,
    postMessage: async (message) => posts.push(message),
  });
  const scheduler = createScheduledJobScheduler({ store, dispatcher, now: () => firstRun });

  await scheduler.tick();

  assert.deepEqual(posts, [{ channel: 'C1', text: '브리핑' }]);
  const job = store.list()[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.kind, 'cron');
  // Advanced to the next day's 08:30 KST occurrence.
  assert.equal(new Date(job.nextRunAt).toISOString(), '2026-07-20T23:30:00.000Z');

  // Ticking again at the same instant must not double-post.
  await scheduler.tick();
  assert.equal(posts.length, 1);

  await manager.closeAll();
  store.close();
});

test('cron schedule survives a failed run and still re-arms', async () => {
  const store = openScheduledJobStore(':memory:');
  const firstRun = Date.parse('2026-07-20T08:30:00+09:00');
  store.create({
    id: 'cron-1',
    title: '아침 브리핑',
    kind: 'cron',
    nextRunAt: firstRun,
    cronExpr: '30 8 * * *',
    timezone: 'Asia/Seoul',
    targetChannel: 'C1',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: 'brief',
    createdAt: firstRun - 1_000,
  });

  const posts = [];
  const { manager } = createSchedulerConversationManager({ error: new Error('agent down') });
  const dispatcher = createScheduledJobDispatcher({
    mainAgent: { name: 'main', systemPrompt: 'system' },
    conversationManager: manager,
    postMessage: async (message) => posts.push(message),
  });
  const scheduler = createScheduledJobScheduler({ store, dispatcher, now: () => firstRun });

  await scheduler.tick();

  const job = store.list()[0];
  // Still scheduled for the next day despite the failure.
  assert.equal(job.status, 'pending');
  assert.equal(new Date(job.nextRunAt).toISOString(), '2026-07-20T23:30:00.000Z');
  assert.match(job.lastError, /agent down/);
  // A failure notice was posted.
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /아침 브리핑/);

  await manager.closeAll();
  store.close();
});
