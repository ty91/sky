import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_COMMAND_MODEL_LOCKED_REPLY,
  CHAT_COMMAND_USAGE,
  maybeHandleChatCommand,
  parseChatCommand,
  stripLeadingMentionLabel,
} from '../dist/slack/commands.js';

function createContext({ rawText, hasConversation = false, models = {} } = {}) {
  const replies = [];
  const stored = new Map(Object.entries(models));
  return {
    replies,
    stored,
    ctx: {
      threadId: 'C123:1777901000.000000',
      rawText,
      conversationManager: {
        has: () => hasConversation,
      },
      threadModelStore: {
        get: (key) => stored.get(key),
        set: (key, model) => stored.set(key, model),
      },
      reply: {
        sendReply: async (text) => {
          replies.push(text);
        },
      },
    },
  };
}

test('parseChatCommand recognises single-line bang commands and ignores everything else', () => {
  assert.deepEqual(parseChatCommand('!model fable'), { name: 'model', args: ['fable'] });
  assert.deepEqual(parseChatCommand('  !MODEL   fable  '), { name: 'model', args: ['fable'] });
  assert.deepEqual(parseChatCommand('!help'), { name: 'help', args: [] });

  assert.equal(parseChatCommand('모델 바꿔줘'), undefined);
  assert.equal(parseChatCommand('!'), undefined);
  // Multi-line prose that merely starts with `!` still reaches the agent.
  assert.equal(parseChatCommand('!wow\n이거 봐봐'), undefined);
});

test('maybeHandleChatCommand sets the thread model and confirms it', async () => {
  const { ctx, replies, stored } = createContext({ rawText: '!model fable' });

  assert.equal(await maybeHandleChatCommand(ctx), true);
  assert.deepEqual(replies, ['모델이 claude-fable-5로 설정되었습니다.']);
  assert.equal(stored.get('C123:1777901000.000000'), 'anthropic/claude-fable-5');

  const opus = createContext({ rawText: '!model opus' });
  assert.equal(await maybeHandleChatCommand(opus.ctx), true);
  assert.deepEqual(opus.replies, ['모델이 claude-opus-5로 설정되었습니다.']);
  assert.equal(opus.stored.get('C123:1777901000.000000'), 'anthropic/claude-opus-5');
});

test('maybeHandleChatCommand passes non-command messages through to the agent', async () => {
  const { ctx, replies } = createContext({ rawText: '오늘 일정 알려줘' });

  assert.equal(await maybeHandleChatCommand(ctx), false);
  assert.deepEqual(replies, []);
});

test('maybeHandleChatCommand answers unknown commands with usage instead of running a turn', async () => {
  const { ctx, replies } = createContext({ rawText: '!nope' });

  assert.equal(await maybeHandleChatCommand(ctx), true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /알 수 없는 명령어입니다: `!nope`/);
  assert.ok(replies[0].endsWith(CHAT_COMMAND_USAGE));
});

test('maybeHandleChatCommand rejects unknown models and malformed !model usage', async () => {
  const unknownModel = createContext({ rawText: '!model gpt' });
  assert.equal(await maybeHandleChatCommand(unknownModel.ctx), true);
  assert.match(unknownModel.replies[0], /알 수 없는 모델입니다: `gpt`/);
  assert.equal(unknownModel.stored.size, 0);

  for (const rawText of ['!model', '!model fable opus']) {
    const { ctx, replies, stored } = createContext({ rawText });
    assert.equal(await maybeHandleChatCommand(ctx), true);
    assert.deepEqual(replies, [CHAT_COMMAND_USAGE]);
    assert.equal(stored.size, 0);
  }
});

test('maybeHandleChatCommand locks the model once the thread has a conversation or a model', async () => {
  const started = createContext({ rawText: '!model fable', hasConversation: true });
  assert.equal(await maybeHandleChatCommand(started.ctx), true);
  assert.deepEqual(started.replies, [CHAT_COMMAND_MODEL_LOCKED_REPLY]);
  assert.equal(started.stored.size, 0);

  const alreadySet = createContext({
    rawText: '!model opus',
    models: { 'C123:1777901000.000000': 'anthropic/claude-fable-5' },
  });
  assert.equal(await maybeHandleChatCommand(alreadySet.ctx), true);
  assert.deepEqual(alreadySet.replies, [CHAT_COMMAND_MODEL_LOCKED_REPLY]);
  assert.equal(alreadySet.stored.get('C123:1777901000.000000'), 'anthropic/claude-fable-5');
});

test('maybeHandleChatCommand answers !help with the usage text', async () => {
  const { ctx, replies } = createContext({ rawText: '!help' });

  assert.equal(await maybeHandleChatCommand(ctx), true);
  assert.deepEqual(replies, [CHAT_COMMAND_USAGE]);
  assert.match(CHAT_COMMAND_USAGE, /fable, opus, sonnet/);
});

test('stripLeadingMentionLabel removes only a standalone leading mention label', () => {
  assert.equal(stripLeadingMentionLabel('@sky !model fable', '@sky'), '!model fable');
  assert.equal(stripLeadingMentionLabel('  @sky   !help  ', '@sky'), '!help');
  assert.equal(stripLeadingMentionLabel('@sky', '@sky'), '');
  // Not a standalone label: leave the text alone.
  assert.equal(stripLeadingMentionLabel('@skynet 안녕', '@sky'), '@skynet 안녕');
  assert.equal(stripLeadingMentionLabel('안녕 @sky', '@sky'), '안녕 @sky');
});
