import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveProductVersion } from '../dist/product-version.js';

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

test('the product version seam prefers a build-time literal', () => {
  assert.equal(resolveProductVersion('1.2.3-standalone'), '1.2.3-standalone');
});

test('the product version seam falls back to the Node.js package version', () => {
  assert.equal(resolveProductVersion(undefined), packageVersion);
});
