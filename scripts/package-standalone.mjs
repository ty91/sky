import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const target = 'darwin-arm64';
const standaloneDirectory = path.join(repositoryRoot, 'dist', 'standalone', target);
const sky = path.join(standaloneDirectory, 'sky');
const releaseDirectory = path.join(repositoryRoot, 'dist', 'release');
const archiveName = `sky-${manifest.version}-${target}.tar.gz`;
const checksumName = `${archiveName}.sha256`;

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

const skyStat = await lstat(sky);
assert.equal(skyStat.isFile(), true, 'standalone sky must be a file');
assert.equal(skyStat.mode & 0o777, 0o755, 'standalone sky must have executable mode 0755');
assert.equal(run(sky, ['--version']).trim(), manifest.version, 'standalone version must match package version');
assert.match(run('/usr/bin/file', ['-b', sky]), /^Mach-O 64-bit executable arm64\b/);
assert.equal(run('/usr/bin/lipo', ['-archs', sky]).trim(), 'arm64');

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });
run('/usr/bin/tar', ['-czf', archiveName, '-C', standaloneDirectory, 'sky'], {
  cwd: releaseDirectory,
});
const checksum = run('/usr/bin/shasum', ['-a', '256', archiveName], {
  cwd: releaseDirectory,
});
await writeFile(path.join(releaseDirectory, checksumName), checksum);

console.log(`Packaged dist/release/${archiveName}.`);
console.log(`Checksum: dist/release/${checksumName}`);
