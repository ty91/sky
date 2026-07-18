import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';
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
};

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
