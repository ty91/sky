import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectRuntimeRole } from '../dist/runtime-entrypoint.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const { version: packageVersion } = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);

function runNodeEntrypoint(name, args) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, 'dist', `${name}.js`), ...args], {
    encoding: 'utf8',
  });
}

function runSharedEntrypoint(name, args) {
  const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'dist', 'runtime-entrypoint.js')).href;
  const script = [
    `import { runEntrypoint, runSelectedRuntime } from ${JSON.stringify(moduleUrl)};`,
    'await runEntrypoint(() => runSelectedRuntime(process.argv[1], process.argv.slice(2)));',
  ].join('\n');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script, name, ...args],
    { encoding: 'utf8' },
  );
}

test('the shared runtime entrypoint selects an exact role from its invocation basename', () => {
  assert.equal(selectRuntimeRole('/opt/sky/bin/sky'), 'sky');
  assert.equal(selectRuntimeRole('/opt/sky/bin/skyd'), 'skyd');
  assert.throws(
    () => selectRuntimeRole('/opt/sky/bin/sky-copy'),
    /runtime must be invoked as sky or skyd/,
  );
});

test('the shared runtime entrypoint runs both selected roles', () => {
  const sky = runSharedEntrypoint('sky', ['--version']);
  assert.equal(sky.status, 0, sky.stderr);
  assert.equal(sky.stdout.trim(), packageVersion);

  const skyd = runSharedEntrypoint('skyd', ['--help']);
  assert.equal(skyd.status, 0, skyd.stderr);
  assert.match(skyd.stdout, /^Usage: skyd \[options\]/m);
});

test('the Node.js sky wrapper preserves its version and help contract', () => {
  const version = runNodeEntrypoint('index', ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);

  const help = runNodeEntrypoint('index', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: sky \[options\] \[command\]/m);
  assert.match(help.stdout, /^  admin \[options\]/m);
});

test('the Node.js skyd wrapper preserves its version, help, and explicit foreground contract', () => {
  const version = runNodeEntrypoint('skyd', ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);

  const help = runNodeEntrypoint('skyd', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: skyd \[options\]/m);
  assert.match(help.stdout, /^  --foreground /m);

  const implicit = runNodeEntrypoint('skyd', []);
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /skyd must be run explicitly with --foreground/);
});
