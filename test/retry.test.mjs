import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffMs, isAbortError, withTimeout } from '../dist/runtime/retry.js';

test('computeBackoffMs applies exponential growth with jitter bounds', () => {
  const low = computeBackoffMs(3, { baseMs: 1000, maxMs: 30000, jitterRatio: 0.2 }, () => 0);
  const high = computeBackoffMs(3, { baseMs: 1000, maxMs: 30000, jitterRatio: 0.2 }, () => 1);

  assert.equal(low, 3200);
  assert.equal(high, 4800);
});

test('computeBackoffMs respects maxMs cap', () => {
  const value = computeBackoffMs(10, { baseMs: 5000, maxMs: 12000, jitterRatio: 0 }, () => 0.5);
  assert.equal(value, 12000);
});

test('withTimeout rejects hung operations with timeout metadata', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, 'Telegram init'),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.code, 'ETIMEDOUT');
      assert.match(error.message, /Telegram init timed out after 10ms/);
      return true;
    },
  );
});

test('withTimeout aborts when signal is cancelled', async () => {
  const controller = new AbortController();
  const promise = withTimeout(new Promise(() => {}), 1000, 'Telegram init', controller.signal);
  controller.abort();

  await assert.rejects(promise, (error) => {
    assert.equal(isAbortError(error), true);
    return true;
  });
});
