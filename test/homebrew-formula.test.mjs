import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const renderScript = path.join(repositoryRoot, 'scripts', 'render-homebrew-formula.mjs');
const SHA256 = 'd8751ade93f441b1f666c87c4d86154de942d4b6b7946282118537e9154ff8a8';

async function render(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [renderScript, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('rendering pins the release asset that the release workflow uploads', async () => {
  const result = await render(['--sha256', SHA256, '--version', '1.2.3']);
  assert.equal(result.code, 0, result.stderr);

  assert.match(
    result.stdout,
    /url "https:\/\/github\.com\/ty91\/sky\/releases\/download\/v1\.2\.3\/ty91-sky-1\.2\.3\.tgz"/,
  );
  assert.match(result.stdout, new RegExp(`sha256 "${SHA256}"`));
  assert.match(result.stdout, /version "1\.2\.3"/);
  assert.doesNotMatch(result.stdout, /__[A-Z0-9]+__/);
});

test('rendering defaults to the manifest version', async () => {
  const { version } = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const result = await render(['--sha256', SHA256]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`version "${version.replaceAll('.', '\\.')}"`));
});

test('rendering refuses input that would produce an uninstallable formula', async () => {
  const missing = await render([]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--sha256 <hex> is required/);

  const truncated = await render(['--sha256', SHA256.slice(0, 32)]);
  assert.equal(truncated.code, 1);
  assert.match(truncated.stderr, /64 lowercase hex characters/);

  const uppercase = await render(['--sha256', SHA256.toUpperCase()]);
  assert.equal(uppercase.code, 1);

  const badVersion = await render(['--sha256', SHA256, '--version', 'latest']);
  assert.equal(badVersion.code, 1);
  assert.match(badVersion.stderr, /look like a release version/);
});

// These are the parts of the formula the rest of Sky depends on. `sky` and `skyd`
// are a deployment contract: an installed plist records the skyd wrapper path in
// ProgramArguments and has to survive upgrades.
test('the formula keeps the deployment contract Sky relies on', async () => {
  const result = await render(['--sha256', SHA256]);
  assert.equal(result.code, 0, result.stderr);

  assert.match(result.stdout, /\(bin\/"sky"\)\.write_env_script/);
  assert.match(result.stdout, /\(bin\/"skyd"\)\.write_env_script/);
  // node@24 is keg-only, so both wrappers must put it on PATH themselves.
  assert.match(result.stdout, /depends_on "node@24"/);
  assert.equal(result.stdout.match(/Formula\["node@24"\]\.opt_bin/g)?.length, 3);
  assert.match(result.stdout, /depends_on arch: :arm64/);
  // Homebrew ad-hoc re-signing corrupts the darwin-universal clipboard slice,
  // and napi loads it before darwin-arm64, which SIGKILLs the process.
  assert.match(result.stdout, /rm addon unless addon\.include\?\("darwin-arm64"\)/);
  // Sky owns its LaunchAgent; a `service do` block would make brew a second authority.
  assert.doesNotMatch(result.stdout, /service do/);
});
