import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderModel } from '../dist/providers/model.js';

test('parseProviderModel accepts anthropic model strings', () => {
  assert.deepEqual(parseProviderModel('anthropic/claude-opus-4-7'), {
    provider: 'anthropic',
    modelId: 'claude-opus-4-7',
    raw: 'anthropic/claude-opus-4-7',
  });
});

test('parseProviderModel keeps slashes inside the model id', () => {
  assert.equal(parseProviderModel('anthropic/custom/model').modelId, 'custom/model');
});

test('parseProviderModel rejects malformed model strings', () => {
  for (const value of ['claude-opus-4-7', '/claude-opus-4-7', 'anthropic/']) {
    assert.throws(() => parseProviderModel(value), /<provider>\/<model>/);
  }
});

test('parseProviderModel rejects unsupported providers', () => {
  assert.throws(() => parseProviderModel('openai/gpt-5-5'), /Unsupported model provider: openai/);
});
