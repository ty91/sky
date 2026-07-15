import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackAgentDmHandler, isAgentRootDmMessage } from '../dist/slack/agent-dm.js';

const MAIN_AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'opus',
  tools: ['Read'],
};

function createSlackClient() {
  const calls = {
    posts: [],
    reactions: [],
    statuses: [],
  };

  return {
    calls,
    client: {
      assistant: {
        threads: {
          setStatus: async (params) => {
            calls.statuses.push(params);
            return { ok: true };
          },
        },
      },
      chat: {
        postMessage: async (params) => {
          calls.posts.push(params);
          return { ok: true };
        },
      },
      reactions: {
        add: async (params) => {
          calls.reactions.push({ method: 'add', ...params });
          return { ok: true };
        },
        remove: async (params) => {
          calls.reactions.push({ method: 'remove', ...params });
          return { ok: true };
        },
      },
      token: 'xoxb-test',
    },
  };
}

function createConversationManagerMock({ reply = '응답' } = {}) {
  const calls = {
    runTurn: [],
  };

  return {
    calls,
    manager: {
      runTurn: async (key, agent, text, options) => {
        calls.runTurn.push({ agent, key, text });
        if (reply && options?.onTextDelta) {
          await options.onTextDelta(reply);
        }
        return {
          kind: 'ok',
          text: reply,
          messages: reply ? [reply] : [],
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
      has: () => false,
    },
  };
}

function createHandler() {
  const slack = createSlackClient();
  const conversations = createConversationManagerMock();
  const handler = createSlackAgentDmHandler({
    botUserId: 'U999',
    mainAgent: MAIN_AGENT,
    conversationManager: conversations.manager,
    slack: slack.client,
    userNameResolver: {
      getDisplayName: async (userId) => ({ U123: '태영' })[userId],
    },
  });

  return { conversations, handler, slack };
}

test('agent DM handler starts a thread from a root DM and replies in that thread', async () => {
  const { conversations, handler, slack } = createHandler();

  const handled = await handler.handleMessage({
    message: {
      channel: 'D123',
      channel_type: 'im',
      text: '스카이야 안녕',
      ts: '1777901000.000000',
      user: 'U123',
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(conversations.calls.runTurn, [
    {
      agent: MAIN_AGENT,
      key: 'D123:1777901000.000000',
      text: '태영(<@U123>): 스카이야 안녕',
    },
  ]);
  assert.deepEqual(slack.calls.posts, [
    { channel: 'D123', text: '응답', thread_ts: '1777901000.000000' },
  ]);
  // The "thinking" UI is now driven by assistant.threads.setStatus, not a reaction.
  assert.deepEqual(slack.calls.reactions, []);
  assert.ok(slack.calls.statuses.length >= 2, 'expected setStatus to be called');
  assert.deepEqual(
    slack.calls.statuses.map((call) => (call.status ? 'thinking' : 'clear')),
    ['thinking', 'clear', 'clear'],
  );
  for (const call of slack.calls.statuses) {
    assert.equal(call.channel_id, 'D123');
    assert.equal(call.thread_ts, '1777901000.000000');
  }
});

test('agent DM handler ignores thread DMs and unsupported messages', async () => {
  const { conversations, handler, slack } = createHandler();

  assert.equal(
    await handler.handleMessage({
      message: {
        channel: 'D123',
        channel_type: 'im',
        text: 'thread reply는 Assistant 경로가 처리',
        thread_ts: '1777901000.000000',
        ts: '1777901001.000000',
        user: 'U123',
      },
    }),
    false,
  );
  assert.equal(
    await handler.handleMessage({
      message: {
        channel: 'D123',
        channel_type: 'im',
        text: 'bot message',
        ts: '1777901002.000000',
        user: 'U999',
      },
    }),
    false,
  );
  assert.equal(
    await handler.handleMessage({
      message: {
        channel: 'C123',
        channel_type: 'channel',
        text: 'channel message',
        ts: '1777901003.000000',
        user: 'U123',
      },
    }),
    false,
  );

  assert.deepEqual(conversations.calls.runTurn, []);
  assert.deepEqual(slack.calls.posts, []);
});

test('isAgentRootDmMessage accepts root file_share DMs', () => {
  assert.equal(
    isAgentRootDmMessage({
      channel: 'D123',
      channel_type: 'im',
      files: [],
      subtype: 'file_share',
      ts: '1777901000.000000',
      user: 'U123',
    }, 'U999'),
    true,
  );
  assert.equal(
    isAgentRootDmMessage({
      channel: 'D123',
      channel_type: 'im',
      subtype: 'message_changed',
      ts: '1777901000.000000',
      user: 'U123',
    }, 'U999'),
    false,
  );
});
