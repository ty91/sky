import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackChannelIngress } from '../dist/slack/channel-ingress.js';

function createChannelHandler() {
  const calls = [];

  return {
    calls,
    handler: {
      handleMessage: async (input) => {
        calls.push(input);
      },
    },
  };
}

test('channel ingress forwards app_mention events to the channel conversation handler', async () => {
  const channel = createChannelHandler();
  const ingress = createSlackChannelIngress({
    botUserId: 'U999',
    channelHandler: channel.handler,
  });

  await ingress.handleAppMention({
    event: {
      channel: 'C123',
      text: '<@U999> 작업 상태 알려줘',
      ts: '1777901000.000000',
      user: 'U123',
    },
  });

  assert.deepEqual(channel.calls, [
    {
      event: {
        channel: 'C123',
        text: '<@U999> 작업 상태 알려줘',
        ts: '1777901000.000000',
        user: 'U123',
      },
    },
  ]);
});

test('channel ingress does not forward regular channel messages that mention the bot', async () => {
  const channel = createChannelHandler();
  const ingress = createSlackChannelIngress({
    botUserId: 'U999',
    channelHandler: channel.handler,
  });

  await ingress.handleMessage({
    message: {
      channel: 'C123',
      channel_type: 'channel',
      text: '<@U999> 작업 상태 알려줘',
      ts: '1777901000.000000',
      user: 'U123',
    },
  });

  assert.deepEqual(channel.calls, []);
});

test('channel ingress forwards unmentioned public channel messages to the channel conversation handler', async () => {
  const channel = createChannelHandler();
  const ingress = createSlackChannelIngress({
    botUserId: 'U999',
    channelHandler: channel.handler,
  });

  await ingress.handleMessage({
    message: {
      channel: 'C123',
      channel_type: 'channel',
      text: '이어서 설명해줘',
      ts: '1777901000.000000',
      user: 'U123',
    },
  });

  assert.deepEqual(channel.calls, [
    {
      event: {
        channel: 'C123',
        channel_type: 'channel',
        text: '이어서 설명해줘',
        ts: '1777901000.000000',
        user: 'U123',
      },
    },
  ]);
});

test('channel ingress forwards unmentioned private channel messages to the channel conversation handler', async () => {
  const channel = createChannelHandler();
  const ingress = createSlackChannelIngress({
    botUserId: 'U999',
    channelHandler: channel.handler,
  });

  await ingress.handleMessage({
    message: {
      channel: 'G123',
      channel_type: 'group',
      text: '비공개 채널 후속 질문',
      ts: '1777901001.000000',
      user: 'U123',
    },
  });

  assert.deepEqual(channel.calls, [
    {
      event: {
        channel: 'G123',
        channel_type: 'group',
        text: '비공개 채널 후속 질문',
        ts: '1777901001.000000',
        user: 'U123',
      },
    },
  ]);
});

test('channel ingress does not forward DM or unsupported channel messages', async () => {
  const channel = createChannelHandler();
  const ingress = createSlackChannelIngress({
    botUserId: 'U999',
    channelHandler: channel.handler,
  });

  await ingress.handleMessage({
    message: {
      channel: 'D123',
      channel_type: 'im',
      text: 'DM은 채널 ingress 대상이 아님',
      ts: '1777901002.000000',
      user: 'U123',
    },
  });
  await ingress.handleMessage({
    message: {
      channel: 'G999',
      channel_type: 'mpim',
      text: '멀티 DM도 채널 ingress 대상이 아님',
      ts: '1777901003.000000',
      user: 'U123',
    },
  });
  await ingress.handleMessage({
    message: {
      channel: 'C999',
      text: 'channel_type이 없으면 지원하지 않는 이벤트로 취급',
      ts: '1777901004.000000',
      user: 'U123',
    },
  });

  assert.deepEqual(channel.calls, []);
});
