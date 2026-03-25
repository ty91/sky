import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNetworkClient } from '../dist/telegram/network-client.js';

test('TelegramNetworkClient always reports fixed ipv4 transport', async () => {
  const client = new TelegramNetworkClient({ botToken: 'dummy-token' });

  const fetchImpl = client.createFetch();
  assert.equal(typeof fetchImpl, 'function');

  await client.close();
});

test('TelegramNetworkClient tags network errors as ipv4', async () => {
  const client = new TelegramNetworkClient({ botToken: 'dummy-token', requestTimeoutMs: 5 });
  const fetchImpl = client.createFetch();

  await assert.rejects(
    fetchImpl('https://127.0.0.1:9'),
    (error) => {
      assert.equal(error.telegramNetwork, 'ipv4');
      return true;
    },
  );

  await client.close();
});
