import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceTicker } from '../dist/skyd/maintenance-ticker.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

test('maintenance ticker collapses overlapping interval callbacks into one tick', async () => {
  let now = Date.parse('2026-08-10T00:00:01.000Z');
  let intervalCallback;
  let intervalDelay;
  let cleared = false;
  let readinessChecks = 0;
  const readiness = createDeferred();
  const submissions = [];
  const logs = [];
  const ticker = createMaintenanceTicker({
    now: () => now,
    setInterval(callback, delayMs) {
      intervalCallback = callback;
      intervalDelay = delayMs;
      return 'maintenance-interval';
    },
    clearInterval(handle) {
      assert.equal(handle, 'maintenance-interval');
      cleared = true;
    },
    isConfigurationReady() {
      readinessChecks += 1;
      return readiness.promise;
    },
    submitOperation(request) {
      submissions.push(request);
      return {
        ok: true,
        operation: { id: `scheduled-${submissions.length}` },
      };
    },
    logger: {
      log(level, scope, message, context) {
        logs.push({ level, scope, message, context });
      },
    },
  });

  ticker.start();
  assert.equal(intervalDelay, 30_000);
  now += 5 * 60 * 1_000;
  intervalCallback();
  intervalCallback();
  assert.equal(readinessChecks, 1);

  readiness.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submissions, [{ type: 'memory' }]);
  assert.deepEqual(logs, [
    {
      level: 'info',
      scope: 'maintenance',
      message: 'Scheduled memory operation submitted.',
      context: { operationId: 'scheduled-1' },
    },
  ]);

  await ticker.stop();
  assert.equal(cleared, true);
});
