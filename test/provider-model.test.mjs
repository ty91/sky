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

test('parseProviderModel accepts openai model strings', () => {
  assert.deepEqual(parseProviderModel('openai/gpt-5.5'), {
    provider: 'openai',
    modelId: 'gpt-5.5',
    raw: 'openai/gpt-5.5',
  });
});

test('parseProviderModel keeps slashes inside the model id', () => {
  assert.equal(parseProviderModel('anthropic/custom/model').modelId, 'custom/model');
  assert.equal(parseProviderModel('openai/custom/model').modelId, 'custom/model');
});

test('parseProviderModel rejects malformed model strings', () => {
  for (const value of ['claude-opus-4-7', '/claude-opus-4-7', 'anthropic/']) {
    assert.throws(() => parseProviderModel(value), /<provider>\/<model>/);
  }
});

test('parseProviderModel rejects unsupported providers', () => {
  assert.throws(() => parseProviderModel('google/gemini-pro'), /Unsupported model provider: google/);
});
