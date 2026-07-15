import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAIN_AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'opus',
  tools: ['Read'],
};

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-turn-'));
process.env.HOME = homeDir;

const { SLACK_TURN_ERROR_REPLY, executeSlackTurn } = await import('../dist/slack/turn.js');

function createReactionsClient() {
  const calls = [];
  return {
    calls,
    client: {
      reactions: {
        add: async (params) => {
          calls.push({ method: 'add', ...params });
          return { ok: true };
        },
        remove: async (params) => {
          calls.push({ method: 'remove', ...params });
          return { ok: true };
        },
      },
    },
  };
}

function createIndicator(sink = []) {
  return {
    events: sink,
    indicator: {
      begin: async () => {
        sink.push('indicator:begin');
      },
      pause: async () => {
        sink.push('indicator:pause');
      },
      end: async () => {
        sink.push('indicator:end');
      },
    },
  };
}

function createReplyAdapter() {
  const replies = [];
  return {
    replies,
    adapter: {
      sendReply: async (text) => {
        replies.push(text);
      },
    },
  };
}

test.after(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('executeSlackTurn sends streamed fallback reply and records transcript after session id is known', async () => {
  const reactions = createReactionsClient();
  const indicator = createIndicator();
  const replies = createReplyAdapter();
  const runTurnCalls = [];
  const conversationManager = {
    runTurn: async (key, agent, text, options) => {
      runTurnCalls.push({
        key,
        agent,
        text,
        hasStreamingCallback: typeof options?.onTextDelta === 'function',
        hasMessageCallback: typeof options?.onMessage === 'function',
      });
      await options.onTextDelta('streamed ');
      await options.onTextDelta('reply');
      return {
        kind: 'ok',
        text: '',
        messages: [],
        handle: { sessionId: 'pi-session-turn', sessionFile: '/tmp/pi-session-turn.jsonl' },
      };
    },
  };

  await executeSlackTurn({
    channelId: 'C123',
    conversationManager,
    mainAgent: MAIN_AGENT,
    messageTs: '1777901000.000000',
    indicator: indicator.indicator,
    reactionClient: reactions.client,
    reply: replies.adapter,
    text: '작업 상태 알려줘',
    threadId: 'C123:1777901000.000000',
  });

  assert.deepEqual(runTurnCalls, [
    {
      key: 'C123:1777901000.000000',
      agent: MAIN_AGENT,
      text: '작업 상태 알려줘',
      hasStreamingCallback: true,
      hasMessageCallback: true,
    },
  ]);
  assert.deepEqual(replies.replies, ['streamed reply']);
  // No thinking reaction is toggled anymore; the indicator drives the "thinking" UI.
  assert.deepEqual(reactions.calls, []);
  assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:pause', 'indicator:end']);

  const transcript = fs.readFileSync(
    path.join(homeDir, '.sky', 'transcripts', 'C123:1777901000.000000', 'pi-session-turn.md'),
    'utf8',
  );
  assert.match(transcript, /### user/);
  assert.match(transcript, /작업 상태 알려줘/);
  assert.match(transcript, /### assistant/);
  assert.match(transcript, /streamed reply/);
});

test('executeSlackTurn hides the indicator around each assistant message and resumes between them', async () => {
  const events = [];
  const indicator = createIndicator(events);
  const conversationManager = {
    runTurn: async (_key, _agent, _text, options) => {
      events.push('turn:start');
      await options.onMessage('first');
      events.push('turn:after-first');
      await options.onMessage('second');
      events.push('turn:end');
      return {
        kind: 'ok',
        text: 'firstsecond',
        messages: ['first', 'second'],
        handle: { sessionId: 'pi-session-turn', sessionFile: '/tmp/pi-session-turn.jsonl' },
      };
    },
  };

  await executeSlackTurn({
    channelId: 'C123',
    conversationManager,
    mainAgent: MAIN_AGENT,
    messageTs: '1777901000.000001',
    indicator: indicator.indicator,
    reactionClient: createReactionsClient().client,
    reply: {
      sendReply: async (text) => {
        events.push(`reply:${text}`);
      },
    },
    text: '여러 답변',
    threadId: 'C123:1777901000.000001',
  });

  assert.deepEqual(events, [
    'indicator:begin',
    'turn:start',
    'indicator:pause',
    'reply:first',
    'indicator:begin',
    'turn:after-first',
    'indicator:pause',
    'reply:second',
    'indicator:begin',
    'turn:end',
    'indicator:end',
  ]);
});

test('executeSlackTurn marks interrupted turns without sending a reply', async () => {
  const reactions = createReactionsClient();
  const indicator = createIndicator();
  const replies = createReplyAdapter();
  const conversationManager = {
    runTurn: async () => ({ kind: 'interrupted' }),
  };

  await executeSlackTurn({
    channelId: 'C123',
    conversationManager,
    mainAgent: MAIN_AGENT,
    messageTs: '1777901001.000000',
    indicator: indicator.indicator,
    reactionClient: reactions.client,
    reply: replies.adapter,
    text: '중단될 작업',
    threadId: 'C123:1777901001.000000',
  });

  assert.deepEqual(replies.replies, []);
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), ['add:hand']);
  assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:end']);
});

test('executeSlackTurn sends the common error reply for error results and thrown exceptions', async () => {
  for (const runTurn of [
    async () => ({ kind: 'error', error: new Error('boom') }),
    async () => {
      throw new Error('boom');
    },
  ]) {
    const reactions = createReactionsClient();
    const indicator = createIndicator();
    const replies = createReplyAdapter();

    await executeSlackTurn({
      channelId: 'C123',
      conversationManager: { runTurn },
      mainAgent: MAIN_AGENT,
      messageTs: '1777901002.000000',
      indicator: indicator.indicator,
      reactionClient: reactions.client,
      reply: replies.adapter,
      text: '실패할 작업',
      threadId: 'C123:1777901002.000000',
    });

    assert.deepEqual(replies.replies, [SLACK_TURN_ERROR_REPLY]);
    assert.deepEqual(reactions.calls, []);
    assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:end']);
  }
});
