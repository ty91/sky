import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguration } from '../dist/configuration.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';
import { openScheduledJobStore } from '../dist/scheduler/store.js';
import { startSkyd } from './helpers/start-skyd.mjs';
import { createSlackSdk } from './helpers/slack-sdk.mjs';
import { getDaemonStatus } from '../dist/skyd/control-uds.js';

async function eventually(assertion) {
  for (let attempt = 0; ; attempt += 1) {
    try { await assertion(); return; } catch (error) {
      if (attempt === 200) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function reminder(id, nextRunAt, overrides = {}) {
  return {
    id, title: id, kind: 'once', nextRunAt, timezone: 'Asia/Seoul',
    targetChannel: 'D123', threadStrategy: 'new-root', deliveryMode: 'agent',
    prompt: id, createdAt: nextRunAt - 1000, ...overrides,
  };
}

function createAgentSdk(prompts) {
  return Object.assign(async ({ key, resume, agent }) => {
    let listener;
    return {
      sessionId: resume?.sessionId ?? `session-${key}`,
      async prompt(text) {
        prompts.push(text);
        const tools = agent.customToolsFactory?.({ sessionKey: key }) ?? [];
        const final = `reminder:${tools.map(({ name }) => name).join(',')}`;
        listener?.({ type: 'assistant_message', text: final });
        listener?.({ type: 'turn_end', text: final });
      },
      async abort() {}, dispose() {},
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    };
  }, { backend: 'pi' });
}

test('a daemon preserves overdue one-shot reminders across offline restarts and skips missed cron occurrences', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-scheduler-recovery-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const configuration = createConfiguration(skyHome, { env: {} });
  configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test' });
  configuration.setSecret('slack.botToken', 'xoxb-test');
  configuration.setSecret('slack.appToken', 'xapp-test');
  const store = openScheduledJobStore(skyHome);
  let now = Date.parse('2026-09-09T00:10:00Z');
  store.create(reminder('interrupted', now - 3_600_001));
  store.claim('interrupted', now - 3_600_001);
  store.create(reminder('once', now - 60_000));
  store.create(reminder('cron', now - 60_000, { kind: 'cron', cronExpr: '* * * * *' }));
  let available = false;
  let tick;
  const posts = [];
  const prompts = [];
  const slack = createSlackSdk({
    authenticate: async () => { if (!available) throw new Error('offline'); return { user_id: 'U_SKY' }; },
    postMessage: async (message) => { posts.push(message); return { ts: '100.001' }; },
  });
  const options = {
    skyHome, configurationEnv: {}, backoff: { baseMs: 10, maxMs: 10, jitterRatio: 0 },
    runtimeDependencies: {
      slackSdk: slack.sdk, createSession: createAgentSdk(prompts),
      scheduler: { now: () => now, setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {} },
    },
  };
  let daemon = await startSkyd(options);
  try {
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).slack.state, 'retrying'));
    assert.equal(store.get('interrupted').status, 'failed');
    assert.match(store.get('interrupted').lastError, /not retried/);
    assert.equal(store.get('interrupted').runCount, 1);
    assert.equal(store.get('once').status, 'pending');
    assert.equal(store.get('once').runCount, 0);
    assert.equal(store.get('cron').runCount, 0);
    assert.deepEqual(prompts, []);
    await daemon.close();
    now += 60_000;
    daemon = await startSkyd(options);
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).runtime.state, 'ready'));
    available = true;
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).slack.state, 'connected'));
    assert.equal(store.get('once').status, 'pending');
    tick();
    await eventually(() => assert.equal(store.get('once').status, 'done'));
    assert.equal(store.get('once').runCount, 1);
    assert.equal(store.get('cron').runCount, 0);
    assert.equal(store.get('cron').nextRunAt, Date.parse('2026-09-09T00:12:00Z'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, 'D123');
    const sessions = await daemon.control.execute({ type: 'sessions.list' });
    assert.ok(sessions.sessions.some(({ threadKey, backendSessionId }) => threadKey === 'D123:100.001' && backendSessionId === 'session-scheduled:once'));
    now = Date.parse('2026-09-09T00:12:00Z');
    tick();
    await eventually(() => assert.equal(store.get('cron').runCount, 1));
    await eventually(() => assert.equal(store.get('cron').status, 'pending'));
    assert.equal(posts.length, 2);
  } finally {
    await daemon.close();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a lost delivery is recorded without replaying the agent and leaves later due reminders unclaimed', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-scheduler-delivery-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const configuration = createConfiguration(skyHome, { env: {} });
  configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test' });
  configuration.setSecret('slack.botToken', 'xoxb-test');
  configuration.setSecret('slack.appToken', 'xapp-test');
  const store = openScheduledJobStore(skyHome);
  let now = Date.parse('2026-09-09T00:00:00Z');
  store.create(reminder('first', now));
  store.create(reminder('second', now + 1));
  let available = true;
  let tick;
  let rejectDelivery = true;
  const prompts = [];
  const posts = [];
  const slack = createSlackSdk({
    authenticate: async () => { if (!available) throw new Error('offline'); return { user_id: 'U_SKY' }; },
    postMessage: async (message) => {
      if (rejectDelivery) {
        available = false;
        slack.disconnect();
        throw new Error('delivery disconnected');
      }
      posts.push(message);
      return { ts: '100.002' };
    },
  });
  const daemon = await startSkyd({
    skyHome, configurationEnv: {}, backoff: { baseMs: 10, maxMs: 10, jitterRatio: 0 },
    runtimeDependencies: {
      slackSdk: slack.sdk, createSession: createAgentSdk(prompts),
      scheduler: { now: () => now, setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {} },
    },
  });
  try {
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).slack.state, 'connected'));
    now += 1;
    tick();
    await eventually(() => assert.equal(store.get('first').status, 'failed'));
    assert.match(store.get('first').lastError, /delivery failed after agent execution/i);
    assert.equal(store.get('first').runCount, 1);
    assert.equal(store.get('second').status, 'pending');
    assert.equal(store.get('second').runCount, 0);
    assert.equal(prompts.length, 1);
    now += 60_000;
    tick();
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).activeWorkCount, 0));
    assert.equal(store.get('second').runCount, 0);
    rejectDelivery = false;
    available = true;
    await eventually(async () => assert.equal((await getDaemonStatus(skyHome.socketFile)).slack.state, 'connected'));
    tick();
    await eventually(() => assert.equal(store.get('second').status, 'done'));
    assert.equal(prompts.length, 2);
    assert.equal(posts.length, 1);
    assert.equal(store.get('first').runCount, 1);
  } finally {
    await daemon.close();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
