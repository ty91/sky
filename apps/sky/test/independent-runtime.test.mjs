import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguration } from '../dist/configuration.js';
import { createSkyHome, prepareSkyHome } from '../dist/sky-home.js';
import { startSkyd } from './helpers/start-skyd.mjs';
import { getConfiguration, getDaemonStatus } from '../dist/skyd/control-uds.js';

function agentSdk(beforePrompt = async () => {}) {
  return Object.assign(async ({ agent, key, resume }) => {
    let listener;
    let turns = 0;
    const tools = agent.customToolsFactory?.({ sessionKey: key }) ?? [];
    return {
      sessionId: resume?.sessionId ?? `session-${key}`,
      async prompt() {
        await beforePrompt();
        turns += 1;
        const text = `${turns}:${tools.map(({ name }) => name).join(',')}`;
        listener?.({ type: 'assistant_message', text });
        listener?.({ type: 'turn_end', text });
      },
      async abort() {},
      dispose() {},
      subscribe(callback) {
        listener = callback;
        return () => { listener = undefined; };
      },
    };
  }, { backend: 'pi' });
}

async function waitFor(socketFile, predicate) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await getDaemonStatus(socketFile);
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Daemon did not reach the expected state.');
}

for (const partial of [false, true]) {
test(`a daemon with ${partial ? 'partial' : 'no'} Slack configuration accepts internal conversations`, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-independent-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const configuration = createConfiguration(skyHome, { env: {} });
  configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test' });
  if (partial) configuration.setSecret('slack.botToken', 'xoxb-partial');
  const daemon = await startSkyd({ skyHome, configurationEnv: {}, runtimeDependencies: { createSession: agentSdk() } });
  try {
    const status = await waitFor(skyHome.socketFile, ({ runtime }) => runtime.state !== 'starting');
    assert.equal(status.runtime.state, 'ready');
    assert.equal(status.slack.state, 'not_configured');
    assert.equal((await getConfiguration(skyHome.socketFile)).complete, true);
    const first = await daemon.runTurn('local-conversation', 'hello');
    assert.equal(first.kind, 'ok');
    assert.equal(first.text, '1:');
    const second = await daemon.runTurn('local-conversation', 'continue');
    assert.equal(second.text, '2:');
    assert.equal(second.handle.sessionId, first.handle.sessionId);
    const sessions = await daemon.control.execute({ type: 'sessions.list' });
    assert.equal(sessions.sessions[0].backendSessionId, first.handle.sessionId);
  } finally {
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
}

test('Slack authentication retries and socket reconnection preserve an active conversation', async () => {
  const { createSlackSdk } = await import('./helpers/slack-sdk.mjs');
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-independent-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const configuration = createConfiguration(skyHome, { env: {} });
  configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test' });
  configuration.setSecret('slack.botToken', 'xoxb-private-test');
  configuration.setSecret('slack.appToken', 'xapp-private-test');
  let available = false;
  const slack = createSlackSdk({ authenticate: async () => {
    if (!available) throw new Error('rejected xoxb-private-test');
    return { user_id: 'U_SKY' };
  } });
  const daemon = await startSkyd({
    skyHome, configurationEnv: {},
    backoff: { baseMs: 10, maxMs: 10, jitterRatio: 0 },
    runtimeDependencies: { createSession: agentSdk(), slackSdk: slack.sdk },
  });
  try {
    const retrying = await waitFor(skyHome.socketFile, ({ slack: connection }) => connection.state === 'retrying');
    assert.equal(retrying.runtime.state, 'ready');
    assert.ok(retrying.slack.nextRetryAt);
    assert.equal((await daemon.runTurn('local', 'first')).text, '1:');
    available = true;
    await waitFor(skyHome.socketFile, ({ slack: connection }) => connection.state === 'connected');
    assert.equal((await daemon.runTurn('local', 'second')).text, '2:');
    available = false;
    slack.disconnect();
    assert.equal((await getDaemonStatus(skyHome.socketFile)).runtime.state, 'ready');
    assert.equal((await getDaemonStatus(skyHome.socketFile)).slack.state, 'retrying');
    assert.equal((await daemon.runTurn('local', 'third')).text, '3:');
    available = true;
    await waitFor(skyHome.socketFile, ({ slack: connection }) => connection.state === 'connected');
    assert.equal((await daemon.runTurn('local', 'fourth')).text, '4:');
    const { readFile } = await import('node:fs/promises');
    const logs = await readFile(skyHome.logFile, 'utf8');
    assert.doesNotMatch(logs, /xoxb-private-test/);
    assert.match(logs, /REDACTED/);
  } finally {
    await daemon.close();
    assert.equal((await daemon.runTurn('local', 'after close')).kind, 'interrupted');
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('draining cancels a stalled Slack startup while allowing the active internal turn to finish', { timeout: 3000 }, async () => {
  const { createSlackSdk } = await import('./helpers/slack-sdk.mjs');
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'sky-drain-independent-'));
  const skyHome = createSkyHome({ rootDir });
  prepareSkyHome(skyHome);
  const configuration = createConfiguration(skyHome, { env: {} });
  configuration.patch(0, { agentBackend: 'pi', model: 'anthropic/test' });
  configuration.setSecret('slack.botToken', 'xoxb-test');
  configuration.setSecret('slack.appToken', 'xapp-test');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const promptStarted = new Promise((resolve) => { started = resolve; });
  const slack = createSlackSdk({ authenticate: () => new Promise(() => {}) });
  const daemon = await startSkyd({
    skyHome, configurationEnv: {},
    runtimeDependencies: { slackSdk: slack.sdk, createSession: agentSdk(async () => { started(); await gate; }) },
  });
  try {
    await waitFor(skyHome.socketFile, ({ runtime }) => runtime.state === 'ready');
    const turn = daemon.runTurn('local', 'finish before stop');
    await promptStarted;
    const closing = daemon.close();
    const draining = await getDaemonStatus(skyHome.socketFile);
    assert.equal(draining.runtime.state, 'draining');
    assert.equal(draining.activeWorkCount, 1);
    assert.equal((await daemon.runTurn('another', 'refused')).kind, 'interrupted');
    release();
    assert.equal((await turn).kind, 'ok');
    await closing;
  } finally {
    release();
    await daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
