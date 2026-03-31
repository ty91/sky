import test from 'node:test';
import assert from 'node:assert/strict';
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

function createSessionManagerMock(overrides = {}) {
  return {
    open: () => {},
    send: async () => ({ kind: 'ok', text: 'unused' }),
    getSessionId: () => undefined,
    close: async () => {},
    closeAll: async () => {},
    ...overrides,
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
    sessionManager: createSessionManagerMock(),
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
    sessionManager: createSessionManagerMock(),
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
  let sendCalls = 0;
  const replies = [];
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    sessionManager: createSessionManagerMock({
      send: async () => {
        sendCalls += 1;
        return { kind: 'ok', text: 'unused' };
      },
    }),
  });

  await config.userMessage({
    message: createMessage({ text: '   ' }),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async () => {},
    client: {},
  });

  assert.equal(sendCalls, 0);
  assert.deepEqual(replies, ['빈 메시지는 처리할 수 없습니다.']);
});

test('userMessage opens a session and reports busy sessions', async () => {
  const statuses = [];
  const openCalls = [];
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    sessionManager: createSessionManagerMock({
      open: (key, agent, options) => {
        openCalls.push({ key, agent, options });
      },
      send: async () => ({ kind: 'busy' }),
    }),
  });

  const replies = [];
  await config.userMessage({
    message: createMessage({ text: '작업 상태 알려줘', channel: 'C999', threadTs: '1888.55' }),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async (status) => {
      statuses.push(status);
    },
    client: {},
  });

  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].key, 'C999:1888.55');
  assert.equal(openCalls[0].agent.name, 'main');
  assert.deepEqual(statuses, ['생각 중...', '']);
  assert.deepEqual(replies, ['지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.']);
});

test('userMessage sends each assistant message individually via onMessage callback', async () => {
  const replies = [];
  const statuses = [];
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    sessionManager: createSessionManagerMock({
      send: async (_threadId, _text, options) => {
        await options.onMessage('파일을 확인해볼게요');
        await options.onMessage('수정 완료했습니다');
        return { kind: 'ok', text: '수정 완료했습니다' };
      },
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async (status) => {
      statuses.push(status);
    },
    client: {},
  });

  assert.deepEqual(replies, ['파일을 확인해볼게요', '수정 완료했습니다']);
  assert.deepEqual(statuses, ['생각 중...', '생각 중...', '생각 중...', '']);
});

test('userMessage resets status after each assistant message and clears it after completion', async () => {
  const statuses = [];
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    sessionManager: createSessionManagerMock({
      send: async (_threadId, _text, options) => {
        await options.onMessage('응답');
        return { kind: 'ok', text: '응답' };
      },
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async () => {},
    setStatus: async (status) => {
      statuses.push(status);
    },
    client: {},
  });

  assert.deepEqual(statuses, ['생각 중...', '생각 중...', '']);
});

test('userMessage sends errors as reply text', async () => {
  const replies = [];
  const statuses = [];
  const config = createSlackAssistantConfig({
    mainAgent: MAIN_AGENT,
    sessionManager: createSessionManagerMock({
      send: async () => ({ kind: 'error', error: new Error('boom') }),
    }),
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async (status) => {
      statuses.push(status);
    },
    client: {},
  });

  assert.deepEqual(replies, ['오류가 났습니다: boom']);
  assert.deepEqual(statuses, ['생각 중...', '']);
});
