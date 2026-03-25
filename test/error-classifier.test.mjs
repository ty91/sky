import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTelegramError } from '../dist/telegram/error-classifier.js';

test('classifies network timeout as recoverable', () => {
  const result = classifyTelegramError({
    message: "Network request for 'getUpdates' failed!",
    error: { code: 'ETIMEDOUT' },
  });

  assert.equal(result.kind, 'network_transient');
  assert.equal(result.recoverable, true);
  assert.equal(result.code, 'ETIMEDOUT');
});

test('classifies 429 and extracts retry_after', () => {
  const result = classifyTelegramError({
    error_code: 429,
    parameters: { retry_after: 7 },
  });

  assert.equal(result.kind, 'rate_limit');
  assert.equal(result.recoverable, true);
  assert.equal(result.retryAfterMs, 7000);
});

test('classifies invalid token as non-recoverable auth', () => {
  const result = classifyTelegramError({ error_code: 401, description: 'Unauthorized' });

  assert.equal(result.kind, 'auth');
  assert.equal(result.recoverable, false);
});
