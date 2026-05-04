import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../dist/settings.js';

test('parseSettings accepts slack-only configuration', () => {
  const settings = parseSettings({
    slack: {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    },
    model: 'anthropic/claude-opus-4-7',
  });

  assert.deepEqual(settings.slack, {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
  });
  assert.equal(settings.model, 'anthropic/claude-opus-4-7');
  assert.equal(typeof settings.workspace, 'string');
});

test('parseSettings requires slack configuration', () => {
  assert.throws(
    () => parseSettings({ model: 'anthropic/claude-opus-4-7' }),
    (error) => {
      assert.match(error.message, /Invalid input: expected object/);
      return true;
    },
  );
});

test('parseSettings rejects removed transport configuration', () => {
  const removedTransport = ['tele', 'gram'].join('');

  assert.throws(
    () =>
      parseSettings({
        slack: {
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
        },
        [removedTransport]: {
          botToken: 'removed-token',
        },
        model: 'anthropic/claude-opus-4-7',
      }),
    (error) => {
      assert.match(error.message, /Unrecognized key/);
      return true;
    },
  );
});

test('parseSettings rejects legacy claude model configuration', () => {
  assert.throws(
    () =>
      parseSettings({
        slack: {
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
        },
        claude: {
          model: 'claude-opus-4-7',
        },
      }),
    (error) => {
      assert.match(error.message, /Unrecognized key/);
      return true;
    },
  );
});
