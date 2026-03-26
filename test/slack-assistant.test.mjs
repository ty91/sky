import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SUGGESTED_PROMPTS, createSlackAssistantConfig } from '../dist/slack/assistant.js';

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

function createMockStreamer() {
  const calls = { append: [], stopped: false };
  return {
    calls,
    streamer: {
      append: async (args) => { calls.append.push(args); },
      stop: async () => { calls.stopped = true; },
    },
  };
}

function createMockClient(mockStreamer) {
  return {
    chatStream: (args) => {
      mockStreamer._startArgs = args;
      return mockStreamer;
    },
  };
}

function createContext({ teamId = 'T123' } = {}) {
  return { teamId };
}

test('threadStarted sends greeting, prompts, and saves thread context', async () => {
  const calls = {
    say: [],
    prompts: [],
    saves: 0,
  };
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => ({ kind: 'ok', reply: 'unused' }),
      handleTextStreaming: async () => ({ kind: 'ok', reply: 'unused' }),
    },
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
    sessionManager: {
      handleText: async () => ({ kind: 'ok', reply: 'unused' }),
      handleTextStreaming: async () => ({ kind: 'ok', reply: 'unused' }),
    },
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
  let handleCalls = 0;
  const replies = [];
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => {
        handleCalls += 1;
        return { kind: 'ok', reply: 'unused' };
      },
      handleTextStreaming: async () => {
        handleCalls += 1;
        return { kind: 'ok', reply: 'unused' };
      },
    },
  });

  await config.userMessage({
    message: createMessage({ text: '   ' }),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async () => {},
    client: createMockClient(createMockStreamer().streamer),
    context: createContext(),
  });

  assert.equal(handleCalls, 0);
  assert.deepEqual(replies, ['빈 메시지는 처리할 수 없습니다.']);
});

test('userMessage reports busy sessions via streaming', async () => {
  const statuses = [];
  const threadIds = [];
  const { calls: streamerCalls, streamer: mockStreamer } = createMockStreamer();
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => ({ kind: 'busy' }),
      handleTextStreaming: async (threadId, text) => {
        threadIds.push([threadId, text]);
        return { kind: 'busy' };
      },
    },
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
    client: createMockClient(mockStreamer),
    context: createContext(),
  });

  assert.deepEqual(threadIds, [['C999:1888.55', '작업 상태 알려줘']]);
  assert.deepEqual(statuses, ['생각 중...']);
  assert.equal(streamerCalls.stopped, true);
  assert.deepEqual(replies, ['지금 이전 요청을 처리 중입니다. 잠시 후 다시 보내주세요.']);
});

test('userMessage streams successful responses', async () => {
  const { calls: streamerCalls, streamer: mockStreamer } = createMockStreamer();
  const replies = [];
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => ({ kind: 'ok', reply: '정상 응답' }),
      handleTextStreaming: async (_threadId, _text, onChunk) => {
        await onChunk('스트리밍 ');
        await onChunk('응답');
        return { kind: 'ok', reply: '스트리밍 응답' };
      },
    },
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async () => {},
    client: createMockClient(mockStreamer),
    context: createContext(),
  });

  // Streaming path: no say() calls for the response, only streamer.append
  assert.deepEqual(replies, []);
  assert.deepEqual(streamerCalls.append, [
    { markdown_text: '스트리밍 ' },
    { markdown_text: '응답' },
  ]);
  assert.equal(streamerCalls.stopped, true);
});

test('userMessage falls back to non-streaming when teamId is missing', async () => {
  const replies = [];
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => ({ kind: 'ok', reply: '정상 응답' }),
      handleTextStreaming: async () => { throw new Error('should not be called'); },
    },
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async () => {},
    client: createMockClient(createMockStreamer().streamer),
    context: createContext({ teamId: '' }),
  });

  assert.deepEqual(replies, ['정상 응답']);
});

test('userMessage sends errors as reply text', async () => {
  const replies = [];
  const config = createSlackAssistantConfig({
    sessionManager: {
      handleText: async () => { throw new Error('boom'); },
      handleTextStreaming: async () => { throw new Error('boom'); },
    },
  });

  await config.userMessage({
    message: createMessage(),
    say: async (text) => {
      replies.push(text);
    },
    setStatus: async () => {},
    client: createMockClient(createMockStreamer().streamer),
    context: createContext(),
  });

  assert.deepEqual(replies, ['오류가 났습니다: boom']);
});
