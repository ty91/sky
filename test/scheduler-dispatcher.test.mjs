import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';

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
  const runTurns = [];
  const posts = [];
  const mainAgent = { name: 'main', systemPrompt: 'system' };
  const dispatcher = createScheduledJobDispatcher({
    mainAgent,
    conversationManager: {
      runTurn: async (key, agent, text, options) => {
        runTurns.push({ key, agent, text });
        await options.onFinal('신청할 시간입니다.');
        return {
          kind: 'ok',
          text: '신청할 시간입니다.',
          messages: ['신청할 시간입니다.'],
          handle: { sessionId: 'scheduled-session-1' },
        };
      },
    },
    postMessage: async (message) => {
      posts.push(message);
    },
  });

  await dispatcher.dispatch(JOB);

  assert.equal(runTurns.length, 1);
  assert.equal(runTurns[0].key, 'scheduled:job-1');
  assert.equal(runTurns[0].agent, mainAgent);
  assert.match(runTurns[0].text, /<system-reminder>/);
  assert.match(runTurns[0].text, /국제운전면허증 신청/);
  assert.match(runTurns[0].text, /국제운전면허증을 신청하라고 알려줘/);
  assert.deepEqual(posts, [{ channel: 'D123', text: '신청할 시간입니다.' }]);
});
