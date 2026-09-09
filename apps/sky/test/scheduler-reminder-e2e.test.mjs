import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMainAgentConfig } from '../dist/agents/main.js';
import { createScheduledJobDispatcher } from '../dist/scheduler/dispatcher.js';
import { createScheduledJobScheduler } from '../dist/scheduler/loop.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';
import { createSchedulerConversationManager } from './helpers/scheduler.mjs';

test('next Monday 09:00 KST reminder survives restart and initiates a Slack DM', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sky-reminder-e2e-'));
  const dbPath = path.join(directory, 'sky.db');
  let store = openScheduledJobStore(dbPath);
  let scheduler;
  let manager;

  try {
    const registrationAgent = createMainAgentConfig({
      systemPrompt: 'system',
      scheduledJobStore: store,
      schedulerClock: () => Date.parse('2026-07-18T12:00:00+09:00'),
      schedulerIdFactory: () => 'international-license',
    });
    const scheduleReminder = registrationAgent
      .customToolsFactory({ sessionKey: 'D123:1784330000.000000' })
      .find((tool) => tool.name === 'schedule_reminder');

    const registration = await scheduleReminder.execute({
      when: '2026-07-20T09:00:00+09:00',
      title: '국제운전면허증 신청',
      prompt: '국제운전면허증 발급을 신청하라고 알려줘',
    });
    assert.deepEqual(registration.details, {
      id: 'international-license',
      title: '국제운전면허증 신청',
      when: '2026-07-20T00:00:00.000Z',
      timezone: 'Asia/Seoul',
      channelId: 'D123',
    });

    store.close();
    store = openScheduledJobStore(dbPath);

    const conversation = createSchedulerConversationManager({
      finalText: '국제운전면허증 발급을 신청할 시간입니다.',
    });
    manager = conversation.manager;
    const posts = [];
    const dispatcher = createScheduledJobDispatcher({
      mainAgent: createMainAgentConfig({
        systemPrompt: 'system',
        scheduledJobStore: store,
      }),
      conversationManager: manager,
      postMessage: async (message) => posts.push(message),
    });
    let currentTime = Date.parse('2026-07-20T08:59:00+09:00');
    scheduler = createScheduledJobScheduler({
      store,
      dispatcher,
      now: () => currentTime,
      setInterval: () => ({ id: 'timer' }),
      clearInterval: () => undefined,
    });

    await scheduler.start();
    currentTime = Date.parse('2026-07-20T09:00:00+09:00');
    await scheduler.tick();

    assert.deepEqual(posts, [
      {
        channel: 'D123',
        text: '국제운전면허증 발급을 신청할 시간입니다.',
      },
    ]);
    assert.equal(store.list()[0].status, 'done');
    assert.equal(store.list()[0].runCount, 1);
  } finally {
    await scheduler?.stop();
    await manager?.closeAll();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
