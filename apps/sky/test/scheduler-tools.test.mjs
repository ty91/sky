import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainAgentConfig } from '../dist/agents/main.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';

test('main agent can schedule a reminder for the current Slack channel', async () => {
  const store = openScheduledJobStore(':memory:');
  const agent = createMainAgentConfig({
    systemPrompt: 'system',
    scheduledJobStore: store,
    schedulerClock: () => 1_700_000_000_000,
    schedulerIdFactory: () => 'job-1',
  });
  const tools = agent.customToolsFactory({ sessionKey: 'D123:1777901000.000000' });
  const schedule = tools.find((tool) => tool.name === 'schedule_reminder');

  const result = await schedule.execute({
    when: '2027-01-15T09:00:00+09:00',
    title: '국제운전면허증 신청',
    prompt: '국제운전면허증을 신청하라고 알려줘',
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /국제운전면허증 신청/);
  assert.deepEqual(result.details, {
    id: 'job-1',
    title: '국제운전면허증 신청',
    when: '2027-01-15T00:00:00.000Z',
    timezone: 'Asia/Seoul',
    channelId: 'D123',
  });
  const list = tools.find((tool) => tool.name === 'list_scheduled');
  assert.deepEqual((await list.execute({})).details, {
    jobs: [
      {
        id: 'job-1',
        title: '국제운전면허증 신청',
        when: '2027-01-15T00:00:00.000Z',
        timezone: 'Asia/Seoul',
        channelId: 'D123',
        status: 'pending',
      },
    ],
  });

  store.close();
});

test('main agent can list pending reminders', async () => {
  const store = openScheduledJobStore(':memory:');
  store.create({
    id: 'job-1',
    title: '여권 챙기기',
    kind: 'once',
    nextRunAt: 1_799_971_200_000,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: '여권을 챙기라고 알려줘',
    createdAt: 1_700_000_000_000,
  });
  const agent = createMainAgentConfig({ systemPrompt: 'system', scheduledJobStore: store });
  const list = agent
    .customToolsFactory({ sessionKey: 'D123:1777901000.000000' })
    .find((tool) => tool.name === 'list_scheduled');

  const result = await list.execute({});

  assert.match(result.content[0].text, /여권 챙기기/);
  assert.match(result.content[0].text, /2027-01-15T00:00:00.000Z/);
  assert.deepEqual(result.details, {
    jobs: [
      {
        id: 'job-1',
        title: '여권 챙기기',
        when: '2027-01-15T00:00:00.000Z',
        timezone: 'Asia/Seoul',
        channelId: 'D123',
        status: 'pending',
      },
    ],
  });

  store.close();
});

test('main agent can cancel a pending reminder', async () => {
  const store = openScheduledJobStore(':memory:');
  store.create({
    id: 'job-1',
    title: '여권 챙기기',
    kind: 'once',
    nextRunAt: 1_799_971_200_000,
    timezone: 'Asia/Seoul',
    targetChannel: 'D123',
    threadStrategy: 'new-root',
    deliveryMode: 'agent',
    prompt: '여권을 챙기라고 알려줘',
    createdAt: 1_700_000_000_000,
  });
  const agent = createMainAgentConfig({ systemPrompt: 'system', scheduledJobStore: store });
  const cancel = agent
    .customToolsFactory({ sessionKey: 'D123:1777901000.000000' })
    .find((tool) => tool.name === 'cancel_scheduled');
  const list = agent
    .customToolsFactory({ sessionKey: 'D123:1777901000.000000' })
    .find((tool) => tool.name === 'list_scheduled');

  const result = await cancel.execute({ id: 'job-1' });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /job-1/);
  assert.deepEqual(result.details, { id: 'job-1', cancelled: true });
  assert.deepEqual((await list.execute({})).details, { jobs: [] });

  const repeated = await cancel.execute({ id: 'job-1' });
  assert.equal(repeated.isError, true);
  assert.deepEqual(repeated.details, { id: 'job-1', cancelled: false });

  store.close();
});
