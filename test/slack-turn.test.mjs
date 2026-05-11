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
  const replies = createReplyAdapter();
  const runTurnCalls = [];
  const conversationManager = {
    runTurn: async (key, agent, text, options) => {
      runTurnCalls.push({
        key,
        agent,
        text,
        hasStreamingCallback: typeof options?.onTextDelta === 'function',
      });
      await options.onTextDelta('streamed ');
      await options.onTextDelta('reply');
      return {
        kind: 'ok',
        text: '',
        handle: { sessionId: 'pi-session-turn', sessionFile: '/tmp/pi-session-turn.jsonl' },
      };
    },
  };

  await executeSlackTurn({
    channelId: 'C123',
    conversationManager,
    mainAgent: MAIN_AGENT,
    messageTs: '1777901000.000000',
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
    },
  ]);
  assert.deepEqual(replies.replies, ['streamed reply']);
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'add:white_check_mark',
    'remove:thought_balloon',
  ]);

  const transcript = fs.readFileSync(
    path.join(homeDir, '.sky', 'transcripts', 'C123:1777901000.000000', 'pi-session-turn.md'),
    'utf8',
  );
  assert.match(transcript, /### user/);
  assert.match(transcript, /작업 상태 알려줘/);
  assert.match(transcript, /### assistant/);
  assert.match(transcript, /streamed reply/);
});

test('executeSlackTurn marks interrupted turns without sending a reply', async () => {
  const reactions = createReactionsClient();
  const replies = createReplyAdapter();
  const conversationManager = {
    runTurn: async () => ({ kind: 'interrupted' }),
  };

  await executeSlackTurn({
    channelId: 'C123',
    conversationManager,
    mainAgent: MAIN_AGENT,
    messageTs: '1777901001.000000',
    reactionClient: reactions.client,
    reply: replies.adapter,
    text: '중단될 작업',
    threadId: 'C123:1777901001.000000',
  });

  assert.deepEqual(replies.replies, []);
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'add:hand',
    'remove:thought_balloon',
  ]);
});

test('executeSlackTurn sends the common error reply for error results and thrown exceptions', async () => {
  for (const runTurn of [
    async () => ({ kind: 'error', error: new Error('boom') }),
    async () => {
      throw new Error('boom');
    },
  ]) {
    const reactions = createReactionsClient();
    const replies = createReplyAdapter();

    await executeSlackTurn({
      channelId: 'C123',
      conversationManager: { runTurn },
      mainAgent: MAIN_AGENT,
      messageTs: '1777901002.000000',
      reactionClient: reactions.client,
      reply: replies.adapter,
      text: '실패할 작업',
      threadId: 'C123:1777901002.000000',
    });

    assert.deepEqual(replies.replies, [SLACK_TURN_ERROR_REPLY]);
    assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
      'add:thought_balloon',
      'remove:thought_balloon',
    ]);
  }
});
