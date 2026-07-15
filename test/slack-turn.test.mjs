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

test('executeSlackTurn delivers only the final message and records every assistant message', async () => {
  const indicator = createIndicator();
  const replies = createReplyAdapter();
  const runTurnCalls = [];
  const conversationManager = {
    runTurn: async (key, agent, text, options) => {
      runTurnCalls.push({
        key,
        agent,
        text,
        hasMessageCallback: typeof options?.onMessage === 'function',
        hasFinalCallback: typeof options?.onFinal === 'function',
      });
      // Interim assistant message (recorded, but not delivered to Slack).
      await options.onMessage('interim');
      // Final assistant message: arrives both as a message and as the turn end.
      await options.onMessage('final answer');
      await options.onFinal('final answer');
      return {
        kind: 'ok',
        text: 'final answer',
        messages: ['interim', 'final answer'],
        handle: { sessionId: 'pi-session-turn', sessionFile: '/tmp/pi-session-turn.jsonl' },
      };
    },
  };

  await executeSlackTurn({
    conversationManager,
    mainAgent: MAIN_AGENT,
    indicator: indicator.indicator,
    reply: replies.adapter,
    text: '작업 상태 알려줘',
    threadId: 'C123:1777901000.000000',
  });

  assert.deepEqual(runTurnCalls, [
    {
      key: 'C123:1777901000.000000',
      agent: MAIN_AGENT,
      text: '작업 상태 알려줘',
      hasMessageCallback: true,
      hasFinalCallback: true,
    },
  ]);
  // Only the final message reaches Slack; interim messages are suppressed.
  assert.deepEqual(replies.replies, ['final answer']);
  // The indicator pauses around the final send and resumes before ending.
  assert.deepEqual(indicator.events, [
    'indicator:begin',
    'indicator:pause',
    'indicator:begin',
    'indicator:end',
  ]);

  const transcript = fs.readFileSync(
    path.join(homeDir, '.sky', 'transcripts', 'C123:1777901000.000000', 'pi-session-turn.md'),
    'utf8',
  );
  assert.match(transcript, /### user/);
  assert.match(transcript, /작업 상태 알려줘/);
  assert.match(transcript, /### assistant/);
  // Both the interim and final assistant messages are recorded for memory.
  assert.match(transcript, /interim/);
  assert.match(transcript, /final answer/);
});

test('executeSlackTurn falls back to result.text when no final callback fires', async () => {
  const indicator = createIndicator();
  const replies = createReplyAdapter();
  const conversationManager = {
    runTurn: async () => ({
      kind: 'ok',
      text: 'fallback final',
      messages: ['fallback final'],
      handle: { sessionId: 'pi-session-fallback', sessionFile: '/tmp/pi-session-fallback.jsonl' },
    }),
  };

  await executeSlackTurn({
    conversationManager,
    mainAgent: MAIN_AGENT,
    indicator: indicator.indicator,
    reply: replies.adapter,
    text: '최종만 알려줘',
    threadId: 'C123:1777901000.000002',
  });

  assert.deepEqual(replies.replies, ['fallback final']);
  assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:pause', 'indicator:end']);
});

test('executeSlackTurn marks interrupted turns without sending a reply', async () => {
  const indicator = createIndicator();
  const replies = createReplyAdapter();
  const conversationManager = {
    runTurn: async () => ({ kind: 'interrupted' }),
  };

  await executeSlackTurn({
    conversationManager,
    mainAgent: MAIN_AGENT,
    indicator: indicator.indicator,
    reply: replies.adapter,
    text: '중단될 작업',
    threadId: 'C123:1777901001.000000',
  });

  assert.deepEqual(replies.replies, []);
  assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:end']);
});

test('executeSlackTurn sends the common error reply for error results and thrown exceptions', async () => {
  for (const runTurn of [
    async () => ({ kind: 'error', error: new Error('boom') }),
    async () => {
      throw new Error('boom');
    },
  ]) {
    const indicator = createIndicator();
    const replies = createReplyAdapter();

    await executeSlackTurn({
      conversationManager: { runTurn },
      mainAgent: MAIN_AGENT,
      indicator: indicator.indicator,
      reply: replies.adapter,
      text: '실패할 작업',
      threadId: 'C123:1777901002.000000',
    });

    assert.deepEqual(replies.replies, [SLACK_TURN_ERROR_REPLY]);
    assert.deepEqual(indicator.events, ['indicator:begin', 'indicator:end']);
  }
});
