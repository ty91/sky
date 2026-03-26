import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackSender } from '../dist/slack/sender.js';

test('SlackSender chunks long replies', async () => {
  const messages = [];
  const sender = new SlackSender({
    say: async (text) => {
      messages.push(text);
    },
    setStatus: async () => {},
  });

  await sender.sendReply('a'.repeat(3501));

  assert.equal(messages.length, 2);
  assert.equal(messages[0].length, 3500);
  assert.equal(messages[1], 'a');
});

test('SlackSender retries failed sends before succeeding', async () => {
  const delays = [];
  let attempts = 0;
  const sender = new SlackSender({
    say: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('temporary failure');
      }
    },
    setStatus: async () => {},
    computeDelayMs: (attempt) => attempt * 10,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  await sender.sendReply('ok');

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('SlackSender rethrows after max retries', async () => {
  let attempts = 0;
  const sender = new SlackSender({
    say: async () => {
      attempts += 1;
      throw new Error('permanent failure');
    },
    setStatus: async () => {},
    computeDelayMs: () => 1,
    sleep: async () => {},
  });

  await assert.rejects(sender.sendReply('ok'), /permanent failure/);
  assert.equal(attempts, 4);
});

test('SlackSender ignores setStatus failures', async () => {
  const sender = new SlackSender({
    say: async () => {},
    setStatus: async () => {
      throw new Error('status failure');
    },
  });

  await assert.doesNotReject(sender.setStatus('thinking'));
});

test('createStreamer returns append and stop functions', () => {
  const appendCalls = [];
  let stopped = false;
  const mockClient = {
    chatStream: (args) => ({
      _args: args,
      append: async (details) => { appendCalls.push(details); },
      stop: async () => { stopped = true; },
    }),
  };

  const sender = new SlackSender({
    say: async () => {},
    setStatus: async () => {},
  });

  const streamer = sender.createStreamer({
    client: mockClient,
    channelId: 'C123',
    threadTs: '1711.22',
    teamId: 'T123',
    userId: 'U123',
  });

  assert.equal(typeof streamer.append, 'function');
  assert.equal(typeof streamer.stop, 'function');
});

test('createStreamer.append sends markdown_text to chatStream', async () => {
  const appendCalls = [];
  const mockClient = {
    chatStream: () => ({
      append: async (details) => { appendCalls.push(details); },
      stop: async () => {},
    }),
  };

  const sender = new SlackSender({
    say: async () => {},
    setStatus: async () => {},
  });

  const streamer = sender.createStreamer({
    client: mockClient,
    channelId: 'C123',
    threadTs: '1711.22',
    teamId: 'T123',
    userId: 'U123',
  });

  await streamer.append('hello ');
  await streamer.append('world');

  assert.deepEqual(appendCalls, [
    { markdown_text: 'hello ' },
    { markdown_text: 'world' },
  ]);
});

test('createStreamer.append swallows errors', async () => {
  const mockClient = {
    chatStream: () => ({
      append: async () => { throw new Error('append failed'); },
      stop: async () => {},
    }),
  };

  const sender = new SlackSender({
    say: async () => {},
    setStatus: async () => {},
  });

  const streamer = sender.createStreamer({
    client: mockClient,
    channelId: 'C123',
    threadTs: '1711.22',
    teamId: 'T123',
    userId: 'U123',
  });

  await assert.doesNotReject(streamer.append('test'));
});

test('createStreamer.stop swallows errors', async () => {
  const mockClient = {
    chatStream: () => ({
      append: async () => {},
      stop: async () => { throw new Error('stop failed'); },
    }),
  };

  const sender = new SlackSender({
    say: async () => {},
    setStatus: async () => {},
  });

  const streamer = sender.createStreamer({
    client: mockClient,
    channelId: 'C123',
    threadTs: '1711.22',
    teamId: 'T123',
    userId: 'U123',
  });

  await assert.doesNotReject(streamer.stop());
});
