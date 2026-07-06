import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SUGGESTED_PROMPTS, createSlackAssistantConfig } from '../dist/slack/assistant.js';
import { SLACK_TURN_ERROR_REPLY } from '../dist/slack/turn.js';

const MAIN_AGENT = {
  name: 'main',
  systemPrompt: 'system',
  model: 'opus',
  tools: ['Read'],
};

function createMessage({
  text = '안녕하세요',
  channel = 'C123',
  threadTs = '1711.22',
  user = 'U123',
} = {}) {
  return {
    text,
    channel,
    thread_ts: threadTs,
    ts: threadTs,
    user,
  };
}

function createConversationManagerMock(overrides = {}) {
  return {
    runTurn: async () => ({
      kind: 'ok',
      text: 'unused',
      messages: ['unused'],
      handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
    }),
    has: () => false,
    getHandle: () => undefined,
    close: async () => {},
    purge: async () => {},
    closeAll: async () => {},
    ...overrides,
  };
}

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

test('threadStarted sends greeting, prompts, and saves thread context', async () => {
  const calls = {
    say: [],
    prompts: [],
    saves: 0,
  };
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock(),
  });

  await config.threadStarted({
    say: async (text) => {
      calls.say.push(text);
    },
    setSuggestedPrompts: async (payload) => {
      calls.prompts.push(payload);
    },
    saveThreadContext: async () => {
      calls.saves += 1;
    },
    event: {
      assistant_thread: {
        channel_id: 'C123',
        thread_ts: '1711.22',
      },
    },
  });

  assert.deepEqual(calls.say, ['안녕하세요! 무엇을 도와드릴까요?']);
  assert.deepEqual(calls.prompts, [{ prompts: [...DEFAULT_SUGGESTED_PROMPTS] }]);
  assert.equal(calls.saves, 1);
});

test('threadContextChanged saves thread context', async () => {
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock(),
  });
  let saves = 0;

  await config.threadContextChanged({
    saveThreadContext: async () => {
      saves += 1;
    },
  });

  assert.equal(saves, 1);
});

test('userMessage rejects empty text', async () => {
  let runTurnCalls = 0;
  const replies = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async () => {
        runTurnCalls += 1;
        return {
          kind: 'ok',
          text: 'unused',
          messages: ['unused'],
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
    }),
  });

  await config.userMessage({
    message: createMessage({ text: '   ' }),
    say: async (text) => {
      replies.push(text);
    },
    client: reactions.client,
  });

  assert.equal(runTurnCalls, 0);
  assert.deepEqual(replies, ['빈 메시지는 처리할 수 없습니다.']);
  assert.deepEqual(reactions.calls, []);
});

test('userMessage runs one Pi conversation turn with the Slack thread key', async () => {
  const runTurnCalls = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async (key, agent, text, options) => {
        runTurnCalls.push({ key, agent, text, hasStreamingCallback: typeof options?.onTextDelta === 'function' });
        return {
          kind: 'ok',
          text: '좋아요',
          messages: ['좋아요'],
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
    }),
  });

  await config.userMessage({
    message: createMessage({ text: '작업 상태 알려줘', channel: 'C999', threadTs: '1888.55' }),
    say: async () => {},
    client: reactions.client,
  });

  assert.deepEqual(runTurnCalls, [
    {
      key: 'C999:1888.55',
      agent: MAIN_AGENT,
      text: '작업 상태 알려줘',
      hasStreamingCallback: true,
    },
  ]);
});

test('userMessage includes downloaded file attachments in the final prompt', async () => {
  const originalFetch = globalThis.fetch;
  const downloadDir = path.join(os.tmpdir(), 'sky');
  const runTurnCalls = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async (key, agent, text) => {
        runTurnCalls.push({ key, agent, text });
        return {
          kind: 'ok',
          text: '첨부 확인 완료',
          messages: ['첨부 확인 완료'],
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
    }),
  });

  try {
    globalThis.fetch = async () => new Response('file contents', { status: 200 });

    await config.userMessage({
      message: {
        ...createMessage({ text: '첨부 봐줘', channel: 'C999', threadTs: '1888.55' }),
        files: [
          {
            id: 'F123',
            name: 'notes.txt',
            url_private_download: 'https://files.slack.test/notes.txt',
          },
        ],
      },
      say: async () => {},
      client: { ...reactions.client, token: 'xoxb-test-token' },
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  assert.equal(runTurnCalls.length, 1);
  assert.equal(runTurnCalls[0].key, 'C999:1888.55');
  assert.equal(runTurnCalls[0].agent, MAIN_AGENT);
  assert.match(
    runTurnCalls[0].text,
    /^첨부 봐줘\n\nAttachments: `.*\/sky\/notes-[a-z0-9]+\.txt`$/,
  );
});

test('userMessage sends common turn error reply text', async () => {
  const replies = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async () => ({ kind: 'error', error: new Error('boom') }),
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    client: reactions.client,
  });

  assert.deepEqual(replies, [SLACK_TURN_ERROR_REPLY]);
});
