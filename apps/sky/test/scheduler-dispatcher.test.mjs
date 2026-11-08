import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackScheduledDispatcher as createScheduledJobDispatcher } from '../dist/slack/scheduled.js';
import { createSchedulerConversationManager } from './helpers/scheduler.mjs';

const JOB = {
  id: 'job-1',
  title: '국제운전면허증 신청',
  kind: 'once',
  nextRunAt: 1_799_971_200_000,
  cronExpr: null,
  timezone: 'Asia/Seoul',
  targetChannel: 'D123',
  threadStrategy: 'new-root',
  deliveryMode: 'agent',
  prompt: '국제운전면허증을 신청하라고 알려줘',
  status: 'running',
  createdAt: 1_700_000_000_000,
  lastRunAt: 1_799_971_200_000,
  runCount: 1,
  lastError: null,
  run: {
    id: 'run-1',
    jobId: 'job-1',
    conversationId: 'run-1-conversation',
    scheduledFor: 1_799_971_200_000,
    status: 'running',
    attempts: 1,
    startedAt: 1_799_971_200_000,
    updatedAt: 1_799_971_200_000,
    finishedAt: null,
    lastError: null,
  },
};

const DELIVERED_THREAD = { provider: 'slack', externalId: 'D123:1799971200.000100' };

test('scheduled job dispatcher wakes the agent and posts its final answer as a new Slack root', async () => {
  const posts = [];
  const mainAgent = { name: 'main', systemPrompt: 'system' };
  const { manager, prompts } = createSchedulerConversationManager({
    finalText: '신청할 시간입니다.',
  });
  const dispatcher = createScheduledJobDispatcher({
    mainAgent,
    conversationManager: manager,
    postMessage: async (message) => {
      posts.push(message);
    },
  });

  await dispatcher.dispatch(JOB);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /<system-reminder>/);
  assert.match(prompts[0], /국제운전면허증 신청/);
  assert.match(prompts[0], /국제운전면허증을 신청하라고 알려줘/);
  assert.deepEqual(posts, [{ channel: 'D123', text: '신청할 시간입니다.' }]);

  await manager.closeAll();
});

test('scheduled job dispatcher links the delivered thread to the run conversation so replies continue it', async () => {
  const mainAgent = { name: 'main', systemPrompt: 'system' };
  const { manager, sessions } = createSchedulerConversationManager({
    finalText: '신청할 시간입니다.',
  });
  const dispatcher = createScheduledJobDispatcher({
    mainAgent,
    conversationManager: manager,
    // Slack returns the ts of the posted root message; a reply's thread_ts is this value.
    postMessage: async () => ({ ok: true, ts: '1799971200.000100' }),
  });

  await dispatcher.dispatch(JOB);

  assert.deepEqual(sessions.map(({ conversation }) => conversation), [{ id: 'run-1-conversation', links: [] }]);
  assert.equal(manager.find(DELIVERED_THREAD), 'run-1-conversation');
  assert.equal(manager.has('run-1-conversation', mainAgent), true);
  assert.equal(manager.getHandle(manager.find(DELIVERED_THREAD), mainAgent).sessionId, 'scheduled-session');

  await manager.closeAll();
});

test('scheduled job dispatcher keeps an undelivered run conversation without a Slack link', async () => {
  const mainAgent = { name: 'main', systemPrompt: 'system' };
  const { manager } = createSchedulerConversationManager({
    finalText: '신청할 시간입니다.',
  });
  const dispatcher = createScheduledJobDispatcher({
    mainAgent,
    conversationManager: manager,
    postMessage: async () => undefined,
  });

  await dispatcher.dispatch(JOB);

  assert.deepEqual(manager.get('run-1-conversation')?.links, []);
  assert.equal(manager.has('run-1-conversation', mainAgent), true);
  assert.equal(manager.find(DELIVERED_THREAD), undefined);

  await manager.closeAll();
});

test('a retried attempt of the same run continues its conversation while a new run starts another', async () => {
  const mainAgent = { name: 'main', systemPrompt: 'system' };
  const { manager, prompts, sessions } = createSchedulerConversationManager({
    finalText: '신청할 시간입니다.',
    error: (attempt) => (attempt === 1 ? new Error('model overloaded') : undefined),
  });
  let delivered = 0;
  const dispatcher = createScheduledJobDispatcher({
    mainAgent,
    conversationManager: manager,
    postMessage: async () => ({ ok: true, ts: `1799971200.00010${++delivered}` }),
  });

  await assert.rejects(dispatcher.dispatch(JOB), /model overloaded/);
  await dispatcher.dispatch({ ...JOB, runCount: 2, run: { ...JOB.run, attempts: 2 } });
  await dispatcher.dispatch({ ...JOB, run: { ...JOB.run, id: 'run-2', conversationId: 'run-2-conversation' } });

  assert.equal(prompts.length, 3);
  assert.deepEqual(sessions.map(({ conversation }) => conversation.id), ['run-1-conversation', 'run-2-conversation']);
  assert.equal(manager.find({ provider: 'slack', externalId: 'D123:1799971200.000101' }), 'run-1-conversation');
  assert.equal(manager.find({ provider: 'slack', externalId: 'D123:1799971200.000102' }), 'run-2-conversation');

  await manager.closeAll();
});
