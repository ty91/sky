import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseDirectory = path.join(repositoryRoot, 'dist', 'release');

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

test('standalone package satisfies the release artifact contract', { timeout: 120_000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const archiveName = `sky-${manifest.version}-darwin-arm64.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const archivePath = path.join(releaseDirectory, archiveName);
  const extractedDirectory = await mkdtemp(path.join(os.tmpdir(), 'sky-standalone-package-'));

  try {
    await rm(releaseDirectory, { recursive: true, force: true });
    run('pnpm', ['package:standalone'], { cwd: repositoryRoot });

    assert.deepEqual((await readdir(releaseDirectory)).toSorted(), [archiveName, checksumName]);
    assert.equal(run('/usr/bin/tar', ['-tzf', archivePath]).trim(), 'sky');

    run('/usr/bin/tar', ['-xzf', archivePath, '-C', extractedDirectory]);
    assert.deepEqual(await readdir(extractedDirectory), ['sky']);

    const sky = path.join(extractedDirectory, 'sky');
    const skyStat = await lstat(sky);
    assert.equal(skyStat.isFile(), true);
    assert.equal(skyStat.mode & 0o777, 0o755);
    assert.equal(run(sky, ['--version']).trim(), manifest.version);
    assert.match(run('/usr/bin/file', ['-b', sky]), /^Mach-O 64-bit executable arm64\b/);
    assert.equal(run('/usr/bin/lipo', ['-archs', sky]).trim(), 'arm64');

    const checksum = await readFile(path.join(releaseDirectory, checksumName), 'utf8');
    const [digest, checksummedFile] = checksum.trimEnd().split('  ');
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(checksummedFile, archiveName);
    assert.equal(checksum, `${digest}  ${archiveName}\n`);
    assert.equal(
      run('/usr/bin/shasum', ['-a', '256', '-c', checksumName], { cwd: releaseDirectory }),
      `${archiveName}: OK\n`,
    );
  } finally {
    await rm(extractedDirectory, { recursive: true, force: true });
  }
});
