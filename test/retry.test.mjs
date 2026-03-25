import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffMs } from '../dist/runtime/retry.js';

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
