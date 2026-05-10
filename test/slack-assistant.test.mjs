import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SUGGESTED_PROMPTS, createSlackAssistantConfig } from '../dist/slack/assistant.js';

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

test('userMessage silently ignores interrupted result', async () => {
  const runTurnCalls = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async (key, agent, text) => {
        runTurnCalls.push({ key, agent, text });
        return { kind: 'interrupted' };
      },
    }),
  });

  const replies = [];
  await config.userMessage({
    message: createMessage({ text: '작업 상태 알려줘', channel: 'C999', threadTs: '1888.55' }),
    say: async (text) => {
      replies.push(text);
    },
    client: reactions.client,
  });

  assert.equal(runTurnCalls.length, 1);
  assert.equal(runTurnCalls[0].key, 'C999:1888.55');
  assert.equal(runTurnCalls[0].agent.name, 'main');
  assert.deepEqual(replies, []);  // interrupted일 때는 아무 응답도 보내지 않음
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'add:hand',
    'remove:thought_balloon',
  ]);
});

test('userMessage sends the completed assistant message once from streamed text', async () => {
  const replies = [];
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async (_threadId, _agent, _text, options) => {
        await options.onTextDelta('파일을 확인해볼게요\n\n');
        await options.onTextDelta('수정 완료했습니다');
        return {
          kind: 'ok',
          text: '파일을 확인해볼게요\n\n수정 완료했습니다',
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    client: reactions.client,
  });

  assert.deepEqual(replies, ['파일을 확인해볼게요\n\n수정 완료했습니다']);
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'add:white_check_mark',
    'remove:thought_balloon',
  ]);
});

test('userMessage keeps reaction lifecycle when assistant message is delivered', async () => {
  const reactions = createReactionsClient();
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    conversationManager: createConversationManagerMock({
      runTurn: async (_threadId, _agent, _text, options) => {
        await options.onTextDelta('응답');
        return {
          kind: 'ok',
          text: '응답',
          handle: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' },
        };
      },
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async () => {},
    client: reactions.client,
  });

  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'add:white_check_mark',
    'remove:thought_balloon',
  ]);
});

test('userMessage sends errors as reply text', async () => {
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

  assert.deepEqual(replies, ['오류가 났습니다: boom']);
  assert.deepEqual(reactions.calls.map((call) => `${call.method}:${call.name}`), [
    'add:thought_balloon',
    'remove:thought_balloon',
  ]);
});

test('userMessage records transcript under the Pi conversation handle session id', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-assistant-'));

  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlackAssistantConfig } from './dist/slack/assistant.js';

const config = createSlackAssistantConfig({
  mainAgent: { name: 'main', systemPrompt: 'system', model: 'opus', tools: ['Read'] },
  conversationManager: {
    runTurn: async (_key, _agent, _text, options) => {
      await options.onTextDelta('처리했습니다');
      return {
        kind: 'ok',
        text: '처리했습니다',
        handle: { sessionId: 'pi-session-transcript', sessionFile: '/tmp/pi-session-transcript.jsonl' },
      };
    },
    has: () => false,
    getHandle: () => undefined,
    close: async () => {},
    purge: async () => {},
    closeAll: async () => {},
  },
});

await config.userMessage({
  message: {
    text: '기록해줘',
    channel: 'C123',
    thread_ts: '1711.22',
    ts: '1711.22',
    user: 'U123',
  },
  say: async () => {},
  client: { reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) } },
});

const transcript = fs.readFileSync(
  path.join(os.homedir(), '.sky', 'transcripts', 'C123:1711.22', 'pi-session-transcript.md'),
  'utf8',
);
assert.match(transcript, /### user/);
assert.match(transcript, /기록해줘/);
assert.match(transcript, /### assistant/);
assert.match(transcript, /처리했습니다/);
console.log('assistant-transcript-test-ok');
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf8',
      },
    );

    assert.match(output, /assistant-transcript-test-ok/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
