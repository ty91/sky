import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const verifyScript = path.join(repositoryRoot, 'scripts', 'verify-release-tag.mjs');
const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

function verify(...args) {
  return execFileSync(process.execPath, [verifyScript, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('release tag must exactly match the package version', () => {
  const tag = `v${manifest.version}`;
  assert.equal(verify('--', tag).trim(), `${tag} matches ${manifest.name}@${manifest.version}.`);
  assert.throws(
    () => verify(`${tag}-mismatch`),
    (error) =>
      error.status === 1 &&
      error.stderr.includes(`does not match package version ${manifest.version}`),
  );
});
