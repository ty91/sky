import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const installer = path.join(repositoryRoot, 'install.sh');

function checksum(archiveName, releaseDirectory) {
  return execFileSync('/usr/bin/shasum', ['-a', '256', archiveName], {
    cwd: releaseDirectory,
    encoding: 'utf8',
  });
}

function install(homeDirectory, releaseDirectory, version) {
  return spawnSync(
    '/bin/sh',
    [installer, '--version', version, '--artifact-base-url', pathToFileURL(releaseDirectory).href],
    {
      encoding: 'utf8',
      env: {
        HOME: homeDirectory,
        PATH: '/usr/bin:/bin',
        TMPDIR: path.join(homeDirectory, 'tmp'),
      },
    },
  );
}

test('standalone installer verifies and idempotently installs a local release artifact', async () => {
  const version = '9.8.7-test.1';
  const archiveName = `sky-${version}-darwin-arm64.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sky-standalone-install-'));
  const releaseDirectory = path.join(root, 'release');
  const artifactDirectory = path.join(root, 'artifact');
  const cleanHome = path.join(root, 'clean-home');
  const installedHome = path.join(root, 'installed-home');

  try {
    await Promise.all([
      mkdir(releaseDirectory),
      mkdir(artifactDirectory),
      mkdir(path.join(cleanHome, 'tmp'), { recursive: true }),
      mkdir(path.join(installedHome, 'tmp'), { recursive: true }),
    ]);

    const artifactSky = path.join(artifactDirectory, 'sky');
    await writeFile(artifactSky, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    await chmod(artifactSky, 0o755);
    execFileSync('/usr/bin/tar', ['-czf', path.join(releaseDirectory, archiveName), '-C', artifactDirectory, 'sky']);
    await writeFile(path.join(releaseDirectory, checksumName), checksum(archiveName, releaseDirectory));

    await writeFile(path.join(releaseDirectory, checksumName), `${'0'.repeat(64)}  ${archiveName}\n`);
    const rejected = install(cleanHome, releaseDirectory, version);
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stderr, /checksum/i);
    await assert.rejects(access(path.join(cleanHome, '.local', 'bin', 'sky')));
    await assert.rejects(access(path.join(cleanHome, '.local', 'bin', 'skyd')));

    await writeFile(path.join(releaseDirectory, checksumName), checksum(archiveName, releaseDirectory));
    const first = install(installedHome, releaseDirectory, version);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`Installed Sky ${version}`));
    assert.match(first.stderr, /\.local\/bin.*PATH/);

    const installedBin = path.join(installedHome, '.local', 'bin');
    const installedSky = path.join(installedBin, 'sky');
    const installedSkyd = path.join(installedBin, 'skyd');
    const skyStat = await lstat(installedSky);
    assert.equal(skyStat.isFile(), true);
    assert.equal(skyStat.mode & 0o777, 0o755);
    assert.equal(await readlink(installedSkyd), 'sky');
    assert.equal(execFileSync(installedSky, ['--version'], { encoding: 'utf8' }).trim(), version);

    const second = install(installedHome, releaseDirectory, version);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readlink(installedSkyd), 'sky');

    const installedBytes = await readFile(installedSky);
    await writeFile(path.join(releaseDirectory, checksumName), `${'f'.repeat(64)}  ${archiveName}\n`);
    const failedReinstall = install(installedHome, releaseDirectory, version);
    assert.notEqual(failedReinstall.status, 0, failedReinstall.stdout);
    assert.deepEqual(await readFile(installedSky), installedBytes);
    assert.equal(await readlink(installedSkyd), 'sky');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
