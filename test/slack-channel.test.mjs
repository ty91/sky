import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlackMessage } from '../dist/slack/messages.js';

test('normalizeSlackMessage replaces bot mentions with a readable label', () => {
  const result = normalizeSlackMessage({
    botUserId: 'U999',
    event: { text: '<@U999> 작업 상태 알려줘', user: 'U123' },
  });

  assert.deepEqual(result, { ignored: false, text: '@sky 작업 상태 알려줘' });
});

test('normalizeSlackMessage replaces labelled Slack mentions', () => {
  const result = normalizeSlackMessage({
    botUserId: 'U999',
    event: { text: '혹시 <@U999|sky> 이거 봐줄래?', user: 'U123' },
    mentionLabel: '@assistant',
  });

  assert.deepEqual(result, { ignored: false, text: '혹시 @assistant 이거 봐줄래?' });
});

test('normalizeSlackMessage accepts unmentioned text only for existing channel threads', () => {
  const ignored = normalizeSlackMessage({
    botUserId: 'U999',
    event: { text: '이어서 설명해줘', user: 'U123' },
  });
  const accepted = normalizeSlackMessage({
    allowUnmentionedChannelMessage: true,
    botUserId: 'U999',
    event: { text: '이어서 설명해줘', user: 'U123' },
  });

  assert.deepEqual(ignored, { ignored: true, reason: 'missing_channel_mention' });
  assert.deepEqual(accepted, { ignored: false, text: '이어서 설명해줘' });
});

test('normalizeSlackMessage ignores bot messages, unsupported subtypes, empty text, and unknown bot ids', () => {
  assert.deepEqual(
    normalizeSlackMessage({
      botUserId: 'U999',
      event: { bot_id: 'B123', text: '<@U999> hi', user: 'U123' },
    }),
    { ignored: true, reason: 'bot_message' },
  );
  assert.deepEqual(
    normalizeSlackMessage({
      botUserId: 'U999',
      event: { text: '<@U999> hi', user: 'U999' },
    }),
    { ignored: true, reason: 'bot_message' },
  );
  assert.deepEqual(
    normalizeSlackMessage({
      botUserId: 'U999',
      event: { subtype: 'message_changed', text: '<@U999> hi', user: 'U123' },
    }),
    { ignored: true, reason: 'slack_subtype' },
  );
  assert.deepEqual(
    normalizeSlackMessage({
      botUserId: 'U999',
      event: { text: '   ', user: 'U123' },
    }),
    { ignored: true, reason: 'empty' },
  );
  assert.deepEqual(
    normalizeSlackMessage({
      botUserId: '   ',
      event: { text: '<@U999> hi', user: 'U123' },
    }),
    { ignored: true, reason: 'unknown_bot' },
  );
});
