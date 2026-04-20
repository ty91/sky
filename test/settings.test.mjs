import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../dist/settings.js';

test('parseSettings accepts slack-only configuration', () => {
  const settings = parseSettings({
    slack: {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    },
  });

  assert.deepEqual(settings.slack, {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
  });
  assert.equal(settings.telegram, undefined);
  assert.equal(settings.claude.model, 'claude-opus-4-7');
  assert.equal(typeof settings.workspace, 'string');
});

test('parseSettings accepts telegram-only configuration', () => {
  const settings = parseSettings({
    telegram: {
      botToken: 'telegram-token',
    },
  });

  assert.deepEqual(settings.telegram, {
    botToken: 'telegram-token',
  });
  assert.equal(settings.slack, undefined);
});

test('parseSettings requires at least one transport', () => {
  assert.throws(
    () => parseSettings({}),
    (error) => {
      assert.match(error.message, /At least one transport must be configured/);
      return true;
    },
  );
});
