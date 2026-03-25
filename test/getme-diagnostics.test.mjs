import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDirectGetMeProbe } from '../dist/telegram/getme-diagnostics.js';

test('formatDirectGetMeProbe renders timing summary', () => {
  const text = formatDirectGetMeProbe({
    ok: true,
    networkFamily: 4,
    statusCode: 200,
    totalMs: 912,
    dnsMs: 3,
    tcpMs: 110,
    tlsMs: 220,
    ttfbMs: 579,
    remoteAddress: '149.154.166.110',
    remoteFamily: 4,
  });

  assert.match(text, /status=200/);
  assert.match(text, /total=912ms/);
  assert.match(text, /dns=3ms/);
  assert.match(text, /remote=149\.154\.166\.110/);
  assert.match(text, /family=4/);
  assert.match(text, /network=ipv4/);
});
